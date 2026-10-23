/**
 * The security headers on every kind of response, and the guarantee that the
 * HTML the client ships needs no inline script or style (a strict CSP would
 * block it and the page would be blank).
 *
 * server/index.js cannot be imported in tests, so this composes the same chain
 * from the same pieces: the headers middleware first, then the body parser, the
 * API routes (makeApp), static files and the single-page fallback.
 * test/securityHeadersBoot.test.js proves the real wiring in index.js.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { makeApp } from "../helpers/makeApp.js";
import { createSecurityHeaders } from "../../lib/securityHeaders.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../../../client");
const sourceHtml = fs.readFileSync(path.join(clientDir, "index.html"), "utf8");
const builtHtmlPath = path.join(clientDir, "dist", "index.html");

/** What a CSP with script-src 'self' and style-src 'self' cannot run, found in an HTML document. */
function inlineCodeIn(html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const found = [];
  for (const match of withoutComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1];
    if (!/\bsrc\s*=/i.test(attrs)) found.push(`inline <script>: ${match[2].trim().slice(0, 60)}`);
    else if (match[2].trim()) found.push("<script src> with a body");
  }
  if (/<style\b/i.test(withoutComments)) found.push("inline <style>");
  for (const match of withoutComments.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=/gi)) found.push(`event handler attribute ${match[1]}`);
  if (/<[a-z][^>]*\sstyle\s*=/i.test(withoutComments)) found.push("style attribute");
  if (/(?:href|src|action)\s*=\s*["']\s*javascript:/i.test(withoutComments)) found.push("javascript: URL");
  return found;
}

describe("the HTML the client ships needs no inline code", () => {
  test("client/index.html (the Vite input) has no inline script, style, handler or style attribute", () => {
    expect(inlineCodeIn(sourceHtml)).toEqual([]);
  });

  test("every classic script in it is a file that exists", () => {
    const scripts = [...sourceHtml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<script\b([^>]*)\bsrc\s*=\s*"([^"]+)"[^>]*>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, src] of scripts) {
      expect(src.startsWith("/"), `${src} is root-relative`).toBe(true);
      if (/type\s*=\s*"module"/i.test(attrs)) {
        expect(fs.existsSync(path.join(clientDir, src)), `${src} (module entry)`).toBe(true);
      } else {
        expect(fs.existsSync(path.join(clientDir, "public", src)), `${src} (classic script in public/)`).toBe(true);
      }
    }
  });

  test("the early theme script is a blocking classic script in <head> (no flash of the wrong theme)", () => {
    const head = sourceHtml.slice(0, sourceHtml.indexOf("</head>"));
    const tag = head.match(/<script\b[^>]*src="\/theme-init\.js"[^>]*>/i)?.[0] || "";
    expect(tag).not.toBe("");
    expect(tag).not.toMatch(/\b(defer|async)\b|type\s*=\s*"module"/i);
  });

  test("the script files and the service worker use no eval, Function constructor or remote import", () => {
    for (const file of ["public/theme-init.js", "public/sw.js"]) {
      const text = fs.readFileSync(path.join(clientDir, file), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(text, file).not.toMatch(/\beval\s*\(/);
      expect(text, file).not.toMatch(/\bnew\s+Function\s*\(/);
      expect(text, file).not.toMatch(/importScripts\s*\(\s*["'`]https?:/);
    }
  });

  test.skipIf(!fs.existsSync(builtHtmlPath))("the built client/dist/index.html has none either", () => {
    expect(inlineCodeIn(fs.readFileSync(builtHtmlPath, "utf8"))).toEqual([]);
  });
});

describe("security headers on every kind of response", () => {
  let dist;
  let app;

  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "aurelle-csp-"));
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(path.join(dist, "index.html"), sourceHtml);
    fs.writeFileSync(path.join(dist, "assets", "app-abc123.js"), "console.log('hi');\n");
    fs.writeFileSync(path.join(dist, "assets", "app-abc123.css"), "body{margin:0}\n");
    fs.copyFileSync(path.join(clientDir, "public", "theme-init.js"), path.join(dist, "theme-init.js"));
    fs.copyFileSync(path.join(clientDir, "public", "sw.js"), path.join(dist, "sw.js"));

    const api = makeApp().app;
    // makeApp's app is mounted as a sub-app here and would add its own X-Powered-By on the way in;
    // in server/index.js there is one app, and the headers middleware runs after Express's own.
    api.disable("x-powered-by");
    app = express();
    app.set("trust proxy", 1);
    app.use(createSecurityHeaders({ env: {}, isProduction: true, logger: { warn() {} } }));
    app.use(express.json({ limit: "1mb" }));
    app.use(api);
    app.get("/api/boom", () => {
      throw new Error("boom");
    });
    app.use(express.static(dist, { index: false }));
    app.get("*path", (req, res) => res.sendFile(path.join(dist, "index.html")));
    // No custom error handler: like server/index.js, errors end in Express's own final handler.
  });

  afterAll(() => {
    fs.rmSync(dist, { recursive: true, force: true });
  });

  // Express's own error pages (404, 400, 413, 500 without a handler) carry their own, stricter
  // "default-src 'none'" policy: it replaces ours on that response, and everything else stays.
  const expectHeaders = (res, { errorPage = false } = {}) => {
    const csp = res.headers["content-security-policy"];
    expect(csp, "Content-Security-Policy").toBeTruthy();
    if (errorPage) {
      expect(csp).toBe("default-src 'none'");
    } else {
      expect(csp).toContain("script-src 'self';");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    }
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["permissions-policy"]).toContain("camera=(self)");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  };

  test("the HTML page", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expectHeaders(res);
    expect(inlineCodeIn(res.text)).toEqual([]);
  });

  test("the HTML page on a client route (the single-page fallback)", async () => {
    const res = await request(app).get("/chat/some-chat");
    expect(res.status).toBe(200);
    expectHeaders(res);
    expect(inlineCodeIn(res.text)).toEqual([]);
  });

  test("an API response", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expectHeaders(res);
  });

  test("static assets: script, stylesheet, the theme script and the service worker", async () => {
    for (const url of ["/assets/app-abc123.js", "/assets/app-abc123.css", "/theme-init.js", "/sw.js"]) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      expectHeaders(res);
    }
    expect((await request(app).get("/theme-init.js")).headers["content-type"]).toMatch(/javascript/);
  });

  test("a missing static file under /assets falls back to the page and still has the headers", async () => {
    const res = await request(app).get("/assets/missing.js");
    expectHeaders(res);
  });

  test("a 400 from the body parser (malformed JSON), which happens before any route", async () => {
    const res = await request(app).post("/api/login").set("Content-Type", "application/json").send("{not json");
    expect(res.status).toBe(400);
    expectHeaders(res, { errorPage: true });
  });

  test("a 413 from the body parser (body over the limit)", async () => {
    const res = await request(app)
      .post("/api/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ blob: "x".repeat(1024 * 1024 + 10) }));
    expect(res.status).toBe(413);
    expectHeaders(res, { errorPage: true });
  });

  test("a 404 for an unknown method and path", async () => {
    const res = await request(app).delete("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expectHeaders(res, { errorPage: true });
  });

  test("a 500 from a crashing route", async () => {
    const res = await request(app).get("/api/boom");
    expect(res.status).toBe(500);
    expectHeaders(res, { errorPage: true });
  });

  test("a HEAD request and a conditional request (304) keep the headers", async () => {
    const head = await request(app).head("/");
    expectHeaders(head);
    const first = await request(app).get("/assets/app-abc123.js");
    const second = await request(app).get("/assets/app-abc123.js").set("If-None-Match", first.headers.etag);
    expect(second.status).toBe(304);
    expectHeaders(second);
  });

  test("HSTS and upgrade-insecure-requests appear only when the request came over HTTPS", async () => {
    const plain = await request(app).get("/");
    expect(plain.headers["strict-transport-security"]).toBeUndefined();
    expect(plain.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");

    const secure = await request(app).get("/").set("X-Forwarded-Proto", "https");
    expect(secure.headers["strict-transport-security"]).toBe("max-age=15552000");
    expect(secure.headers["content-security-policy"]).toContain("upgrade-insecure-requests");
  });
});

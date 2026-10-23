/**
 * The real server/index.js, started in production mode, answers with the
 * security headers on every kind of response, and CSP_MODE / CSP_EXTRA_SOURCES /
 * the storage settings reach the header. (The pieces are unit-tested in
 * test/lib/securityHeaders.test.js; this proves they are wired in.)
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = path.resolve(serverDir, "..", "client");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function get(port, urlPath, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function bootServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurelle-csp-data-"));
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aurelle-csp-dist-"));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.copyFileSync(path.join(clientDir, "index.html"), path.join(dist, "index.html"));
  fs.copyFileSync(path.join(clientDir, "public", "theme-init.js"), path.join(dist, "theme-init.js"));
  fs.writeFileSync(path.join(dist, "assets", "app-test.js"), "export {};\n");

  const port = await freePort();
  const child = spawn(process.execPath, ["index.js"], {
    cwd: serverDir,
    env: {
      ...process.env,
      APP_ENV: "production",
      PORT: String(port),
      SERVER_PORT: String(port),
      BIND_ADDRESS: "127.0.0.1",
      DATA_DIR: dataDir,
      CLIENT_DIST_DIR: dist,
      FILE_UPLOAD_TRANSCODE_VIDEOS: "false", // no media worker child process for this test
      CSP_MODE: "",
      CSP_EXTRA_SOURCES: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));

  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${log}`);
    try {
      const res = await get(port, "/api/health");
      if (res.status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`server did not start in time:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 4000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(dist, { recursive: true, force: true });
  };
  return { port, stop, log: () => log };
}

describe("server/index.js in production: default settings", () => {
  let server;
  beforeAll(async () => {
    server = await bootServer();
  }, 40_000);
  afterAll(async () => {
    await server?.stop();
  });

  const expectStrictHeaders = (res) => {
    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(res.headers["content-security-policy-report-only"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["permissions-policy"]).toContain("geolocation=()");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  };

  test("the HTML page has the headers and the served markup has no inline script or style", async () => {
    const res = await get(server.port, "/");
    expect(res.status).toBe(200);
    expectStrictHeaders(res);
    const html = res.text.replace(/<!--[\s\S]*?-->/g, "");
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).toContain('src="/theme-init.js"');
    // The policy allows this page's own host for the WebSocket.
    expect(res.headers["content-security-policy"]).toContain(`ws://127.0.0.1:${server.port}`);
  });

  test("an API response, a static asset, the theme script, an unknown path", async () => {
    for (const url of ["/api/health", "/assets/app-test.js", "/theme-init.js", "/chat/anything"]) {
      const res = await get(server.port, url);
      expect(res.status, url).toBe(200);
      expectStrictHeaders(res);
    }
  });

  test("error responses: malformed JSON (400) and an unknown API method (404)", async () => {
    const bad = await get(server.port, "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(bad.status).toBe(400);
    expect(bad.headers["content-security-policy"]).toBeTruthy();
    expect(bad.headers["x-content-type-options"]).toBe("nosniff");
    expect(bad.headers["x-frame-options"]).toBe("DENY");
    expect(bad.headers["permissions-policy"]).toBeTruthy();

    const missing = await get(server.port, "/api/nothing-here", { method: "DELETE" });
    expect(missing.headers["content-security-policy"]).toBeTruthy();
    expect(missing.headers["x-frame-options"]).toBe("DENY");
  });

  test("HSTS and upgrade-insecure-requests only when the proxy says the request was HTTPS", async () => {
    const plain = await get(server.port, "/");
    expect(plain.headers["strict-transport-security"]).toBeUndefined();
    expect(plain.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");

    const secure = await get(server.port, "/", { headers: { "X-Forwarded-Proto": "https", Host: "chat.example.com" } });
    expect(secure.headers["strict-transport-security"]).toBe("max-age=15552000");
    expect(secure.headers["content-security-policy"]).toContain("upgrade-insecure-requests");
    expect(secure.headers["content-security-policy"]).toContain("wss://chat.example.com");
  });
});

describe("server/index.js in production: CSP_MODE and extra sources", () => {
  test("CSP_MODE=report-only moves the policy to the report-only header", async () => {
    const server = await bootServer({ CSP_MODE: "report-only" });
    try {
      const res = await get(server.port, "/");
      expect(res.headers["content-security-policy"]).toBeUndefined();
      expect(res.headers["content-security-policy-report-only"]).toContain("script-src 'self';");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(server.log()).toContain("Content-Security-Policy mode: report-only");
    } finally {
      await server.stop();
    }
  }, 40_000);

  test("CSP_MODE=off sends no CSP; the other headers stay", async () => {
    const server = await bootServer({ CSP_MODE: "off" });
    try {
      const res = await get(server.port, "/");
      expect(res.headers["content-security-policy"]).toBeUndefined();
      expect(res.headers["content-security-policy-report-only"]).toBeUndefined();
      expect(res.headers["x-frame-options"]).toBe("DENY");
    } finally {
      await server.stop();
    }
  }, 40_000);

  test("CSP_EXTRA_SOURCES and the object-storage settings reach img/media/connect-src; bad entries are dropped with a warning", async () => {
    const server = await bootServer({
      CSP_EXTRA_SOURCES: "https://cdn.example.com,https://evil.example.com; script-src *",
      STORAGE_DRIVER: "remote",
      STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      STORAGE_BUCKET: "media",
      STORAGE_ACCESS_KEY_ID: "k",
      STORAGE_SECRET_ACCESS_KEY: "s",
      STORAGE_PUBLIC_URL: "https://media.example.com",
    });
    try {
      const res = await get(server.port, "/");
      const csp = res.headers["content-security-policy"];
      const directive = (name) => csp.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${name} `)) || "";
      for (const name of ["img-src", "media-src", "connect-src"]) {
        expect(directive(name), name).toContain("https://cdn.example.com");
        expect(directive(name), name).toContain("https://media.example.com");
        expect(directive(name), name).toContain("https://acct.r2.cloudflarestorage.com");
      }
      expect(csp).not.toContain("evil.example.com");
      expect(directive("script-src")).toBe("script-src 'self'");
      expect(server.log()).toContain("CSP_EXTRA_SOURCES");
    } finally {
      await server.stop();
    }
  }, 40_000);
});

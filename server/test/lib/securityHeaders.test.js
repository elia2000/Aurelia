import { describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  CSP_MODES,
  HSTS_MAX_AGE_SECONDS,
  PERMISSIONS_POLICY,
  UPDATE_CHECK_ORIGIN,
  buildContentSecurityPolicy,
  createSecurityHeaders,
  deriveStorageSources,
  isHttpsRequest,
  isValidExtraSource,
  parseExtraSources,
  resolveCspMode,
  safeHost,
} from "../../lib/securityHeaders.js";

/** Splits a policy into { directive: [sources] } so assertions do not depend on order. */
function parsePolicy(policy) {
  const map = {};
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map[name] = values;
  }
  return map;
}

const quietLogger = () => ({ warn: vi.fn(), log: vi.fn() });

describe("resolveCspMode", () => {
  test("defaults to enforce in production and off elsewhere", () => {
    expect(resolveCspMode("", { isProduction: true })).toEqual({ mode: "enforce", invalid: false });
    expect(resolveCspMode(undefined, { isProduction: true })).toEqual({ mode: "enforce", invalid: false });
    expect(resolveCspMode("", { isProduction: false })).toEqual({ mode: "off", invalid: false });
  });

  test.each(CSP_MODES)("accepts %s", (mode) => {
    expect(resolveCspMode(mode, { isProduction: true }).mode).toBe(mode);
    expect(resolveCspMode(mode, { isProduction: false }).mode).toBe(mode);
  });

  test("is forgiving about case, spaces and underscores", () => {
    expect(resolveCspMode("  Report_Only ", { isProduction: true })).toEqual({ mode: "report-only", invalid: false });
    expect(resolveCspMode("ENFORCE", { isProduction: false }).mode).toBe("enforce");
  });

  test("an unknown value falls back to the default and is flagged", () => {
    expect(resolveCspMode("strict", { isProduction: true })).toEqual({ mode: "enforce", invalid: true });
    expect(resolveCspMode("strict", { isProduction: false })).toEqual({ mode: "off", invalid: true });
  });
});

describe("parseExtraSources", () => {
  test("accepts comma-separated origins, trims, lower-cases and removes duplicates", () => {
    const { sources, rejected } = parseExtraSources(
      " https://CDN.example.com ,https://media.example.com:8443, https://*.r2.dev,https://cdn.example.com ,wss://rt.example.com, http://127.0.0.1:9000, https://[::1]:9000",
    );
    expect(rejected).toEqual([]);
    expect(sources).toEqual([
      "https://cdn.example.com",
      "https://media.example.com:8443",
      "https://*.r2.dev",
      "wss://rt.example.com",
      "http://127.0.0.1:9000",
      "https://[::1]:9000",
    ]);
  });

  test("an empty value is no sources and no error", () => {
    expect(parseExtraSources("")).toEqual({ sources: [], rejected: [] });
    expect(parseExtraSources(undefined)).toEqual({ sources: [], rejected: [] });
    expect(parseExtraSources(" , ,")).toEqual({ sources: [], rejected: [] });
  });

  test.each([
    ["a semicolon (would start a new directive)", "https://a.example.com; script-src *"],
    ["a space inside an entry", "https://a.example.com https://b.example.com"],
    ["a newline", "https://a.example.com\nscript-src *"],
    ["a carriage return", "https://a.example.com\rX-Evil: 1"],
    ["a tab", "https://a.example.com\t'unsafe-inline'"],
    ["a quote (a CSP keyword)", "'unsafe-inline'"],
    ["a double quote", 'https://a.example.com"'],
    ["a bare wildcard", "*"],
    ["a bare scheme", "https:"],
    ["data:", "data:"],
    ["blob:", "blob:"],
    ["a scheme-less host", "cdn.example.com"],
    ["a path", "https://cdn.example.com/media/"],
    ["a wildcard that is not a leading label", "https://cdn.*.example.com"],
    ["a user-info part", "https://user@cdn.example.com"],
    ["a space before a keyword", "https://a.example.com 'self'"],
    ["a non-web scheme", "ftp://cdn.example.com"],
    ["a javascript: URL", "javascript:alert(1)"],
  ])("rejects %s", (_label, value) => {
    const { sources, rejected } = parseExtraSources(value);
    expect(sources).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  test("a bad entry does not take its good neighbours down with it", () => {
    const { sources, rejected } = parseExtraSources("https://ok.example.com,https://bad.example.com; img-src *,https://ok2.example.com");
    expect(sources).toEqual(["https://ok.example.com", "https://ok2.example.com"]);
    expect(rejected).toEqual(["https://bad.example.com; img-src *"]);
  });

  test("isValidExtraSource only accepts strings", () => {
    expect(isValidExtraSource(undefined)).toBe(false);
    expect(isValidExtraSource(42)).toBe(false);
    expect(isValidExtraSource("https://a.example.com")).toBe(true);
  });
});

describe("deriveStorageSources", () => {
  test("is empty for local storage, whatever else is set", () => {
    expect(deriveStorageSources({})).toEqual([]);
    expect(deriveStorageSources({ STORAGE_DRIVER: "local", STORAGE_ENDPOINT: "https://s3.example.com" })).toEqual([]);
  });

  test("a path-style endpoint contributes its origin only", () => {
    expect(
      deriveStorageSources({
        STORAGE_DRIVER: "remote",
        STORAGE_ENDPOINT: "https://abc123.r2.cloudflarestorage.com/",
        STORAGE_BUCKET: "media",
        STORAGE_FORCE_PATH_STYLE: "true",
      }),
    ).toEqual(["https://abc123.r2.cloudflarestorage.com"]);
  });

  test("path style is the default", () => {
    expect(
      deriveStorageSources({ STORAGE_DRIVER: "remote", STORAGE_ENDPOINT: "https://s3.example.com", STORAGE_BUCKET: "b" }),
    ).toEqual(["https://s3.example.com"]);
  });

  test("virtual-hosted style adds the bucket sub-domain", () => {
    expect(
      deriveStorageSources({
        STORAGE_DRIVER: "s3",
        STORAGE_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
        STORAGE_BUCKET: "my-bucket",
        STORAGE_FORCE_PATH_STYLE: "false",
      }),
    ).toEqual(["https://s3.us-east-1.amazonaws.com", "https://my-bucket.s3.us-east-1.amazonaws.com"]);
  });

  test("STORAGE_PUBLIC_URL (a CDN) is listed first and reduced to its origin", () => {
    expect(
      deriveStorageSources({
        STORAGE_DRIVER: "remote",
        STORAGE_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
        STORAGE_PUBLIC_URL: "https://media.example.com/some/prefix/",
      }),
    ).toEqual(["https://media.example.com", "https://abc.r2.cloudflarestorage.com"]);
  });

  test("without an endpoint the AWS regional hosts are used", () => {
    expect(
      deriveStorageSources({
        STORAGE_DRIVER: "remote",
        STORAGE_BUCKET: "b",
        STORAGE_REGION: "eu-west-1",
        STORAGE_FORCE_PATH_STYLE: "false",
      }),
    ).toEqual(["https://s3.eu-west-1.amazonaws.com", "https://b.s3.eu-west-1.amazonaws.com"]);
    expect(deriveStorageSources({ STORAGE_DRIVER: "remote", STORAGE_BUCKET: "b", STORAGE_REGION: "auto" })).toEqual([]);
  });

  test("garbage in the variables never reaches the policy", () => {
    expect(
      deriveStorageSources({
        STORAGE_DRIVER: "remote",
        STORAGE_ENDPOINT: "not a url; script-src *",
        STORAGE_PUBLIC_URL: "javascript:alert(1)",
        STORAGE_BUCKET: "b; x",
      }),
    ).toEqual([]);
  });
});

describe("buildContentSecurityPolicy", () => {
  const policy = parsePolicy(buildContentSecurityPolicy());

  test("every directive of the strict policy is present with its value", () => {
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["script-src"]).toEqual(["'self'"]);
    expect(policy["script-src-attr"]).toEqual(["'none'"]);
    expect(policy["style-src"]).toEqual(["'self'"]);
    expect(policy["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(policy["media-src"]).toEqual(["'self'", "blob:"]);
    expect(policy["font-src"]).toEqual(["'self'"]);
    expect(policy["connect-src"]).toEqual(["'self'", UPDATE_CHECK_ORIGIN]);
    expect(policy["worker-src"]).toEqual(["'self'"]);
    expect(policy["manifest-src"]).toEqual(["'self'"]);
    expect(policy["frame-src"]).toEqual(["'none'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'none'"]);
    expect(policy["form-action"]).toEqual(["'self'"]);
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
  });

  test("allows no inline script, no eval and no wildcard anywhere", () => {
    const text = buildContentSecurityPolicy({
      https: true,
      host: "chat.example.com",
      extraSources: ["https://cdn.example.com"],
    });
    expect(text).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic|wasm-unsafe-eval/);
    expect(text).not.toMatch(/(^|[\s;])\*(\s|;|$)/);
    // The only way into style is the stylesheet file; into script, the script files.
    expect(parsePolicy(text)["script-src"]).toEqual(["'self'"]);
    expect(parsePolicy(text)["style-src"]).toEqual(["'self'"]);
  });

  test("an HTTP request gets ws:// for its host and no upgrade-insecure-requests", () => {
    const text = buildContentSecurityPolicy({ https: false, host: "localhost:5174" });
    expect(parsePolicy(text)["connect-src"]).toContain("ws://localhost:5174");
    expect(parsePolicy(text)["connect-src"]).not.toContain("wss://localhost:5174");
    expect(text).not.toContain("upgrade-insecure-requests");
  });

  test("an HTTPS request gets wss:// for its host and upgrade-insecure-requests", () => {
    const text = buildContentSecurityPolicy({ https: true, host: "chat.example.com" });
    const parsed = parsePolicy(text);
    expect(parsed["connect-src"]).toContain("wss://chat.example.com");
    expect(parsed["connect-src"]).not.toContain("ws://chat.example.com");
    expect(parsed).toHaveProperty("upgrade-insecure-requests");
    expect(parsed["upgrade-insecure-requests"]).toEqual([]);
  });

  test("a report-only policy leaves out upgrade-insecure-requests (browsers ignore it there)", () => {
    const text = buildContentSecurityPolicy({ https: true, host: "chat.example.com", reportOnly: true });
    expect(text).not.toContain("upgrade-insecure-requests");
    expect(text).toContain("frame-ancestors 'none'");
  });

  test("extra sources go to img-src, media-src and connect-src only", () => {
    const parsed = parsePolicy(
      buildContentSecurityPolicy({ extraSources: ["https://cdn.example.com", "https://*.r2.dev"] }),
    );
    for (const name of ["img-src", "media-src", "connect-src"]) {
      expect(parsed[name]).toEqual(expect.arrayContaining(["https://cdn.example.com", "https://*.r2.dev"]));
    }
    for (const name of ["default-src", "script-src", "style-src", "font-src", "worker-src", "frame-src", "form-action", "manifest-src"]) {
      expect(parsed[name]).not.toContain("https://cdn.example.com");
    }
  });

  test("an invalid extra source is dropped even if a caller forgot to validate it", () => {
    const text = buildContentSecurityPolicy({
      extraSources: ["https://ok.example.com", "https://x.example.com; script-src *", "'unsafe-inline'"],
    });
    expect(text).toContain("https://ok.example.com");
    expect(text).not.toContain("x.example.com");
    expect(text).not.toContain("unsafe-inline");
    expect(parsePolicy(text)["script-src"]).toEqual(["'self'"]);
  });

  test("a Host header with odd characters is not echoed into the policy", () => {
    expect(safeHost({ headers: { host: "chat.example.com:8443" } })).toBe("chat.example.com:8443");
    expect(safeHost({ headers: { host: "[::1]:5174" } })).toBe("[::1]:5174");
    expect(safeHost({ headers: { host: "evil.com; script-src *" } })).toBe("");
    expect(safeHost({ headers: { host: "a b" } })).toBe("");
    expect(safeHost({ headers: {} })).toBe("");
  });
});

describe("isHttpsRequest", () => {
  test("is true for a TLS request or a proxy that says so", () => {
    expect(isHttpsRequest({ secure: true, headers: {} })).toBe(true);
    expect(isHttpsRequest({ secure: false, headers: { "x-forwarded-proto": "https" } })).toBe(true);
    expect(isHttpsRequest({ secure: false, headers: { "x-forwarded-proto": "HTTPS, http" } })).toBe(true);
  });

  test("is false otherwise", () => {
    expect(isHttpsRequest({ secure: false, headers: {} })).toBe(false);
    expect(isHttpsRequest({ secure: false, headers: { "x-forwarded-proto": "http" } })).toBe(false);
    expect(isHttpsRequest(undefined)).toBe(false);
  });
});

describe("PERMISSIONS_POLICY", () => {
  const entries = Object.fromEntries(PERMISSIONS_POLICY.split(", ").map((item) => item.split("=")));

  test("allows what the app uses, for the page itself only", () => {
    for (const feature of ["camera", "microphone", "display-capture", "picture-in-picture", "fullscreen", "autoplay", "screen-wake-lock"]) {
      expect(entries[feature], feature).toBe("(self)");
    }
  });

  test("denies what it never uses", () => {
    for (const feature of ["geolocation", "payment", "usb", "serial", "hid", "midi", "accelerometer", "gyroscope", "magnetometer", "xr-spatial-tracking", "browsing-topics", "idle-detection"]) {
      expect(entries[feature], feature).toBe("()");
    }
  });
});

describe("createSecurityHeaders middleware", () => {
  function appWith(options) {
    const app = express();
    app.set("trust proxy", 1);
    const middleware = createSecurityHeaders({ logger: quietLogger(), ...options });
    app.use(middleware);
    app.get("/ping", (req, res) => res.json({ ok: true }));
    return { app, middleware };
  }

  test("production default: enforced CSP plus the other headers, no HSTS on plain HTTP", async () => {
    const { app } = appWith({ env: {}, isProduction: true });
    const res = await request(app).get("/ping");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy-report-only"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["permissions-policy"]).toBe(PERMISSIONS_POLICY);
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  });

  test("HSTS (180 days, no preload, no subdomains) and upgrade-insecure-requests only behind HTTPS", async () => {
    const { app } = appWith({ env: {}, isProduction: true });
    const res = await request(app).get("/ping").set("Host", "chat.example.com").set("X-Forwarded-Proto", "https");
    expect(res.headers["strict-transport-security"]).toBe(`max-age=${HSTS_MAX_AGE_SECONDS}`);
    expect(HSTS_MAX_AGE_SECONDS).toBe(15552000);
    expect(res.headers["strict-transport-security"]).not.toMatch(/preload|includeSubDomains/i);
    const csp = parsePolicy(res.headers["content-security-policy"]);
    expect(csp).toHaveProperty("upgrade-insecure-requests");
    expect(csp["connect-src"]).toContain("wss://chat.example.com");
  });

  test("an X-Forwarded-Proto: http request is treated as plain HTTP", async () => {
    const { app } = appWith({ env: {}, isProduction: true });
    const res = await request(app).get("/ping").set("X-Forwarded-Proto", "http");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  });

  test("CSP_MODE=report-only sends the policy under the report-only header and never enforces it", async () => {
    const { app } = appWith({ env: { CSP_MODE: "report-only" }, isProduction: true });
    const res = await request(app).get("/ping").set("X-Forwarded-Proto", "https");
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["content-security-policy-report-only"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy-report-only"]).not.toContain("upgrade-insecure-requests");
    // The non-CSP headers do not depend on the mode.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeDefined();
  });

  test("CSP_MODE=off sends no CSP at all but keeps the other headers", async () => {
    const { app } = appWith({ env: { CSP_MODE: "off" }, isProduction: true });
    const res = await request(app).get("/ping");
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["content-security-policy-report-only"]).toBeUndefined();
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["permissions-policy"]).toBeDefined();
  });

  test("outside production the CSP is off unless CSP_MODE asks for it", async () => {
    const dev = appWith({ env: {}, isProduction: false });
    expect(dev.middleware.config.mode).toBe("off");
    const res = await request(dev.app).get("/ping");
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");

    const forced = appWith({ env: { CSP_MODE: "enforce" }, isProduction: false });
    expect((await request(forced.app).get("/ping")).headers["content-security-policy"]).toBeDefined();
  });

  test("an unknown CSP_MODE warns and falls back to the default", () => {
    const logger = quietLogger();
    const middleware = createSecurityHeaders({ env: { CSP_MODE: "banana" }, isProduction: true, logger });
    expect(middleware.config.mode).toBe("enforce");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("CSP_MODE");
  });

  test("CSP_EXTRA_SOURCES and the storage settings reach the policy; bad entries warn and are dropped", async () => {
    const logger = quietLogger();
    const { app, middleware } = appWith({
      env: {
        CSP_EXTRA_SOURCES: "https://cdn.example.com, https://evil.example.com; script-src *",
        STORAGE_DRIVER: "remote",
        STORAGE_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
        STORAGE_PUBLIC_URL: "https://media.example.com",
      },
      isProduction: true,
      logger,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/CSP_EXTRA_SOURCES/);

    expect(middleware.config.storageSources).toEqual(["https://media.example.com", "https://abc.r2.cloudflarestorage.com"]);
    const res = await request(app).get("/ping");
    const csp = parsePolicy(res.headers["content-security-policy"]);
    for (const name of ["img-src", "media-src", "connect-src"]) {
      expect(csp[name]).toEqual(
        expect.arrayContaining(["https://cdn.example.com", "https://media.example.com", "https://abc.r2.cloudflarestorage.com"]),
      );
    }
    expect(res.headers["content-security-policy"]).not.toContain("evil.example.com");
    expect(csp["script-src"]).toEqual(["'self'"]);
  });

  test("the header value is one line (no header splitting through a Host header)", async () => {
    const { app } = appWith({ env: {}, isProduction: true });
    const res = await request(app).get("/ping").set("Host", "chat.example.com");
    expect(res.headers["content-security-policy"]).not.toMatch(/[\r\n]/);
  });
});

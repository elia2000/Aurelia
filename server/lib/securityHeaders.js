/**
 * securityHeaders.js
 *
 * The browser-facing security headers, set by the Express app itself so that
 * every deployment (Docker, manual, installer + nginx, Railway, ...) gets the
 * same protection and nothing depends on a reverse-proxy config.
 *
 * Always sent: X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
 * Cross-Origin-Resource-Policy, Cross-Origin-Opener-Policy, Permissions-Policy.
 * Only on an HTTPS request: Strict-Transport-Security (and the CSP
 * `upgrade-insecure-requests` directive).
 * The Content-Security-Policy depends on CSP_MODE:
 *   enforce      the policy is enforced (default in production)
 *   report-only  violations are only logged in the browser console
 *   off          no CSP header (default outside production)
 *
 * Why the policy looks the way it does (docs/Security-Headers.md has the long
 * version):
 *  - script-src 'self': the client has no inline script (the early theme script
 *    is /theme-init.js) and no eval; there is no 'unsafe-inline' and no hash.
 *  - style-src 'self': the CSS is one built file and React sets `style={{}}`
 *    through the CSSOM (element.style.x = ...), which CSP does not govern, so
 *    neither 'unsafe-inline' nor style-src-attr 'unsafe-inline' is needed.
 *  - img/media/connect-src also list the object-storage origins (derived from
 *    STORAGE_*) and CSP_EXTRA_SOURCES, because the browser downloads and
 *    uploads (presigned PUT) straight from the bucket or CDN.
 *  - connect-src carries https://api.github.com for exactly one thing: the
 *    admin panel's "Check for updates" button, which asks GitHub for the
 *    newest release tag from the administrator's own browser.
 */

export const CSP_MODES = Object.freeze(["enforce", "report-only", "off"]);

/** HSTS lifetime: 180 days. No includeSubDomains and no preload: those are the operator's call. */
export const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/** The one third-party origin the client talks to (admin "Check for updates"). */
export const UPDATE_CHECK_ORIGIN = "https://api.github.com";

/**
 * Features the app uses are allowed for the page itself; features it never uses
 * are switched off. Only names that browsers recognise are listed (an unknown
 * name makes Chrome log a console warning).
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=(self)",
  "browsing-topics=()",
  "camera=(self)",
  "display-capture=(self)",
  "fullscreen=(self)",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "magnetometer=()",
  "microphone=(self)",
  "midi=()",
  "payment=()",
  "picture-in-picture=(self)",
  "screen-wake-lock=(self)",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

// ─── CSP_MODE ────────────────────────────────────────────────────────────────

/**
 * @param {unknown} raw          value of CSP_MODE (may be empty)
 * @param {{isProduction: boolean}} options
 * @returns {{mode: "enforce"|"report-only"|"off", invalid: boolean}}
 */
export function resolveCspMode(raw, { isProduction }) {
  const fallback = isProduction ? "enforce" : "off";
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!value) return { mode: fallback, invalid: false };
  if (CSP_MODES.includes(value)) return { mode: value, invalid: false };
  return { mode: fallback, invalid: true };
}

// ─── CSP_EXTRA_SOURCES ───────────────────────────────────────────────────────

// scheme://host[:port], host may start with "*." (one wildcard label), IPv6 in brackets.
const SOURCE_PATTERN =
  /^(?:https?|wss?):\/\/(?:\*\.)?(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(?:\d{1,5}|\*))?$/i;

/** True when `value` is a plain origin-style CSP source that cannot change the policy's structure. */
export function isValidExtraSource(value) {
  return typeof value === "string" && value.length <= 253 && SOURCE_PATTERN.test(value);
}

/**
 * Parses CSP_EXTRA_SOURCES: a comma-separated list of origins such as
 * `https://cdn.example.com, https://*.r2.dev`. Every entry is validated on its
 * own; an entry with a space, a semicolon, a quote, a newline, a bare scheme
 * (`https:`), `*` or anything else that is not `scheme://host[:port]` is
 * rejected, never passed on (it could add a directive or a keyword such as
 * 'unsafe-inline' to the header).
 *
 * @param {unknown} raw
 * @returns {{sources: string[], rejected: string[]}}
 */
export function parseExtraSources(raw) {
  const sources = [];
  const rejected = [];
  const text = String(raw ?? "");
  if (!text.trim()) return { sources, rejected };
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    if (!isValidExtraSource(entry)) {
      rejected.push(entry.length > 120 ? `${entry.slice(0, 117)}...` : entry);
      continue;
    }
    // Keep the entry as written, except that the scheme and host are lower case.
    const normalized = entry.toLowerCase();
    if (!sources.includes(normalized)) sources.push(normalized);
  }
  return { sources, rejected };
}

// ─── Object storage origins ──────────────────────────────────────────────────

function originOf(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

/**
 * The origins the browser talks to when STORAGE_DRIVER=remote: the bucket (or
 * its virtual-hosted form) for presigned uploads and downloads, and
 * STORAGE_PUBLIC_URL (a CDN or custom domain) for public downloads.
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
export function deriveStorageSources(env = process.env) {
  const driver = String(env.STORAGE_DRIVER || "local").trim().toLowerCase();
  if (driver !== "remote" && driver !== "s3") return [];

  const out = [];
  const add = (origin) => {
    if (origin && !out.includes(origin)) out.push(origin);
  };

  add(originOf(env.STORAGE_PUBLIC_URL));

  const bucket = String(env.STORAGE_BUCKET || "").trim();
  // The same rule as RemoteStorageProvider: path-style unless explicitly not "true".
  const rawStyle = env.STORAGE_FORCE_PATH_STYLE;
  const pathStyle = rawStyle === undefined ? true : String(rawStyle) === "true";

  const endpoint = originOf(env.STORAGE_ENDPOINT);
  if (endpoint) {
    add(endpoint);
    if (!pathStyle && bucket) {
      const url = new URL(endpoint);
      add(`${url.protocol}//${bucket}.${url.host}`);
    }
  } else if (bucket) {
    // No endpoint: the AWS SDK default for the region.
    const region = String(env.STORAGE_REGION || "").trim();
    if (region && region !== "auto" && /^[a-z0-9-]+$/i.test(region)) {
      add(`https://s3.${region}.amazonaws.com`);
      if (!pathStyle) add(`https://${bucket}.s3.${region}.amazonaws.com`);
    }
  }
  return out.filter(isValidExtraSource);
}

// ─── Request helpers ─────────────────────────────────────────────────────────

/** Same rule as the session cookie code: a TLS request, or a proxy that says so. */
export function isHttpsRequest(req) {
  if (!req) return false;
  if (req.secure) return true;
  const proto = String(req.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return proto === "https";
}

const HOST_PATTERN = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::\d{1,5})?$/i;

/** The Host header when it is a plain host[:port]; otherwise "" (the policy then relies on 'self'). */
export function safeHost(req) {
  const host = String(req?.headers?.host || "").trim();
  return host && host.length <= 260 && HOST_PATTERN.test(host) ? host : "";
}

// ─── The policy ──────────────────────────────────────────────────────────────

/**
 * Builds the Content-Security-Policy header value.
 *
 * @param {object} [options]
 * @param {boolean} [options.https]       the request is HTTPS (adds wss:// for this host and upgrade-insecure-requests)
 * @param {string}  [options.host]        validated Host header, for the explicit ws/wss source (older Safari)
 * @param {string[]} [options.extraSources] origins for img-src, media-src and connect-src (already validated)
 * @param {boolean} [options.reportOnly]  the policy goes into Content-Security-Policy-Report-Only
 * @returns {string}
 */
export function buildContentSecurityPolicy({ https = false, host = "", extraSources = [], reportOnly = false } = {}) {
  const extras = extraSources.filter(isValidExtraSource);
  const connect = ["'self'"];
  if (host) connect.push(`${https ? "wss" : "ws"}://${host}`);
  connect.push(UPDATE_CHECK_ORIGIN, ...extras);

  const directives = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["script-src-attr", ["'none'"]],
    ["style-src", ["'self'"]],
    ["img-src", ["'self'", "data:", "blob:", ...extras]],
    ["media-src", ["'self'", "blob:", ...extras]],
    ["font-src", ["'self'"]],
    ["connect-src", connect],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["frame-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  // Ignored (with a console warning) in a report-only policy, so left out there.
  if (https && !reportOnly) directives.push(["upgrade-insecure-requests", []]);

  return directives
    .map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name))
    .join("; ");
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]  defaults to process.env
 * @param {boolean} [options.isProduction]
 * @param {{warn: Function, log?: Function}} [options.logger]
 * @returns {import("express").RequestHandler & {config: {mode: string, extraSources: string[], storageSources: string[]}}}
 */
export function createSecurityHeaders({ env = process.env, isProduction = true, logger = console } = {}) {
  const { mode, invalid } = resolveCspMode(env.CSP_MODE, { isProduction });
  if (invalid) {
    logger.warn(
      `[security] CSP_MODE="${env.CSP_MODE}" is not one of ${CSP_MODES.join(", ")}; using "${mode}".`,
    );
  }

  const parsed = parseExtraSources(env.CSP_EXTRA_SOURCES);
  if (parsed.rejected.length) {
    logger.warn(
      `[security] CSP_EXTRA_SOURCES: ignored ${parsed.rejected.length} invalid entr${parsed.rejected.length === 1 ? "y" : "ies"} ` +
        `(${parsed.rejected.map((entry) => JSON.stringify(entry)).join(", ")}). ` +
        "Use comma-separated origins like https://cdn.example.com (no spaces inside an entry, no semicolons, no quotes).",
    );
  }
  const storageSources = deriveStorageSources(env);
  const extraSources = [...new Set([...storageSources, ...parsed.sources])];

  const headerName =
    mode === "report-only" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
  const reportOnly = mode === "report-only";

  const middleware = (req, res, next) => {
    res.removeHeader("X-Powered-By");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);

    const https = isHttpsRequest(req);
    if (https) {
      res.setHeader("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE_SECONDS}`);
    }
    if (mode !== "off") {
      res.setHeader(
        headerName,
        buildContentSecurityPolicy({ https, host: safeHost(req), extraSources, reportOnly }),
      );
    }
    next();
  };
  middleware.config = Object.freeze({ mode, extraSources, storageSources });
  return middleware;
}

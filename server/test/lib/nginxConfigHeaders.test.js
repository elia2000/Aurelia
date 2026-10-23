import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The app sends these itself (lib/securityHeaders.js). A second copy from nginx is not harmless:
// browsers intersect two Content-Security-Policy headers (the stricter wins, so a policy that is
// right for the app can be narrowed to a blank page), and a duplicate HSTS/X-Frame-Options is noise.
const OWNED = [
  "Content-Security-Policy",
  "Content-Security-Policy-Report-Only",
  "Strict-Transport-Security",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Resource-Policy",
  "Cross-Origin-Embedder-Policy",
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FILES = [
  "nginx/nginx.conf",
  "scripts/install.sh",
  "docs/Nginx-Configuration.md",
  "docs/fa/Nginx-Configuration.md",
  "docs/Subpath-Hosting.md",
  "docs/fa/Subpath-Hosting.md",
  "docs/SSL-Certificates.md",
  "docs/fa/SSL-Certificates.md",
  "docs/CDN-Setup.md",
  "docs/fa/CDN-Setup.md",
  "docs/Cloud-Deployment.md",
  "docs/fa/Cloud-Deployment.md",
];

const directives = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => /\b(add_header|proxy_set_header|more_set_headers|header_filter)\b/i.test(line));

describe("nginx configs and the docs that show them do not repeat the app's security headers", () => {
  for (const file of FILES) {
    test(`${file}`, () => {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const clashes = directives(text).filter((line) =>
        OWNED.some((name) => new RegExp(`(add_header|more_set_headers)\\s+["']?${name}\\b`, "i").test(line)),
      );
      expect(clashes).toEqual([]);
    });
  }

  test("the only add_header the shipped configs use is the SSE buffering hint", () => {
    for (const file of ["nginx/nginx.conf", "scripts/install.sh"]) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const added = directives(text).filter((line) => /\badd_header\b/.test(line));
      expect(added.length, file).toBeGreaterThan(0);
      for (const line of added) expect(line, file).toMatch(/add_header\s+X-Accel-Buffering\s+no;/);
    }
  });
});

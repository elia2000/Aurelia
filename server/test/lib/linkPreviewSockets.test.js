/**
 * The guarded fetcher with its REAL transport, against servers on 127.0.0.1.
 * Loopback is refused on purpose, so these tests use the test hook
 * (allowPrivate) and a resolver table instead of DNS: a host name that the
 * operating system could never resolve ("pinned.test") still connects, which
 * shows the connection goes to the address the fetcher chose.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LinkPreviewError, USER_AGENT, createGuardedFetcher } from "../../lib/linkPreview/guardedFetch.js";
import { makeResolver } from "../helpers/linkPreviewFixture.js";

const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
});

async function listen(handler, { secure = null } = {}) {
  const server = secure ? https.createServer(secure, handler) : http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { server, port: server.address().port };
}

const resolver = makeResolver({ "pinned.test": ["127.0.0.1"], "other.test": ["127.0.0.1"] });
const fetcher = createGuardedFetcher({ resolve: resolver, allowPrivate: true });
const HTML = { maxBytes: 64 * 1024, contentTypes: ["text/html"] };

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LinkPreviewError);
    return error.code;
  }
  return "no error";
};

describe("real connections", () => {
  test("go to the address that was chosen, with a fixed User-Agent, no cookie, no body", async () => {
    let seen;
    const { port } = await listen((req, res) => {
      seen = { method: req.method, headers: req.headers, url: req.url };
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("set-cookie", "a=b");
      res.end("<title>Hello</title>");
    });
    const result = await fetcher(`http://pinned.test:${port}/some/page?x=1#frag`, HTML);
    expect(result.body.toString()).toBe("<title>Hello</title>");
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe("/some/page?x=1");
    expect(seen.headers.host).toBe(`pinned.test:${port}`);
    expect(seen.headers["user-agent"]).toBe(USER_AGENT);
    expect(seen.headers["accept-encoding"]).toBe("identity");
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.referer).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["content-length"]).toBeUndefined();
  });

  test("follow a redirect to a second host name that also resolves through the table", async () => {
    let second;
    const { port } = await listen((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: `http://other.test:${port}/end` });
        return res.end();
      }
      second = req.headers.host;
      res.setHeader("content-type", "text/html");
      return res.end("<title>End</title>");
    });
    const result = await fetcher(`http://pinned.test:${port}/start`, HTML);
    expect(result.url.href).toBe(`http://other.test:${port}/end`);
    expect(second).toBe(`other.test:${port}`);
  });

  test("a redirect loop ends", async () => {
    let hits = 0;
    const { port } = await listen((req, res) => {
      hits += 1;
      res.writeHead(302, { location: req.url === "/a" ? "/b" : "/a" });
      res.end();
    });
    expect(await codeOf(fetcher(`http://pinned.test:${port}/a`, HTML))).toBe("redirect_loop");
    expect(hits).toBe(2);
  });

  test("an endless chain of different redirects stops after three", async () => {
    let hits = 0;
    const { port } = await listen((req, res) => {
      hits += 1;
      res.writeHead(302, { location: `/n${hits}` });
      res.end();
    });
    expect(await codeOf(fetcher(`http://pinned.test:${port}/start`, HTML))).toBe("too_many_redirects");
    expect(hits).toBe(4); // the first request and three redirects
  });

  test("a 404 and a wrong content type are refused", async () => {
    const { port } = await listen((req, res) => {
      if (req.url === "/missing") {
        res.statusCode = 404;
        res.setHeader("content-type", "text/html");
        return res.end("<title>nope</title>");
      }
      res.setHeader("content-type", "application/json");
      return res.end("{}");
    });
    expect(await codeOf(fetcher(`http://pinned.test:${port}/missing`, HTML))).toBe("bad_status");
    expect(await codeOf(fetcher(`http://pinned.test:${port}/data`, HTML))).toBe("bad_content_type");
  });

  test("a server that gzips regardless is refused", async () => {
    const { port } = await listen((req, res) => {
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "gzip");
      res.end(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    });
    expect(await codeOf(fetcher(`http://pinned.test:${port}/`, HTML))).toBe("bad_encoding");
  });

  test("a refused connection is a plain failure", async () => {
    const { server, port } = await listen(() => {});
    await new Promise((resolve) => server.close(resolve));
    expect(await codeOf(fetcher(`http://pinned.test:${port}/`, HTML))).toBe("network");
  });
});

describe("real limits", () => {
  test("slow loris: bytes dripped one at a time are cut off at the deadline and the socket is closed", async () => {
    let socketClosed = false;
    const { port } = await listen((req, res) => {
      req.socket.on("close", () => {
        socketClosed = true;
      });
      res.writeHead(200, { "content-type": "text/html" });
      const timer = setInterval(() => res.write("x"), 20);
      res.on("close", () => clearInterval(timer));
    });
    const started = Date.now();
    expect(await codeOf(fetcher(`http://pinned.test:${port}/`, { ...HTML, timeoutMs: 250 }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
    await sleep(100);
    expect(socketClosed).toBe(true);
  });

  test("a server that accepts the connection and never answers is cut off", async () => {
    let socketClosed = false;
    const { port } = await listen((req) => {
      req.socket.on("close", () => {
        socketClosed = true;
      });
    });
    expect(await codeOf(fetcher(`http://pinned.test:${port}/`, { ...HTML, timeoutMs: 150 }))).toBe("timeout");
    await sleep(100);
    expect(socketClosed).toBe(true);
  });

  test("a huge page is read only up to the limit and the download stops", async () => {
    let written = 0;
    let socketClosed = false;
    const { port } = await listen((req, res) => {
      req.socket.on("close", () => {
        socketClosed = true;
      });
      res.writeHead(200, { "content-type": "text/html" });
      const chunk = Buffer.alloc(16 * 1024, 97);
      const pump = () => {
        while (written < 200 * 1024 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        return res.end();
      };
      pump();
    });
    const result = await fetcher(`http://pinned.test:${port}/`, { ...HTML, maxBytes: 100 * 1024 });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(100 * 1024);
    await sleep(150);
    expect(socketClosed).toBe(true);
    expect(written).toBeLessThan(20 * 1024 * 1024); // nowhere near the 200 MB on offer
  });

  test("an image over its limit is refused, by Content-Length and by counting", async () => {
    const { port } = await listen((req, res) => {
      res.setHeader("content-type", "image/png");
      if (req.url === "/declared") return res.end(Buffer.alloc(5000));
      res.write(Buffer.alloc(3000));
      return res.end(Buffer.alloc(3000));
    });
    const image = { maxBytes: 4000, mustFit: true };
    expect(await codeOf(fetcher(`http://pinned.test:${port}/declared`, image))).toBe("too_large");
    expect(await codeOf(fetcher(`http://pinned.test:${port}/streamed`, image))).toBe("too_large");
  });

  test("response headers that are far too large are refused", async () => {
    const { port } = await listen((req, res) => {
      res.setHeader("content-type", "text/html");
      res.setHeader("x-big", "a".repeat(15 * 1024));
      res.setHeader("x-big-2", "b".repeat(15 * 1024));
      res.end("<title>x</title>");
    });
    expect(await codeOf(fetcher(`http://pinned.test:${port}/`, HTML))).toBe("network");
  });
});

describe("the real transport does not weaken the rules", () => {
  test("without the test hook a server on loopback is out of reach, by address and by name", async () => {
    let hits = 0;
    const { port } = await listen((req, res) => {
      hits += 1;
      res.setHeader("content-type", "text/html");
      res.end("<title>secret</title>");
    });
    const strict = createGuardedFetcher({ resolve: resolver });
    // Typed as an address, and with the port that is not 80/443 ...
    expect(await codeOf(strict(`http://127.0.0.1:${port}/`, HTML))).toBe("invalid_url");
    // ... and as a name that DNS points at loopback (default port, so only the address check stops it).
    expect(await codeOf(strict("http://pinned.test/", HTML))).toBe("blocked_address");
    expect(await codeOf(strict(`http://pinned.test:${port}/`, HTML))).toBe("invalid_url");
    expect(hits).toBe(0);
  });

  const haveOpenssl = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  test.skipIf(!haveOpenssl)("certificates are verified: a self-signed https server is refused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-tls-"));
    closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=pinned.test",
        "-addext", "subjectAltName=DNS:pinned.test",
        "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    let hits = 0;
    const { port } = await listen(
      (req, res) => {
        hits += 1;
        res.setHeader("content-type", "text/html");
        res.end("<title>x</title>");
      },
      { secure: { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) } },
    );
    expect(await codeOf(fetcher(`https://pinned.test:${port}/`, HTML))).toBe("network");
    expect(hits).toBe(0);
  });
});

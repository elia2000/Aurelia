/**
 * Doubles for the link preview tests: a DNS table, an HTTP transport that
 * answers from a table (no sockets), page and picture builders.
 */

import { Readable } from "node:stream";

export const PUBLIC_IP = "93.184.216.34";
export const PUBLIC_IP_2 = "151.101.1.69";

/** A resolver answering from a table: { "host": ["1.2.3.4", "::1"] }. Unknown hosts do not resolve. */
export function makeResolver(table = {}) {
  const calls = [];
  const resolve = async (host) => {
    calls.push(host);
    const answer = table[host];
    if (!answer) {
      const error = new Error(`getaddrinfo ENOTFOUND ${host}`);
      error.code = "ENOTFOUND";
      throw error;
    }
    const list = typeof answer === "function" ? answer(calls.filter((c) => c === host).length) : answer;
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  resolve.calls = calls;
  return resolve;
}

/**
 * A transport (see nodeTransport) answering from `handler(request)`, which returns
 * { status, headers, body } where body is a Buffer/string, an array of chunks, or
 * an async iterable. Records every request it was asked to make.
 */
export function makeTransport(handler) {
  const requests = [];
  const transport = async ({ url, addresses, headers, signal }) => {
    const request = { url: url.href, host: url.hostname, addresses, headers, signal };
    requests.push(request);
    const answer = await handler(request);
    if (answer instanceof Error) throw answer;
    const { status = 200, headers: responseHeaders = {}, body = "" } = answer;
    let stream;
    if (body && typeof body[Symbol.asyncIterator] === "function" && !Buffer.isBuffer(body)) {
      stream = body;
    } else {
      const chunks = Array.isArray(body) ? body : [body];
      stream = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))), {
        objectMode: false,
      });
    }
    return {
      status,
      headers: Object.fromEntries(Object.entries(responseHeaders).map(([k, v]) => [k.toLowerCase(), v])),
      body: stream,
      destroy: () => {
        if (typeof stream.destroy === "function") stream.destroy();
      },
    };
  };
  transport.requests = requests;
  return transport;
}

export const html = (headInner, bodyInner = "<p>hello</p>") =>
  `<!doctype html><html><head><meta charset="utf-8">${headInner}</head><body>${bodyInner}</body></html>`;

export const htmlResponse = (headInner, extraHeaders = {}) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
  body: html(headInner),
});

export const redirectTo = (location, status = 302) => ({ status, headers: { location }, body: "" });

const u32be = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** A PNG with a real header of the given size (the pixel data is filler). */
export function pngBytes(width = 8, height = 6, filler = 0) {
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0])]);
  const chunk = (type, data) => Buffer.concat([u32be(data.length), Buffer.from(type, "latin1"), data, u32be(0)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.alloc(12 + filler, 5)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG: SOI, an APP0, then a baseline frame header with the given size. */
export function jpegBytes(width = 8, height = 6, filler = 0) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(filler, 1), Buffer.from([0xff, 0xd9])]);
}

export function gifBytes(width = 8, height = 6) {
  const w = Buffer.from([width & 0xff, (width >> 8) & 0xff]);
  const h = Buffer.from([height & 0xff, (height >> 8) & 0xff]);
  return Buffer.concat([Buffer.from("GIF89a", "latin1"), w, h, Buffer.from([0x00, 0x00, 0x00, 0x3b])]);
}

/** A lossless WebP (VP8L) of the given size. */
export function webpBytes(width = 8, height = 6) {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const payload = Buffer.concat([Buffer.from([0x2f]), Buffer.from(new Uint32Array([bits]).buffer), Buffer.alloc(8)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  const chunk = Buffer.concat([Buffer.from("VP8L", "latin1"), size, payload]);
  const total = Buffer.alloc(4);
  total.writeUInt32LE(chunk.length + 4);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), total, Buffer.from("WEBP", "latin1"), chunk]);
}

export const svgBytes = () =>
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><script>alert(1)</script></svg>');

export const imageResponse = (bytes, contentType = "image/png") => ({
  status: 200,
  headers: { "content-type": contentType, "content-length": String(bytes.length) },
  body: bytes,
});

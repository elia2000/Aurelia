/**
 * The only way the link preview feature talks to the internet.
 *
 * A person pastes a link and the SERVER fetches it, so everything here is
 * written to make sure the link cannot be used to reach anything but a public
 * web server (SSRF), and cannot tie the server up:
 *
 *   - only http/https, no user:password in the URL, ports 80/443 only
 *   - the host name is resolved HERE (c-ares with a timeout, cancelled by the
 *     deadline below; see dnsResolver.js), every returned address must be public
 *     (see addresses.js), and the connection is made to that exact address
 *     (the socket's own lookup is replaced), so a DNS answer that changes
 *     between "check" and "connect" (DNS rebinding) cannot matter
 *   - the same checks run again for EVERY redirect (at most 3, loops refused)
 *   - one deadline for the whole fetch (default 5 s) covers DNS, connecting,
 *     redirects and reading the body, so a server that drips bytes (slow
 *     loris) is cut off
 *   - the body is read only up to a byte limit; a response that must be whole
 *     (an image) is refused when it is bigger, a page is cut and parsed as is
 *   - a fixed User-Agent, no cookies (none sent, Set-Cookie ignored), no
 *     request body, no Referer, no compression (Accept-Encoding: identity;
 *     anything else is refused, so there is no decompression bomb)
 *
 * `resolve` and `transport` can be replaced, which is how the tests run
 * without a network.
 *
 * TEST HOOK: `allowPrivate: true` switches the address and port checks off so
 * a test can fetch from a server on 127.0.0.1. It is only ever set from
 * allowPrivateForTests() in ../linkPreview.js, which ignores the environment
 * variable in production.
 */

import http from "node:http";
import https from "node:https";
import { addressFamily, isPublicAddress } from "./addresses.js";
import { createDnsResolver } from "./dnsResolver.js";

export const USER_AGENT = "AurelleLinkPreview/1.0 (+self-hosted messenger; no cookies)";
export const MAX_URL_LENGTH = 2048;
export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 5000;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_ADDRESSES = 8;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Names that only mean something on a private network. (A name that resolves to
// a private address is refused anyway; this saves the lookup, including the
// multicast DNS lookup a ".local" name would trigger.)
const PRIVATE_SUFFIXES = [
  "localhost", "local", "internal", "lan", "home", "corp", "localdomain",
  "home.arpa", "intranet", "private", "arpa",
];

/** Something the preview cannot be made from. `code` is for logs and tests, never shown with details. */
export class LinkPreviewError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "LinkPreviewError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new LinkPreviewError(code, message);
};

const hostWithoutBrackets = (hostname) =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

/**
 * Checks everything about a link that can be checked without the network and
 * returns the parsed URL (without its #fragment). Throws code "invalid_url".
 */
export function checkLinkUrl(raw, { allowPrivate = false } = {}) {
  if (typeof raw !== "string") fail("invalid_url", "The link is not a string.");
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH) fail("invalid_url", "The link is empty or too long.");
  // The URL parser silently drops tabs and line breaks inside a link; a link
  // that has them is not one we want to interpret.
  if (/[\u0000- \u007f-\u009f]/.test(text)) fail("invalid_url", "The link has control characters.");

  let url;
  try {
    url = new URL(text);
  } catch {
    return fail("invalid_url", "The link is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("invalid_url", "Only http and https links.");
  if (url.username || url.password) fail("invalid_url", "Links with a user name or password are refused.");
  if (!url.hostname) fail("invalid_url", "The link has no host.");

  if (!allowPrivate) {
    if (url.port !== "" && url.port !== "80" && url.port !== "443") {
      fail("invalid_url", "Only ports 80 and 443.");
    }
    const host = hostWithoutBrackets(url.hostname).replace(/\.$/, "");
    if (addressFamily(host)) {
      // An address spelled out in the link (the URL parser has already turned
      // 2130706433, 0x7f.1, 017700000001 ... into 127.0.0.1).
      if (!isPublicAddress(host)) fail("invalid_url", "That address is not public.");
    } else {
      if (host.length > 253 || !host.includes(".")) fail("invalid_url", "That is not a public host name.");
      if (PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
        fail("invalid_url", "That is not a public host name.");
      }
    }
  }
  url.hash = "";
  return url;
}

// c-ares, not getaddrinfo: it times out, and the fetch's deadline cancels it
// (see dnsResolver.js for why the threadpool lookup is not an option).
const defaultResolve = createDnsResolver();

/**
 * The real request. One connection to one of `addresses` (already checked),
 * answering as soon as the response headers are in.
 */
export function nodeTransport({ url, addresses, headers, signal }) {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const request = (secure ? https : http).request(
      {
        protocol: url.protocol,
        hostname: hostWithoutBrackets(url.hostname),
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        agent: false,
        maxHeaderSize: MAX_HEADER_BYTES,
        // Connect to the address that was checked, whatever DNS says now.
        lookup: (_hostname, options, callback) => {
          if (options && options.all) {
            callback(null, addresses.map(({ address, family }) => ({ address, family })));
          } else {
            callback(null, addresses[0].address, addresses[0].family);
          }
        },
        ...(secure ? { minVersion: "TLSv1.2" } : null),
      },
      (response) => {
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body: response,
          destroy: () => request.destroy(),
        });
      },
    );
    request.on("error", reject);
    const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

/** Rejects as soon as `signal` aborts; otherwise settles like `promise`. */
function raceAbort(promise, signal) {
  const source = Promise.resolve(promise);
  if (signal.aborted) {
    // Nobody will wait for it: its failure must not become an unhandled rejection.
    source.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    source.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const contentTypeOf = (headers) =>
  String(headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();

async function readLimited(response, { maxBytes, mustFit, signal }) {
  const iterator = response.body[Symbol.asyncIterator]();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await raceAbort(iterator.next(), signal);
      if (done) break;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (size + chunk.length > maxBytes) {
        if (mustFit) fail("too_large", "The response is bigger than the limit.");
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    // Stop the download whatever happened.
    try {
      response.destroy();
    } catch {
      // already closed
    }
    if (typeof iterator.return === "function") {
      Promise.resolve(iterator.return()).catch(() => {});
    }
  }
  return { body: Buffer.concat(chunks, size), truncated };
}

/**
 * @param {object} [options]
 * @param {(host: string, options: { signal: AbortSignal }) => Promise<Array<{address: string, family?: number}>>} [options.resolve]
 * @param {Function} [options.transport]  see nodeTransport
 * @param {boolean}  [options.allowPrivate]  TEST HOOK, see the file comment
 */
export function createGuardedFetcher({
  resolve = defaultResolve,
  transport = nodeTransport,
  allowPrivate = false,
} = {}) {
  async function resolveHost(url, signal) {
    const host = hostWithoutBrackets(url.hostname);
    const family = addressFamily(host);
    if (family) return [{ address: host, family }];
    let answer;
    try {
      answer = await raceAbort(resolve(host.replace(/\.$/, ""), { signal }), signal);
    } catch (error) {
      if (error instanceof LinkPreviewError) throw error;
      if (signal.aborted) throw signal.reason;
      return fail("dns_failed", "The host name did not resolve.");
    }
    const addresses = (Array.isArray(answer) ? answer : [])
      .map((entry) => (typeof entry === "string" ? entry : entry?.address))
      .filter((address) => typeof address === "string" && addressFamily(address))
      .slice(0, MAX_ADDRESSES)
      .map((address) => ({ address, family: addressFamily(address) }));
    if (!addresses.length) fail("dns_failed", "The host name did not resolve.");
    // One private answer is enough to refuse: nothing is connected to.
    if (!allowPrivate && addresses.some((entry) => !isPublicAddress(entry.address))) {
      fail("blocked_address", "The host resolves to a non-public address.");
    }
    return addresses;
  }

  /**
   * GET `rawUrl` with all of the above.
   *
   * @param {string} rawUrl
   * @param {object} options
   * @param {number} options.maxBytes
   * @param {string} [options.accept]            the Accept header
   * @param {string[]} [options.contentTypes]    allowed media types, or omitted for any
   * @param {boolean} [options.mustFit]          refuse (instead of cutting) a response over maxBytes
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxRedirects]
   * @returns {Promise<{ url: URL, status: number, contentType: string, headers: object, body: Buffer, truncated: boolean }>}
   */
  return async function fetchGuarded(rawUrl, options = {}) {
    const {
      maxBytes,
      accept = "*/*",
      contentTypes = null,
      mustFit = false,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxRedirects = MAX_REDIRECTS,
    } = options;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes is required");

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new LinkPreviewError("timeout", "The site took too long.")),
      timeoutMs,
    );
    if (typeof timer.unref === "function") timer.unref();
    const signal = controller.signal;

    try {
      let url = checkLinkUrl(rawUrl, { allowPrivate });
      const visited = new Set();
      for (let hop = 0; ; hop += 1) {
        if (visited.has(url.href)) fail("redirect_loop", "The link redirects in a circle.");
        visited.add(url.href);

        const addresses = await resolveHost(url, signal);
        let response;
        try {
          response = await raceAbort(
            transport({
              url,
              addresses,
              signal,
              headers: {
                "User-Agent": USER_AGENT,
                Accept: accept,
                "Accept-Encoding": "identity",
                "Accept-Language": "en;q=0.9, *;q=0.5",
                Connection: "close",
              },
            }),
            signal,
          );
        } catch (error) {
          if (error instanceof LinkPreviewError) throw error;
          if (signal.aborted) throw signal.reason;
          return fail("network", "Could not connect.");
        }

        try {
          if (REDIRECT_STATUSES.has(response.status)) {
            if (hop >= maxRedirects) fail("too_many_redirects", "Too many redirects.");
            const location = response.headers?.location;
            if (typeof location !== "string" || !location || location.length > MAX_URL_LENGTH) {
              fail("bad_redirect", "The redirect has no usable address.");
            }
            let next;
            try {
              next = new URL(location, url).href;
            } catch {
              return fail("bad_redirect", "The redirect has no usable address.");
            }
            // The next hop gets exactly the checks the first one did.
            try {
              url = checkLinkUrl(next, { allowPrivate });
            } catch {
              return fail("blocked_redirect", "The redirect leads somewhere that is not allowed.");
            }
            continue;
          }

          // Only a plain 200: no "no content", no partial content.
          if (response.status !== 200) {
            fail("bad_status", `The site answered ${response.status}.`);
          }
          const encoding = String(response.headers?.["content-encoding"] || "identity").trim().toLowerCase();
          if (encoding && encoding !== "identity") fail("bad_encoding", "The response is compressed.");
          const contentType = contentTypeOf(response.headers);
          if (contentTypes && !contentTypes.includes(contentType)) {
            fail("bad_content_type", "The response is not the expected type.");
          }
          const declared = Number(response.headers?.["content-length"]);
          if (mustFit && Number.isFinite(declared) && declared > maxBytes) {
            fail("too_large", "The response is bigger than the limit.");
          }

          const { body, truncated } = await readLimited(response, { maxBytes, mustFit, signal });
          return {
            url,
            status: response.status,
            contentType,
            headers: response.headers,
            body,
            truncated,
          };
        } finally {
          // Only matters when we left without reading the body (redirect, error).
          try {
            response.destroy?.();
          } catch {
            // already closed
          }
        }
      }
    } catch (error) {
      if (error instanceof LinkPreviewError) throw error;
      if (signal.aborted && signal.reason instanceof LinkPreviewError) throw signal.reason;
      throw new LinkPreviewError("network", "The fetch failed.");
    } finally {
      clearTimeout(timer);
    }
  };
}

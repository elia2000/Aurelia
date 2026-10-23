import { vi } from "vitest";

/**
 * A fetch stub that answers by "METHOD /path". Each handler gets the parsed
 * JSON body and returns [status, body]; handlers may be arrays to answer
 * several calls in turn. Unknown routes fail the test loudly.
 */
export function stubFetchRoutes(routes) {
  const calls = [];
  // A handler is a function, a [status, body] pair, or a list of pairs answered in turn (the last one repeats).
  const isQueue = (value) => Array.isArray(value) && Array.isArray(value[0]);
  const queues = new Map(Object.entries(routes).map(([key, value]) => [key, isQueue(value) ? [...value] : value]));
  const fetchStub = vi.fn(async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    const path = String(url).split("?")[0];
    const key = `${method} ${path}`;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path, key, body });
    let handler = queues.get(key);
    if (isQueue(handler)) handler = handler.length > 1 ? handler.shift() : handler[0];
    if (handler === undefined) throw new Error(`Unexpected request: ${key}`);
    const [status, payload] = typeof handler === "function" ? await handler(body) : handler;
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  });
  vi.stubGlobal("fetch", fetchStub);
  return { calls, fetchStub, called: (key) => calls.filter((c) => c.key === key) };
}

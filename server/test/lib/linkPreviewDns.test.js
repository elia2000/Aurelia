import { afterEach, describe, expect, test, vi } from "vitest";
import dgram from "node:dgram";
import dns from "node:dns";
import { createDnsResolver } from "../../lib/linkPreview/dnsResolver.js";
import { LinkPreviewError, createGuardedFetcher } from "../../lib/linkPreview/guardedFetch.js";

/** A stand-in for dns.promises.Resolver: each query settles as the test says. */
function fakeChannel({ v4, v6 } = {}) {
  const channel = {
    queries: [],
    cancelled: 0,
    resolve4: (host) => {
      channel.queries.push(["A", host]);
      return typeof v4 === "function" ? v4(host) : Promise.resolve(v4 ?? []);
    },
    resolve6: (host) => {
      channel.queries.push(["AAAA", host]);
      return typeof v6 === "function" ? v6(host) : Promise.resolve(v6 ?? []);
    },
    cancel: () => {
      channel.cancelled += 1;
      channel.onCancel?.();
    },
  };
  return channel;
}

const noData = () => Promise.reject(Object.assign(new Error("queryAaaa ENODATA"), { code: "ENODATA" }));
const hang = () => new Promise(() => {});

describe("the link preview name lookup", () => {
  test("asks for A and AAAA records and returns IPv4 first", async () => {
    const channel = fakeChannel({ v4: ["93.184.216.34"], v6: ["2606:2800:220:1:248:1893:25c8:1946"] });
    const resolve = createDnsResolver({ createChannel: () => channel });
    const answer = await resolve("example.com", { signal: new AbortController().signal });
    expect(answer).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    expect(channel.queries).toEqual([
      ["A", "example.com"],
      ["AAAA", "example.com"],
    ]);
  });

  test("a name with only one kind of record still resolves", async () => {
    const onlyV4 = createDnsResolver({ createChannel: () => fakeChannel({ v4: ["93.184.216.34"], v6: noData }) });
    expect(await onlyV4("a.example.com")).toEqual([{ address: "93.184.216.34", family: 4 }]);
    const onlyV6 = createDnsResolver({ createChannel: () => fakeChannel({ v4: noData, v6: ["2606:4700::1111"] }) });
    expect(await onlyV6("b.example.com")).toEqual([{ address: "2606:4700::1111", family: 6 }]);
  });

  test("a name with no records at all is an error", async () => {
    const resolve = createDnsResolver({ createChannel: () => fakeChannel({ v4: noData, v6: noData }) });
    await expect(resolve("nothing.example.com")).rejects.toThrow(/ENODATA/);
  });

  test("a lookup that never answers is cancelled the moment the fetch gives up", async () => {
    const channel = fakeChannel({ v4: hang, v6: hang });
    const resolve = createDnsResolver({ createChannel: () => channel });
    const controller = new AbortController();
    const reason = new Error("deadline");
    const pending = resolve("slow.example.com", { signal: controller.signal });
    expect(channel.cancelled).toBe(0);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    // Cancelled for real (this is what frees the resolver's own resources).
    expect(channel.cancelled).toBe(1);
  });

  test("a lookup that was cancelled before it started asks nothing", async () => {
    const channel = fakeChannel({ v4: ["93.184.216.34"] });
    const resolve = createDnsResolver({ createChannel: () => channel });
    const controller = new AbortController();
    controller.abort(new Error("early"));
    await expect(resolve("example.com", { signal: controller.signal })).rejects.toThrow("early");
    expect(channel.queries).toEqual([]);
  });

  test("every lookup gets its own channel, so cancelling one never touches another", async () => {
    const channels = [];
    const resolve = createDnsResolver({
      createChannel: () => {
        const channel = fakeChannel({ v4: hang, v6: hang });
        channels.push(channel);
        return channel;
      },
    });
    const first = new AbortController();
    const second = new AbortController();
    const a = resolve("a.example.com", { signal: first.signal }).catch(() => {});
    const b = resolve("b.example.com", { signal: second.signal }).catch(() => {});
    first.abort(new Error("stop a"));
    await a;
    expect(channels.map((channel) => channel.cancelled)).toEqual([1, 0]);
    second.abort(new Error("stop b"));
    await b;
  });

  test("a finished lookup is not cancelled afterwards", async () => {
    const channel = fakeChannel({ v4: ["93.184.216.34"], v6: noData });
    const resolve = createDnsResolver({ createChannel: () => channel });
    const controller = new AbortController();
    await resolve("example.com", { signal: controller.signal });
    controller.abort(new Error("late"));
    expect(channel.cancelled).toBe(0);
  });
});

describe("the guarded fetcher's own lookup", () => {
  test("never uses the threadpool resolver (getaddrinfo), which cannot be cancelled", async () => {
    const promisesLookup = vi.spyOn(dns.promises, "lookup");
    const callbackLookup = vi.spyOn(dns, "lookup");
    try {
      const fetchGuarded = createGuardedFetcher({ transport: () => Promise.reject(new Error("no network in this test")) });
      await expect(fetchGuarded("https://never-looked-up.example/", { maxBytes: 1024, timeoutMs: 300 })).rejects.toBeInstanceOf(
        LinkPreviewError,
      );
      expect(promisesLookup).not.toHaveBeenCalled();
      expect(callbackLookup).not.toHaveBeenCalled();
    } finally {
      promisesLookup.mockRestore();
      callbackLookup.mockRestore();
    }
  });
});

describe("against a name server that never answers (the real resolver)", () => {
  let silent;

  afterEach(async () => {
    if (silent) await new Promise((resolve) => silent.close(resolve));
    silent = null;
  });

  async function startSilentServer() {
    silent = dgram.createSocket("udp4");
    const received = [];
    silent.on("message", (message) => received.push(message));
    await new Promise((resolve) => silent.bind(0, "127.0.0.1", resolve));
    return { port: silent.address().port, received };
  }

  test("many lookups give up on time and leave the rest of the process able to resolve names", async () => {
    const { port, received } = await startSilentServer();
    const resolve = createDnsResolver({ servers: [`127.0.0.1:${port}`], timeoutMs: 300 });

    const started = Date.now();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 24 }, (_, i) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("deadline")), 300);
        return resolve(`host-${i}.silent.example`, { signal: controller.signal }).finally(() => clearTimeout(timer));
      }),
    );
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(received.length).toBeGreaterThan(0); // they really went to the silent server

    // The name lookup the rest of the server uses (web push, webhooks, storage)
    // is the libuv threadpool one: it must not have been touched at all.
    const before = Date.now();
    await dns.promises.lookup("localhost");
    expect(Date.now() - before).toBeLessThan(500);
  });

  test("without the fetch's own deadline the resolver still stops by itself", async () => {
    const { port } = await startSilentServer();
    const resolve = createDnsResolver({ servers: [`127.0.0.1:${port}`], timeoutMs: 150 });
    const started = Date.now();
    await expect(resolve("quiet.example")).rejects.toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

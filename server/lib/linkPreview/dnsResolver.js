/**
 * The name lookup for link previews.
 *
 * `dns.lookup` (getaddrinfo) cannot be used here: it runs in libuv's small
 * threadpool, cannot be cancelled, and a name server that never answers keeps
 * its thread for as long as the system resolver takes to give up. libuv lets
 * only about half of the pool's four threads do that kind of work, so a few
 * dozen lookups of names under a silent name server would hold up EVERY other
 * name lookup of the process (web push, webhooks, object storage, remote
 * channels) for minutes, long after the preview itself had timed out.
 *
 * This uses c-ares (`dns.promises.Resolver`) instead: it does its own network
 * I/O (no threadpool), has a real timeout, and `cancel()` ends the queries at
 * once. Each lookup gets its own resolver, so cancelling one never touches
 * another, and the fetch's deadline (an AbortSignal) cancels it.
 *
 * Only A and AAAA records are asked for, with no search domains and no
 * /etc/hosts, which is what a public web address needs.
 */

import dns from "node:dns";

export const DNS_TIMEOUT_MS = 2000;

function defaultChannel({ servers, timeoutMs }) {
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  if (servers && servers.length) resolver.setServers(servers);
  return resolver;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.servers]    name servers to use instead of the system's (tests)
 * @param {number}   [options.timeoutMs]  how long to wait for one server (default 2 s)
 * @param {Function} [options.createChannel]  replaces the c-ares resolver (tests)
 * @returns {(host: string, options?: { signal?: AbortSignal }) => Promise<Array<{address: string, family: 4|6}>>}
 */
export function createDnsResolver({ servers = null, timeoutMs = DNS_TIMEOUT_MS, createChannel = defaultChannel } = {}) {
  return async function resolve(host, { signal } = {}) {
    if (signal?.aborted) throw signal.reason;
    const channel = createChannel({ servers, timeoutMs });

    let onAbort;
    const aborted = new Promise((_, reject) => {
      if (!signal) return;
      onAbort = () => {
        // Ends the queries now, rather than when the resolver gives up.
        try {
          channel.cancel();
        } catch {
          // nothing left to cancel
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    const ask = async () => {
      const [v4, v6] = await Promise.allSettled([
        (async () => channel.resolve4(host))(),
        (async () => channel.resolve6(host))(),
      ]);
      const answer = [
        ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
        ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
      ];
      if (answer.length) return answer;
      // A name with one kind of record only is fine (above); with neither,
      // the first error says why.
      throw (v4.status === "rejected" ? v4.reason : v6.reason) ?? new Error("The host name did not resolve.");
    };

    try {
      return await Promise.race([ask(), aborted]);
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

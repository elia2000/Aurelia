// Small pure helpers for the "technical details" of a call that could not
// connect. They only ever produce kinds of things (candidate kinds, server
// names, pair states): never IP addresses, credentials or anything the other
// device could choose freely.

const CANDIDATE_KINDS = ["host", "srflx", "prflx", "relay"];

/** A tally of ICE candidate kinds, with no inherited names to trip over. */
export const newCandidateCounts = () => Object.assign(Object.create(null), ...CANDIDATE_KINDS.map((kind) => ({ [kind]: 0 })));

/**
 * Adds the kind of an ICE candidate line ("... typ relay ...") to a tally.
 * The line of the remote side comes from the other device, so only the four
 * real kinds are counted; anything else is not.
 */
export function countCandidate(counts, line) {
  const kind = /\btyp (\w+)/.exec(String(line || ""))?.[1];
  if (kind && CANDIDATE_KINDS.includes(kind)) counts[kind] += 1;
}

/** "host 2, relay 1", or "none". */
export const formatCounts = (counts) => {
  const parts = CANDIDATE_KINDS.filter((kind) => counts[kind] > 0).map((kind) => `${kind} ${counts[kind]}`);
  return parts.length ? parts.join(", ") : "none";
};

/** "stun:host:3478, turn:host:3478 (udp, tcp)": the servers, without credentials. */
export function summariseServers(iceServers) {
  const seen = new Map();
  for (const server of Array.isArray(iceServers) ? iceServers : []) {
    for (const url of [].concat(server?.urls || [])) {
      // Whatever precedes an "@" (a user name and password written into the URL) is dropped.
      const match = /^(stuns?|turns?):(?:[^@?]*@)?([^?#]+)(?:\?[^#]*?\btransport=(\w+))?/i.exec(String(url));
      if (!match) continue;
      const key = `${match[1].toLowerCase()}:${match[2]}`;
      const transports = seen.get(key) || new Set();
      if (match[3]) transports.add(match[3].toLowerCase());
      seen.set(key, transports);
    }
  }
  return [...seen].map(([key, transports]) => (transports.size ? `${key} (${[...transports].join(", ")})` : key));
}

const SAFE_WORD = /^[a-z0-9-]{1,12}$/;
const word = (value, fallback) => (SAFE_WORD.test(String(value || "")) ? String(value) : fallback);

/** "host udp", "relay via tcp": the kind of an address, never the address. */
export function describeCandidate(candidate) {
  if (!candidate) return "?";
  const type = word(candidate.candidateType, "?");
  if (type === "relay" && candidate.relayProtocol) return `relay via ${word(candidate.relayProtocol, "?")}`;
  return candidate.protocol ? `${type} ${word(candidate.protocol, "?")}` : type;
}

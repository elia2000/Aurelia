import { describe, test, expect, vi } from "vitest";
import { buildCallReport, copyText } from "../../src/calls/report.js";

describe("buildCallReport", () => {
  test("puts the build, the result and the browser above the details", () => {
    const text = buildCallReport({
      reason: "connect_failed_relay_unreachable",
      lines: ["Relay candidates: 0", "Role: caller"],
      buildId: "f9a1862-abc",
      userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/130",
    });
    expect(text.split("\n")).toEqual([
      "Aurelle call report",
      "Build: f9a1862-abc",
      "Result: connect_failed_relay_unreachable",
      "Browser: Mozilla/5.0 (Linux; Android 14) Chrome/130",
      "Relay candidates: 0",
      "Role: caller",
    ]);
  });

  test("leaves out what is not known", () => {
    expect(buildCallReport({ lines: ["a"] })).toBe("Aurelle call report\na");
    expect(buildCallReport({})).toBe("Aurelle call report");
  });
});

describe("copyText", () => {
  test("uses the clipboard when there is one", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    expect(await copyText("hello", { clipboard, doc: null })).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith("hello");
  });

  test("falls back to selecting a hidden field when the clipboard refuses", async () => {
    const field = { style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn(), value: "" };
    const doc = {
      createElement: vi.fn(() => field),
      body: { appendChild: vi.fn() },
      execCommand: vi.fn(() => true),
    };
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error("denied")) };
    expect(await copyText("hello", { clipboard, doc })).toBe(true);
    expect(field.value).toBe("hello");
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(field.remove).toHaveBeenCalled();
  });

  test("the hidden field is removed even when selecting or copying throws", async () => {
    const field = { style: {}, setAttribute: vi.fn(), select: vi.fn(() => { throw new Error("blocked"); }), remove: vi.fn(), value: "" };
    const doc = { createElement: () => field, body: { appendChild: vi.fn() }, execCommand: vi.fn(() => true) };
    expect(await copyText("hello", { clipboard: null, doc })).toBe(false);
    expect(field.remove).toHaveBeenCalledTimes(1);

    const field2 = { style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn(), value: "" };
    const doc2 = { createElement: () => field2, body: { appendChild: vi.fn() }, execCommand: vi.fn(() => { throw new Error("blocked"); }) };
    expect(await copyText("hello", { clipboard: null, doc: doc2 })).toBe(false);
    expect(field2.remove).toHaveBeenCalledTimes(1);
  });

  test("says so when nothing could be copied", async () => {
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error("denied")) };
    expect(await copyText("hello", { clipboard, doc: null })).toBe(false);
    const doc = {
      createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }),
      body: { appendChild() {} },
      execCommand: () => false,
    };
    expect(await copyText("hello", { clipboard: null, doc })).toBe(false);
  });
});

import {
  countCandidate,
  describeCandidate,
  formatCounts,
  newCandidateCounts,
  summariseServers,
} from "../../src/calls/connectionReport.js";

describe("candidate tallies", () => {
  test("count the four real kinds and say 'none' when empty", () => {
    const counts = newCandidateCounts();
    expect(formatCounts(counts)).toBe("none");
    countCandidate(counts, "candidate:1 1 udp 2122 192.168.1.5 5000 typ host generation 0");
    countCandidate(counts, "candidate:2 1 udp 2122 192.168.1.5 5001 typ host");
    countCandidate(counts, "candidate:3 1 udp 1686 203.0.113.9 5002 typ srflx raddr 0.0.0.0 rport 0");
    countCandidate(counts, "candidate:4 1 udp 41 203.0.113.9 5003 typ relay");
    expect(formatCounts(counts)).toBe("host 2, srflx 1, relay 1");
  });

  test("a kind the other device makes up is not counted, nor can it reach names every object has", () => {
    const counts = newCandidateCounts();
    for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty", "Please_email_your_password", "HOST"]) {
      countCandidate(counts, `candidate:1 1 udp 1 1.2.3.4 9 typ ${kind}`);
    }
    countCandidate(counts, "not a candidate line");
    countCandidate(counts, undefined);
    expect(formatCounts(counts)).toBe("none");
    expect(Object.keys(counts).sort()).toEqual(["host", "prflx", "relay", "srflx"]);
  });
});

describe("summariseServers", () => {
  test("lists each server once with its transports", () => {
    expect(
      summariseServers([
        { urls: ["stun:relay.example:3478", "turn:relay.example:3478?transport=udp", "turn:relay.example:3478?transport=tcp"], username: "u", credential: "c" },
        { urls: "turns:relay.example:5349?transport=tcp" },
      ]),
    ).toEqual(["stun:relay.example:3478", "turn:relay.example:3478 (udp, tcp)", "turns:relay.example:5349 (tcp)"]);
  });

  test("never repeats a user name or password written into a URL", () => {
    const text = summariseServers([
      { urls: ["turn:alice:s3cret@turn.example.com:3478?transport=udp", "turn:bob@turn.example.com:3478"] },
    ]).join(", ");
    expect(text).toBe("turn:turn.example.com:3478 (udp)");
    expect(text).not.toMatch(/s3cret|alice|bob/);
  });

  test("copes with odd input", () => {
    expect(summariseServers(undefined)).toEqual([]);
    expect(summariseServers([{ urls: ["http://elsewhere", 5, null] }, null, {}])).toEqual([]);
    expect(summariseServers([{ urls: "turn:h:1?foo=1&transport=tcp#frag" }])).toEqual(["turn:h:1 (tcp)"]);
  });
});

describe("describeCandidate", () => {
  test("names only the kind and the protocol", () => {
    expect(describeCandidate({ candidateType: "host", protocol: "udp", address: "192.168.1.5" })).toBe("host udp");
    expect(describeCandidate({ candidateType: "relay", protocol: "udp", relayProtocol: "tcp" })).toBe("relay via tcp");
    expect(describeCandidate({ candidateType: "srflx" })).toBe("srflx");
    expect(describeCandidate(undefined)).toBe("?");
  });

  test("text that is not a plain word is not repeated", () => {
    expect(describeCandidate({ candidateType: "host\nInjected", protocol: "udp 1.2.3.4" })).toBe("? ?");
  });
});

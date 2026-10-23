import { describe, test, expect, vi } from "vitest";
import {
  applyTrustEvent,
  createKeyNoticeStore,
  describeNotice,
  isDismissible,
  mergeKeyNotices,
  noticePlainText,
  sanitizeNotice,
  severityOf,
  KEY_CHANGE_EVENT,
  MAX_NOTICES_PER_CONTACT,
  NOTICE_KIND as K,
  NOTICE_RESOLUTION as R,
  NOTICE_STATE as S,
  STORAGE_PREFIX,
} from "../../src/e2ee/keyChangeNotices.js";
import { TRUST } from "../../src/e2ee/trust.js";
import { isServiceMessage, getServerMessageId } from "../../src/utils/messageKind.js";
import { isMessageSelectable } from "../../src/utils/batchMessages.js";
import { computeMessageRuns } from "../../src/utils/messageRuns.js";

const D1 = "d1";
const D2 = "d2";
const D3 = "d3";
let counter = 0;
const ctx = (now = 1_000) => ({ now, newId: () => `n${(counter += 1)}` });

const assessed = (over = {}) => ({
  type: "assessed",
  userId: "bob",
  status: TRUST.OK,
  added: [],
  removed: [],
  mismatched: [],
  listed: [D1],
  known: 1,
  verified: false,
  ...over,
});
const addedEvent = (ids = [D2], over = {}) =>
  assessed({ status: TRUST.DEVICES_ADDED, added: ids, listed: [D1, ...ids], ...over });

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

describe("applyTrustEvent", () => {
  test("seeing someone for the first time, or nothing new, says nothing", () => {
    const start = [];
    expect(applyTrustEvent(start, assessed({ status: TRUST.NEW, known: 0 }), ctx())).toBe(start);
    expect(applyTrustEvent(start, assessed(), ctx())).toBe(start);
  });

  test("seeing a person for the first time pins what they have: no line", () => {
    const start = [];
    expect(applyTrustEvent(start, assessed({ status: TRUST.NEW, known: 0, listed: [D1] }), ctx())).toBe(start);
  });

  test("a device that appears for a contact pinned with none is a new device like any other", () => {
    const list = applyTrustEvent([], addedEvent([D1], { known: 0, listed: [D1] }), ctx());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: K.ADDED, state: S.OPEN, deviceIds: [D1] });
  });

  test("an added device makes one open line, however often it is reported", () => {
    let list = applyTrustEvent([], addedEvent(), ctx(1_000));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: K.ADDED, state: S.OPEN, deviceIds: [D2], count: 1, verified: false, at: 1_000, userId: "bob" });
    for (let i = 0; i < 5; i += 1) {
      const again = applyTrustEvent(list, addedEvent(), ctx(2_000 + i));
      expect(again).toBe(list);
    }
  });

  test("a larger set of unacknowledged devices replaces the older open line", () => {
    let list = applyTrustEvent([], addedEvent([D2]), ctx(1_000));
    list = applyTrustEvent(list, addedEvent([D2, D3], { verified: true }), ctx(5_000));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ deviceIds: [D2, D3], count: 2, at: 5_000, verified: true });
  });

  test("a verified contact's change is the red kind", () => {
    const list = applyTrustEvent([], addedEvent([D2], { verified: true }), ctx());
    expect(severityOf(list[0])).toBe("danger");
    expect(describeNotice(list[0])).toMatchObject({ severity: "danger", headline: "Safety number changed" });
    const calm = applyTrustEvent([], addedEvent([D2]), ctx());
    expect(severityOf(calm[0])).toBe("warning");
    expect(describeNotice(calm[0]).headline).toBe("{name} added a new device. Verify the safety number");
  });

  test("accepting the device resolves the line and a later lookup does not bring it back", () => {
    let list = applyTrustEvent([], addedEvent(), ctx(1_000));
    list = applyTrustEvent(list, { type: "acknowledged", userId: "bob" }, ctx(2_000));
    expect(list[0]).toMatchObject({ state: S.RESOLVED, resolution: R.ACCEPTED, resolvedAt: 2_000 });
    const after = applyTrustEvent(list, assessed({ listed: [D1, D2] }), ctx(3_000));
    expect(after).toBe(list);
    expect(describeNotice(list[0]).headline).toBe("You accepted {name}'s new device");
  });

  test("a report that races ahead of the acceptance cannot reopen a resolved line", () => {
    let list = applyTrustEvent([], addedEvent(), ctx());
    list = applyTrustEvent(list, { type: "acknowledged", userId: "bob" }, ctx());
    const stale = applyTrustEvent(list, addedEvent(), ctx());
    expect(stale).toBe(list);
  });

  test("verifying the new number resolves the lines of added and removed devices, un-verifying changes nothing", () => {
    let list = applyTrustEvent([], addedEvent([D2], { verified: true }), ctx());
    list = applyTrustEvent(list, addedEvent([D2], { removed: ["old"], verified: true }), ctx());
    expect(list.map((n) => n.state)).toEqual([S.OPEN, S.OPEN]);
    const same = applyTrustEvent(list, { type: "verified", userId: "bob", verified: false }, ctx());
    expect(same).toBe(list);
    list = applyTrustEvent(list, { type: "verified", userId: "bob", verified: true }, ctx());
    expect(list.map((n) => [n.state, n.resolution])).toEqual([[S.RESOLVED, R.VERIFIED], [S.RESOLVED, R.VERIFIED]]);
    expect(describeNotice(list[0]).headline).toBe("You verified {name}'s new safety number");
  });

  test("a reported device that is no longer pending: accepted when still listed, gone when not", () => {
    const open = applyTrustEvent([], addedEvent([D2]), ctx());
    const accepted = applyTrustEvent(open, assessed({ listed: [D1, D2] }), ctx());
    expect(accepted[0]).toMatchObject({ state: S.RESOLVED, resolution: R.ACCEPTED });
    const gone = applyTrustEvent(open, assessed({ listed: [D1] }), ctx());
    expect(gone[0]).toMatchObject({ state: S.RESOLVED, resolution: R.GONE });
    expect(describeNotice(gone[0]).headline).toBe("{name}'s new device is no longer listed");
  });

  test("a pending device that left the list and then came back is announced again", () => {
    const open = applyTrustEvent([], addedEvent([D2]), ctx());
    const gone = applyTrustEvent(open, assessed({ listed: [D1] }), ctx());
    expect(gone[0]).toMatchObject({ state: S.RESOLVED, resolution: R.GONE });
    const back = applyTrustEvent(gone, addedEvent([D2]), ctx());
    expect(back.filter((n) => n.kind === K.ADDED && n.state === S.OPEN)).toHaveLength(1);
  });

  test("a removed device makes one line, reported once, that can be dismissed at once", () => {
    let list = applyTrustEvent([], assessed({ removed: [D2] }), ctx());
    expect(list[0]).toMatchObject({ kind: K.REMOVED, state: S.OPEN, deviceIds: [D2] });
    expect(isDismissible(list[0])).toBe(true);
    expect(applyTrustEvent(list, assessed({ removed: [D2] }), ctx())).toBe(list);
    expect(describeNotice(list[0]).headline).toBe("{name} removed a device. Verify the safety number");
    list = applyTrustEvent([], assessed({ removed: [D2], verified: true }), ctx());
    expect(describeNotice(list[0])).toMatchObject({ severity: "danger", headline: "Safety number changed" });
  });

  test("changed keys for a known device are an open red line until the keys are consistent again", () => {
    const mismatch = assessed({ status: TRUST.KEY_MISMATCH, mismatched: [D1] });
    let list = applyTrustEvent([], mismatch, ctx(1_000));
    expect(list[0]).toMatchObject({ kind: K.MISMATCH, state: S.OPEN, deviceIds: [D1] });
    expect(severityOf(list[0])).toBe("danger");
    expect(isDismissible(list[0])).toBe(false);
    expect(applyTrustEvent(list, mismatch, ctx())).toBe(list);
    // Verifying does not make conflicting keys harmless.
    expect(applyTrustEvent(list, { type: "verified", userId: "bob", verified: true }, ctx())).toBe(list);
    list = applyTrustEvent(list, assessed(), ctx(2_000));
    expect(list[0]).toMatchObject({ state: S.RESOLVED, resolution: R.CLEARED });
    expect(isDismissible(list[0])).toBe(true);
    // The conflict returning later is a new incident, not the old line back.
    list = applyTrustEvent(list, mismatch, ctx(3_000));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: S.OPEN, at: 3_000 });
  });

  test("an open line about a new device cannot be dismissed, a resolved one can", () => {
    const open = applyTrustEvent([], addedEvent(), ctx())[0];
    expect(isDismissible(open)).toBe(false);
    expect(isDismissible({ ...open, state: S.RESOLVED })).toBe(true);
  });

  test("keeps at most 30 lines, dropping finished ones first, then the oldest", () => {
    let list = [];
    for (let i = 0; i < MAX_NOTICES_PER_CONTACT + 5; i += 1) {
      list = applyTrustEvent(list, assessed({ removed: [`r${i}`] }), ctx(1_000 + i));
    }
    expect(list).toHaveLength(MAX_NOTICES_PER_CONTACT);
    expect(list[0].deviceIds).toEqual(["r5"]);

    let mixed = applyTrustEvent([], addedEvent([D2]), ctx(1));
    mixed = applyTrustEvent(mixed, { type: "acknowledged", userId: "bob" }, ctx(2));
    for (let i = 0; i < MAX_NOTICES_PER_CONTACT; i += 1) {
      mixed = applyTrustEvent(mixed, assessed({ removed: [`x${i}`] }), ctx(10 + i));
    }
    expect(mixed).toHaveLength(MAX_NOTICES_PER_CONTACT);
    expect(mixed.some((n) => n.kind === K.ADDED)).toBe(false);
  });

  test("hostile or empty events change nothing", () => {
    const start = [];
    for (const event of [null, undefined, 5, "x", {}, { type: "assessed" }, { type: "unknown", userId: "bob" }, { type: "verified" }]) {
      expect(applyTrustEvent(start, event, ctx())).toBe(start);
    }
    const weird = applyTrustEvent(start, addedEvent([D2, 5, null, D2]), ctx());
    expect(weird[0].deviceIds).toEqual(["5", "d2", "null"]);
  });
});

describe("the words", () => {
  const base = { kind: K.ADDED, state: S.OPEN, resolution: null, verified: false, count: 1, deviceIds: [D2] };

  test("the plain sentence names the contact", () => {
    expect(noticePlainText(base, "Alice")).toBe("Alice added a new device. Verify the safety number");
    expect(noticePlainText({ ...base, count: 3 }, "Alice")).toBe("Alice added 3 new devices. Verify the safety number");
    expect(noticePlainText({ ...base, verified: true }, "Alice")).toBe(
      "Safety number changed. Alice added a new device. It is blocked until you verify the new number.",
    );
    expect(noticePlainText({ ...base, verified: true, count: 2 }, "Alice")).toMatch(/added 2 new devices\. They are blocked/);
    expect(noticePlainText({ ...base, kind: K.MISMATCH }, "Alice")).toBe(
      "Alice's security keys changed unexpectedly. Calls and video messages with them are blocked. Check the safety number with them in person.",
    );
    expect(noticePlainText(base, "")).toMatch(/^Your contact added/);
  });
});

describe("sanitizeNotice (storage is not trusted)", () => {
  const good = { id: "abc", kind: K.ADDED, state: S.OPEN, at: 5, deviceIds: [D2], count: 1, verified: true, resolution: null };

  test("keeps a good line and forces the contact to the one it was stored under", () => {
    expect(sanitizeNotice({ ...good, userId: "mallory" }, "bob")).toMatchObject({ ...good, userId: "bob" });
  });

  test("drops anything that is not a line", () => {
    const bad = [
      null, 5, "x", [], {},
      { ...good, id: "" }, { ...good, id: "x".repeat(65) }, { ...good, id: 5 },
      { ...good, kind: "boom" }, { ...good, kind: "__proto__" }, { ...good, state: "weird" },
      { ...good, at: "yesterday" }, { ...good, at: -1 }, { ...good, at: Number.NaN }, { ...good, at: Infinity },
    ];
    for (const raw of bad) expect(sanitizeNotice(raw, "bob"), JSON.stringify(raw)).toBeNull();
  });

  test("cleans the fields of a line it keeps", () => {
    const line = sanitizeNotice(
      { ...good, deviceIds: [D2, 5, null, "x".repeat(100), D1, D2], count: -3, verified: "yes", resolution: "nonsense", resolvedAt: "soon", extra: "<script>" },
      "bob",
    );
    expect(line.deviceIds).toEqual([D1, D2]);
    expect(line.count).toBe(2);
    expect(line.verified).toBe(false);
    expect(line.resolution).toBeNull();
    expect(line).not.toHaveProperty("resolvedAt");
    expect(line).not.toHaveProperty("extra");
  });
});

describe("the store", () => {
  const make = (storage = memoryStorage(), extra = {}) => ({
    storage,
    store: createKeyNoticeStore({ storage, now: () => 5_000, newId: () => `id${(counter += 1)}`, ...extra }),
  });

  test("lines survive a storage that refuses writes or does not exist: they stay as they were, not re-created", () => {
    let n = 0;
    const refusing = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
    for (const storage of [refusing, null]) {
      const store = createKeyNoticeStore({ storage, now: () => (n += 1000), newId: () => `id${(n += 1)}` });
      store.handleTrustEvent("alice", addedEvent());
      const [line] = store.list("alice", "bob");
      expect(line).toMatchObject({ kind: K.ADDED, state: S.OPEN });
      // the next routine lookup (nothing new) keeps the very same line
      store.handleTrustEvent("alice", addedEvent());
      expect(store.list("alice", "bob")).toEqual([line]);
      // a removal that is reported only once is still there after the lookup that follows it
      store.handleTrustEvent("alice", assessed({ removed: [D3], listed: [D1, D2] }));
      store.handleTrustEvent("alice", addedEvent());
      expect(store.list("alice", "bob").some((x) => x.kind === K.REMOVED)).toBe(true);
    }
  });

  test("remembers lines per signed-in person and contact, across a reload", () => {
    const { store, storage } = make();
    store.handleTrustEvent("alice", addedEvent());
    expect(store.list("alice", "bob")).toHaveLength(1);
    expect(store.list("alice", "carol")).toHaveLength(0);
    expect(store.list("dave", "bob")).toHaveLength(0);
    expect([...storage.map.keys()]).toEqual([`${STORAGE_PREFIX}alice:bob`]);

    const reloaded = createKeyNoticeStore({ storage });
    expect(reloaded.list("alice", "bob")).toEqual(store.list("alice", "bob"));
    // The same report after the reload is the same line, not a second one.
    reloaded.handleTrustEvent("alice", addedEvent());
    expect(reloaded.list("alice", "bob")).toHaveLength(1);
  });

  test("the list is the same array until something changes", () => {
    const { store } = make();
    store.handleTrustEvent("alice", addedEvent());
    const first = store.list("alice", "bob");
    expect(store.list("alice", "bob")).toBe(first);
    store.handleTrustEvent("alice", addedEvent());
    expect(store.list("alice", "bob")).toBe(first);
    store.handleTrustEvent("alice", { type: "acknowledged", userId: "bob" });
    expect(store.list("alice", "bob")).not.toBe(first);
  });

  test("tells subscribers about a change, and only a change", () => {
    const { store } = make();
    const seen = vi.fn();
    const stop = store.subscribe(seen);
    store.handleTrustEvent("alice", assessed());
    expect(seen).not.toHaveBeenCalled();
    store.handleTrustEvent("alice", addedEvent());
    store.handleTrustEvent("alice", addedEvent());
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    store.handleTrustEvent("alice", { type: "acknowledged", userId: "bob" });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  test("only a line that may be dismissed is dismissed", () => {
    const { store } = make();
    store.handleTrustEvent("alice", addedEvent());
    const id = store.list("alice", "bob")[0].id;
    store.dismiss("alice", "bob", id);
    expect(store.list("alice", "bob")).toHaveLength(1);
    store.handleTrustEvent("alice", { type: "acknowledged", userId: "bob" });
    store.dismiss("alice", "bob", "nope");
    expect(store.list("alice", "bob")).toHaveLength(1);
    store.dismiss("alice", "bob", id);
    expect(store.list("alice", "bob")).toHaveLength(0);
  });

  test("an empty list is not kept in storage", () => {
    const { store, storage } = make();
    store.handleTrustEvent("alice", assessed({ removed: [D2] }));
    store.dismiss("alice", "bob", store.list("alice", "bob")[0].id);
    expect(storage.map.size).toBe(0);
  });

  test("a storage that fails or has junk in it still works, in memory", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("blocked"); } };
    const { store } = make(broken);
    expect(() => store.handleTrustEvent("alice", addedEvent())).not.toThrow();
    expect(store.list("alice", "bob")).toHaveLength(1);

    for (const junk of ["{", "null", "42", '"x"', '{"a":1}', "[1,2,3]", '[{"id":"x"}]']) {
      const storage = memoryStorage();
      storage.map.set(`${STORAGE_PREFIX}alice:bob`, junk);
      expect(createKeyNoticeStore({ storage }).list("alice", "bob")).toHaveLength(0);
    }
    expect(createKeyNoticeStore({ storage: null }).list("alice", "bob")).toHaveLength(0);
    const none = createKeyNoticeStore({ storage: null, newId: () => "z" });
    none.handleTrustEvent("alice", addedEvent());
    expect(none.list("alice", "bob")).toHaveLength(1);
  });

  test("a change made in another tab is picked up", () => {
    const { store, storage } = make();
    store.handleTrustEvent("alice", addedEvent());
    const other = createKeyNoticeStore({ storage, now: () => 9_000 });
    other.handleTrustEvent("alice", { type: "acknowledged", userId: "bob" });
    expect(store.list("alice", "bob")[0].state).toBe(S.OPEN);
    const seen = vi.fn();
    store.subscribe(seen);
    store.refresh(`${STORAGE_PREFIX}alice:bob`);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.list("alice", "bob")[0].state).toBe(S.RESOLVED);
    store.refresh("something-else");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  test("missing ids are ignored", () => {
    const { store, storage } = make();
    store.handleTrustEvent(null, addedEvent());
    store.handleTrustEvent("alice", { type: "assessed" });
    expect(store.list(null, "bob")).toHaveLength(0);
    expect(storage.map.size).toBe(0);
  });
});

describe("mergeKeyNotices", () => {
  const at = (iso) => Date.parse(iso);
  const msg = (id, iso, extra = {}) => ({ id, created_at: iso, username: "bob", body: id, ...extra });
  const line = (id, iso, extra = {}) => ({
    id, kind: K.ADDED, userId: "bob", at: at(iso), deviceIds: [D2], count: 1, verified: false, state: S.OPEN, resolution: null, ...extra,
  });
  const opts = { chatId: "chat-1", peerName: "Bob", selfUserId: "alice" };

  test("gives the messages back untouched when there is nothing to add", () => {
    const messages = [msg("m1", "2026-03-01T10:00:00Z")];
    expect(mergeKeyNotices(messages, [], opts)).toBe(messages);
    expect(mergeKeyNotices(messages, null, opts)).toBe(messages);
    expect(mergeKeyNotices(messages, [line("a", "2026-03-01T11:00:00Z")], { ...opts, chatId: "" })).toBe(messages);
  });

  test("puts each line where it was noticed, between the messages around it", () => {
    const messages = [
      msg("m1", "2026-03-01T10:00:00Z"),
      msg("m2", "2026-03-01T12:00:00Z"),
      msg("m3", "2026-03-02T09:00:00Z"),
    ];
    const merged = mergeKeyNotices(
      messages,
      [line("late", "2026-03-02T10:00:00Z"), line("mid", "2026-03-01T11:00:00Z"), line("early", "2026-03-01T09:00:00Z")],
      opts,
    );
    expect(merged.map((m) => m.id)).toEqual(["key-notice-early", "m1", "key-notice-mid", "m2", "m3", "key-notice-late"]);
    expect(messages).toHaveLength(3);
  });

  test("a line and a message of the same moment: the message first", () => {
    const merged = mergeKeyNotices([msg("m1", "2026-03-01T10:00:00Z")], [line("a", "2026-03-01T10:00:00Z")], opts);
    expect(merged.map((m) => m.id)).toEqual(["m1", "key-notice-a"]);
  });

  test("shows the line in a chat with no messages yet", () => {
    const merged = mergeKeyNotices([], [line("a", "2026-03-01T10:00:00Z")], opts);
    expect(merged).toHaveLength(1);
  });

  test("a message without a time does not move the lines", () => {
    const merged = mergeKeyNotices(
      [msg("m1", "2026-03-01T10:00:00Z"), { id: "m2", username: "bob" }, msg("m3", "2026-03-01T13:00:00Z")],
      [line("a", "2026-03-01T12:00:00Z")],
      opts,
    );
    expect(merged.map((m) => m.id)).toEqual(["m1", "m2", "key-notice-a", "m3"]);
  });

  test("while older history is still to be loaded, a line older than what is loaded waits", () => {
    const messages = [msg("m1", "2026-03-05T10:00:00Z")];
    const notices = [line("old", "2026-03-01T10:00:00Z"), line("new", "2026-03-06T10:00:00Z")];
    expect(mergeKeyNotices(messages, notices, { ...opts, hasOlderMessages: true }).map((m) => m.id)).toEqual(["m1", "key-notice-new"]);
    expect(mergeKeyNotices(messages, notices, { ...opts, hasOlderMessages: false }).map((m) => m.id)).toEqual(["key-notice-old", "m1", "key-notice-new"]);
  });

  test("the line is a local service line: never a message of the server", () => {
    const [merged] = mergeKeyNotices([], [line("a", "2026-03-01T10:00:00Z", { verified: true })], opts);
    expect(merged).toMatchObject({
      id: "key-notice-a",
      chat_id: "chat-1",
      _localOnly: true,
      _readByMe: true,
      body: "",
      created_at: "2026-03-01T10:00:00.000Z",
    });
    expect(merged._systemEvent).toMatchObject({ type: KEY_CHANGE_EVENT, chatId: "chat-1", selfUserId: "alice" });
    expect(merged._systemEvent.notice).toMatchObject({ id: "a", kind: K.ADDED, severity: "danger", dismissible: false, userId: "bob" });
    expect(merged._systemEvent.text).toMatch(/^Safety number changed\. Bob added a new device/);
    // Service-line behaviour of the rest of the app:
    expect(isServiceMessage(merged)).toBe(true);
    expect(getServerMessageId(merged)).toBeNull();
    expect(isMessageSelectable(merged)).toBe(false);
  });

  test("a line ends a run of one sender's messages, like other service lines", () => {
    const merged = mergeKeyNotices(
      [msg("m1", "2026-03-01T10:00:00Z"), msg("m2", "2026-03-01T10:02:00Z")],
      [line("a", "2026-03-01T10:01:00Z")],
      opts,
    );
    const runs = computeMessageRuns(merged);
    expect(runs.map((r) => [r.isRunStart, r.isRunEnd])).toEqual([[true, true], [true, true], [true, true]]);
  });

  test("the text follows the contact's name and the state of the line", () => {
    const notice = line("a", "2026-03-01T10:00:00Z");
    expect(mergeKeyNotices([], [notice], { ...opts, peerName: "Alice" })[0]._systemEvent.text).toBe("Alice added a new device. Verify the safety number");
    const done = { ...notice, state: S.RESOLVED, resolution: R.VERIFIED };
    const [resolved] = mergeKeyNotices([], [done], { ...opts, peerName: "Alice" });
    expect(resolved._systemEvent.text).toBe("You verified Alice's new safety number");
    expect(resolved._systemEvent.notice.dismissible).toBe(true);
  });
});

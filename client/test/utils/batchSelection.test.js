import { describe, test, expect } from "vitest";
import {
  MAX_BATCH_MESSAGES,
  emptySelection,
  extendToKey,
  getMessageKey,
  orderedSelection,
  pruneKeys,
  selectOnlyKey,
  toggleKey,
} from "../../src/utils/batchSelection.js";

const keys = (n) => Array.from({ length: n }, (_, i) => `m${i + 1}`);

describe("getMessageKey", () => {
  test("is the key the timeline rows use: client id, then server id, then id", () => {
    expect(getMessageKey({ _clientId: "c1", _serverId: "s1", id: "i1" })).toBe("c1");
    expect(getMessageKey({ _serverId: "s1", id: "i1" })).toBe("s1");
    expect(getMessageKey({ id: "i1" })).toBe("i1");
    expect(getMessageKey({})).toBe("");
    expect(getMessageKey(null)).toBe("");
  });
});

describe("toggleKey", () => {
  test("adds a key, makes it the anchor and removes it on the second toggle", () => {
    const first = toggleKey(emptySelection(), "m1");
    expect(first.limited).toBe(false);
    expect(first.state).toEqual({ keys: ["m1"], anchor: "m1" });

    const second = toggleKey(first.state, "m2");
    expect(second.state.keys).toEqual(["m1", "m2"]);
    expect(second.state.anchor).toBe("m2");

    const third = toggleKey(second.state, "m1");
    expect(third.state.keys).toEqual(["m2"]);
    expect(third.state.anchor).toBe("m1");
  });

  test("ignores an empty key", () => {
    const state = emptySelection();
    expect(toggleKey(state, "").state).toBe(state);
    expect(toggleKey(state, null).state).toBe(state);
  });

  test("refuses the key after the limit and says so", () => {
    let state = emptySelection();
    keys(3).forEach((key) => {
      state = toggleKey(state, key, { limit: 3 }).state;
    });
    const result = toggleKey(state, "m4", { limit: 3 });
    expect(result.limited).toBe(true);
    expect(result.state).toBe(state);
    // taking one off is always possible at the limit
    expect(toggleKey(state, "m2", { limit: 3 }).state.keys).toEqual(["m1", "m3"]);
  });

  test("the default limit is 100 messages", () => {
    expect(MAX_BATCH_MESSAGES).toBe(100);
    let state = emptySelection();
    keys(100).forEach((key) => {
      state = toggleKey(state, key).state;
    });
    expect(state.keys).toHaveLength(100);
    expect(toggleKey(state, "extra").limited).toBe(true);
  });
});

describe("selectOnlyKey", () => {
  test("is a selection of one that is also the anchor", () => {
    expect(selectOnlyKey("m7")).toEqual({ keys: ["m7"], anchor: "m7" });
    expect(selectOnlyKey("")).toEqual(emptySelection());
  });
});

describe("extendToKey (shift click)", () => {
  const all = keys(10);

  test("selects everything between the anchor and the target, forward", () => {
    const start = selectOnlyKey("m3");
    const { state, limited } = extendToKey(start, all, "m6");
    expect(limited).toBe(false);
    expect(state.keys).toEqual(["m3", "m4", "m5", "m6"]);
  });

  test("and backward", () => {
    const start = selectOnlyKey("m6");
    const { state } = extendToKey(start, all, "m3");
    expect([...state.keys].sort()).toEqual(["m3", "m4", "m5", "m6"]);
  });

  test("keeps what was already selected and keeps the anchor", () => {
    let state = selectOnlyKey("m1");
    state = toggleKey(state, "m8").state; // anchor m8
    const result = extendToKey(state, all, "m6");
    expect(result.state.keys).toEqual(expect.arrayContaining(["m1", "m8", "m6", "m7"]));
    expect(result.state.anchor).toBe("m8");
  });

  test("with no anchor it selects just the target and anchors there", () => {
    const { state } = extendToKey(emptySelection(), all, "m4");
    expect(state).toEqual({ keys: ["m4"], anchor: "m4" });
  });

  test("an anchor that is not in the list (deleted) counts as no anchor", () => {
    const start = { keys: ["gone"], anchor: "gone" };
    const { state } = extendToKey(start, all, "m4");
    expect(state.keys).toEqual(["gone", "m4"]);
    expect(state.anchor).toBe("m4");
  });

  test("a target outside the list changes nothing", () => {
    const start = selectOnlyKey("m3");
    expect(extendToKey(start, all, "nope").state).toBe(start);
  });

  test("stops at the limit, counting from the anchor, and says so", () => {
    const start = selectOnlyKey("m1");
    const { state, limited } = extendToKey(start, all, "m10", { limit: 4 });
    expect(limited).toBe(true);
    expect(state.keys).toEqual(["m1", "m2", "m3", "m4"]);
    expect(state.anchor).toBe("m1");
  });

  test("a range that is already selected is not a change", () => {
    const start = { keys: ["m3", "m4", "m5"], anchor: "m3" };
    const result = extendToKey(start, all, "m5");
    expect(result.limited).toBe(false);
    expect(result.state).toBe(start);
  });
});

describe("pruneKeys", () => {
  test("drops the keys whose messages are gone", () => {
    const state = { keys: ["m1", "m2", "m3"], anchor: "m3" };
    const next = pruneKeys(state, new Set(["m1", "m3"]));
    expect(next.keys).toEqual(["m1", "m3"]);
    expect(next.anchor).toBe("m3");
  });

  test("moves the anchor off a message that is gone", () => {
    const state = { keys: ["m1", "m2"], anchor: "m2" };
    expect(pruneKeys(state, new Set(["m1"]))).toEqual({ keys: ["m1"], anchor: "m1" });
    expect(pruneKeys(state, new Set())).toEqual(emptySelection());
  });

  test("returns the same object when nothing was dropped", () => {
    const state = { keys: ["m1"], anchor: "m1" };
    expect(pruneKeys(state, new Set(["m1", "m2"]))).toBe(state);
  });
});

describe("orderedSelection", () => {
  test("lists the selected keys in chat order, whatever order they were clicked in", () => {
    let state = emptySelection();
    ["m5", "m2", "m9", "m1"].forEach((key) => {
      state = toggleKey(state, key).state;
    });
    expect(orderedSelection(state, keys(10))).toEqual(["m1", "m2", "m5", "m9"]);
  });

  test("leaves out keys that are not in the list", () => {
    const state = { keys: ["m2", "ghost"], anchor: "m2" };
    expect(orderedSelection(state, keys(3))).toEqual(["m2"]);
  });
});

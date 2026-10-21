import { describe, test, expect, vi } from "vitest";
import { createBatchSelectionStore } from "../../src/utils/batchSelectionStore.js";

const keys = (n) => Array.from({ length: n }, (_, i) => `m${i + 1}`);

describe("batch selection store", () => {
  test("starts idle", () => {
    const store = createBatchSelectionStore();
    expect(store.getSnapshot()).toEqual({ chatId: null, active: false, keys: [], anchor: null });
  });

  test("enter starts selection mode with that message ticked", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m3");
    expect(store.getSnapshot()).toEqual({
      chatId: "chat-1",
      active: true,
      keys: ["m3"],
      anchor: "m3",
    });
  });

  test("entering again in the same chat ticks one more message and keeps the others", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m3");
    store.enter("chat-1", "m5");
    expect(store.getSnapshot().keys).toEqual(["m3", "m5"]);
  });

  test("entering in another chat starts over", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m3");
    store.enter("chat-2", "x1");
    expect(store.getSnapshot()).toMatchObject({ chatId: "chat-2", keys: ["x1"] });
  });

  test("toggle ticks and unticks; unticking the last message ends selection mode", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m1");
    store.toggle("m2");
    expect(store.getSnapshot().keys).toEqual(["m1", "m2"]);
    store.toggle("m1");
    store.toggle("m2");
    expect(store.getSnapshot()).toEqual({ chatId: null, active: false, keys: [], anchor: null });
  });

  test("toggle does nothing while idle", () => {
    const store = createBatchSelectionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.toggle("m1")).toEqual({ limited: false });
    expect(store.getSnapshot().active).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  test("toggle reports the limit", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m1");
    expect(store.toggle("m2", { limit: 2 }).limited).toBe(false);
    const result = store.toggle("m3", { limit: 2 });
    expect(result.limited).toBe(true);
    expect(store.getSnapshot().keys).toEqual(["m1", "m2"]);
  });

  test("extendTo ticks a range from the last ticked message", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m2");
    const result = store.extendTo(keys(8), "m5");
    expect(result.limited).toBe(false);
    expect(store.getSnapshot().keys).toEqual(["m2", "m3", "m4", "m5"]);
    expect(store.getSnapshot().anchor).toBe("m2");
  });

  test("exit clears everything", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m1");
    store.exit();
    expect(store.getSnapshot()).toEqual({ chatId: null, active: false, keys: [], anchor: null });
  });

  test("bindChat ends selection mode when the open chat is another one", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m1");
    store.bindChat("chat-1");
    expect(store.getSnapshot().active).toBe(true);
    store.bindChat("chat-2");
    expect(store.getSnapshot().active).toBe(false);
  });

  test("bindChat(null) (the chat was left) ends selection mode", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m1");
    store.bindChat(null);
    expect(store.getSnapshot().active).toBe(false);
  });

  test("prune forgets deleted messages and ends selection mode when none is left", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m1");
    store.toggle("m2");
    store.prune(new Set(["m2", "m9"]));
    expect(store.getSnapshot().keys).toEqual(["m2"]);
    store.prune(new Set(["m9"]));
    expect(store.getSnapshot().active).toBe(false);
  });

  test("an unchanged prune does not notify", () => {
    const store = createBatchSelectionStore();
    store.enter("chat-1", "m1");
    const listener = vi.fn();
    store.subscribe(listener);
    store.prune(new Set(["m1", "m2"]));
    expect(listener).not.toHaveBeenCalled();
  });

  test("subscribers hear about changes and can unsubscribe; the snapshot is stable between changes", () => {
    const store = createBatchSelectionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.enter("chat-1", "m1");
    expect(listener).toHaveBeenCalledTimes(1);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    unsubscribe();
    store.toggle("m2");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

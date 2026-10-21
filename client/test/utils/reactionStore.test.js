import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/api/reactionsApi.js", () => ({
  reactToMessage: vi.fn(),
  listMessageReactors: vi.fn(),
}));
vi.mock("../../src/utils/toast.js", () => ({ showToast: vi.fn() }));

import { reactToMessage } from "../../src/api/reactionsApi.js";
import { SHOW_REACTORS_EVENT } from "../../src/utils/reactions.js";
import { showToast } from "../../src/utils/toast.js";
import {
  applyRealtimeReaction,
  bindReactionStoreToUser,
  getMaxReactionsPerUser,
  getReactionEntry,
  getReactionList,
  getReactionsForCache,
  requestShowReactors,
  resetReactionStore,
  seedReactions,
  setMaxReactionsPerUser,
  subscribeToReactions,
  syncReactionsFromServer,
  toggleReaction,
} from "../../src/utils/reactionStore.js";

const ME = "11111111-1111-4111-a111-111111111111";
const BOB = "22222222-2222-4222-a222-222222222222";
const CHAT = "44444444-4444-4444-a444-444444444444";
const M1 = "33333333-3333-4333-a333-333333333331";
const M2 = "33333333-3333-4333-a333-333333333332";

const UP = "\u{1F44D}";
const FIRE = "\u{1F525}";
const HEART = "❤️";

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  resetReactionStore();
  vi.mocked(reactToMessage).mockReset();
  vi.mocked(showToast).mockReset();
});

describe("seedReactions", () => {
  test("a message with reactions starts with them", () => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 2, reacted: true }] }]);
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 2, reacted: true }]);
  });

  test("a message without reactions is not remembered", () => {
    seedReactions([{ id: M1, reactions: [] }, { id: M2 }]);
    expect(getReactionEntry(M1)).toBeNull();
    expect(getReactionList(M1)).toEqual([]);
  });

  test("what we know is never replaced by an older list", () => {
    applyRealtimeReaction({ messageId: M1, counts: [{ emoji: FIRE, count: 1 }], actorId: ME, actorEmoji: FIRE, removedEmojis: [] }, ME);
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 9, reacted: true }] }]);
    expect(getReactionList(M1)).toEqual([{ emoji: FIRE, count: 1, reacted: true }]);
  });

  test("messages that are only local are skipped", () => {
    seedReactions([{ _clientId: "abc", reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    expect(getReactionList("abc")).toEqual([]);
  });
});

describe("syncReactionsFromServer", () => {
  test("a fresh list replaces what we had", () => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    syncReactionsFromServer([{ id: M1, reactions: [{ emoji: FIRE, count: 4, reacted: false }] }], { startedAt: Date.now() + 1000 });
    expect(getReactionList(M1)).toEqual([{ emoji: FIRE, count: 4, reacted: false }]);
  });

  test("a message with no reactions any more loses its chips", () => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    syncReactionsFromServer([{ id: M1, reactions: [] }], { startedAt: Date.now() + 1000 });
    expect(getReactionList(M1)).toEqual([]);
  });

  test("an answer older than an event we already applied does not undo it", () => {
    const startedAt = Date.now() - 50;
    applyRealtimeReaction({ messageId: M1, counts: [{ emoji: UP, count: 5 }], actorId: BOB, actorEmoji: UP, removedEmojis: [] }, ME);
    syncReactionsFromServer([{ id: M1, reactions: [{ emoji: UP, count: 4, reacted: false }] }], { startedAt });
    expect(getReactionList(M1)[0].count).toBe(5);
  });

  test("a message that never had reactions stays out of the store", () => {
    syncReactionsFromServer([{ id: M1, reactions: [] }]);
    expect(getReactionEntry(M1)).toBeNull();
  });
});

describe("applyRealtimeReaction", () => {
  test("works for a message nobody has drawn", () => {
    applyRealtimeReaction({ messageId: M2, counts: [{ emoji: UP, count: 1 }], actorId: BOB, actorEmoji: UP, removedEmojis: [] }, ME);
    expect(getReactionList(M2)).toEqual([{ emoji: UP, count: 1, reacted: false }]);
  });

  test("the list that comes later tells which one is mine, without touching the counts", () => {
    applyRealtimeReaction({ messageId: M2, counts: [{ emoji: UP, count: 3 }], actorId: BOB, actorEmoji: UP, removedEmojis: [] }, ME);
    seedReactions([{ id: M2, reactions: [{ emoji: UP, count: 2, reacted: true }] }]);
    expect(getReactionList(M2)).toEqual([{ emoji: UP, count: 3, reacted: true }]);
  });

  test("ignores events without a message id or counts", () => {
    applyRealtimeReaction({ counts: [] }, ME);
    applyRealtimeReaction({ messageId: M1 }, ME);
    expect(getReactionEntry(M1)).toBeNull();
  });

  test("an event that changes nothing does not wake the chips", () => {
    const payload = { messageId: M1, counts: [{ emoji: UP, count: 1 }], actorId: BOB, actorEmoji: UP, removedEmojis: [] };
    applyRealtimeReaction(payload, ME);
    const listener = vi.fn();
    subscribeToReactions(M1, listener);
    applyRealtimeReaction(payload, ME);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("subscriptions", () => {
  test("only the message that changed is told", () => {
    const one = vi.fn();
    const two = vi.fn();
    subscribeToReactions(M1, one);
    subscribeToReactions(M2, two);
    applyRealtimeReaction({ messageId: M1, counts: [{ emoji: UP, count: 1 }], actorId: BOB, actorEmoji: UP, removedEmojis: [] }, ME);
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).not.toHaveBeenCalled();
  });

  test("the list is the same object until something changes", () => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: false }] }]);
    expect(getReactionList(M1)).toBe(getReactionList(M1));
    expect(getReactionList(M2)).toBe(getReactionList("nope"));
  });

  test("unsubscribing stops the calls", () => {
    const listener = vi.fn();
    const off = subscribeToReactions(M1, listener);
    off();
    applyRealtimeReaction({ messageId: M1, counts: [{ emoji: UP, count: 1 }], actorId: BOB }, ME);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the limit per person", () => {
  test("defaults to 1 and is clamped to 1 to 3", () => {
    expect(getMaxReactionsPerUser()).toBe(1);
    setMaxReactionsPerUser(2);
    expect(getMaxReactionsPerUser()).toBe(2);
    setMaxReactionsPerUser(50);
    expect(getMaxReactionsPerUser()).toBe(3);
    setMaxReactionsPerUser(undefined);
    expect(getMaxReactionsPerUser()).toBe(1);
  });
});

describe("toggleReaction", () => {
  test("changes the chips at once and settles on the server's summary", async () => {
    let resolve;
    vi.mocked(reactToMessage).mockReturnValue(new Promise((r) => (resolve = r)));
    const done = toggleReaction({ chatId: CHAT, messageId: M1, emoji: UP });
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 1, reacted: true }]);
    resolve(reply(200, { messageId: M1, reactions: [{ emoji: UP, count: 3, reacted: true }] }));
    await expect(done).resolves.toEqual({ ok: true, status: 200 });
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 3, reacted: true }]);
    expect(reactToMessage).toHaveBeenCalledWith({ chatId: CHAT, messageId: M1, emoji: UP });
  });

  test("sends the emoji in the server's spelling", async () => {
    vi.mocked(reactToMessage).mockResolvedValue(reply(200, { reactions: [] }));
    await toggleReaction({ chatId: CHAT, messageId: M1, emoji: "❤" });
    expect(reactToMessage).toHaveBeenCalledWith({ chatId: CHAT, messageId: M1, emoji: HEART });
  });

  test("tapping my chip again removes it", async () => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    vi.mocked(reactToMessage).mockResolvedValue(reply(200, { reactions: [] }));
    const done = toggleReaction({ chatId: CHAT, messageId: M1, emoji: UP });
    expect(getReactionList(M1)).toEqual([]);
    await done;
    expect(getReactionList(M1)).toEqual([]);
  });

  test("another emoji replaces mine when one is the limit", async () => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    vi.mocked(reactToMessage).mockResolvedValue(reply(200, { reactions: [{ emoji: FIRE, count: 1, reacted: true }] }));
    const done = toggleReaction({ chatId: CHAT, messageId: M1, emoji: FIRE });
    expect(getReactionList(M1)).toEqual([{ emoji: FIRE, count: 1, reacted: true }]);
    await done;
  });

  test("with a limit of two it adds a second reaction", async () => {
    setMaxReactionsPerUser(2);
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    vi.mocked(reactToMessage).mockResolvedValue(reply(200, { reactions: [] }));
    const done = toggleReaction({ chatId: CHAT, messageId: M1, emoji: FIRE });
    expect(getReactionList(M1)).toEqual([
      { emoji: UP, count: 1, reacted: true },
      { emoji: FIRE, count: 1, reacted: true },
    ]);
    await done;
  });

  test.each([
    [429, /slow down/i],
    [404, /no longer available/i],
    [403, /can't react/i],
  ])("a %i answer undoes the tap and says why", async (status, text) => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 2, reacted: true }] }]);
    vi.mocked(reactToMessage).mockResolvedValue(reply(status, { error: "x" }));
    const result = await toggleReaction({ chatId: CHAT, messageId: M1, emoji: FIRE });
    expect(result).toEqual({ ok: false, status });
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 2, reacted: true }]);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(text));
  });

  test("another failure shows the server's own words", async () => {
    vi.mocked(reactToMessage).mockResolvedValue(reply(400, { error: "Reactions are not available for this message." }));
    await toggleReaction({ chatId: CHAT, messageId: M1, emoji: UP });
    expect(getReactionList(M1)).toEqual([]);
    expect(showToast).toHaveBeenCalledWith("Reactions are not available for this message.");
  });

  test("a lost connection undoes the tap", async () => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    vi.mocked(reactToMessage).mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await toggleReaction({ chatId: CHAT, messageId: M1, emoji: UP });
    expect(result.ok).toBe(false);
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 1, reacted: true }]);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/connection/i));
  });

  test("taps on one message are sent one after the other, and only the last answer settles it", async () => {
    const order = [];
    const resolvers = [];
    vi.mocked(reactToMessage).mockImplementation(({ emoji }) => {
      order.push(`start ${emoji}`);
      return new Promise((r) => resolvers.push(() => (order.push(`end ${emoji}`), r(reply(200, { reactions: emoji === HEART ? [{ emoji: HEART, count: 1, reacted: true }] : [] })))));
    });
    const first = toggleReaction({ chatId: CHAT, messageId: M1, emoji: UP });
    const second = toggleReaction({ chatId: CHAT, messageId: M1, emoji: HEART });
    expect(getReactionList(M1)).toEqual([{ emoji: HEART, count: 1, reacted: true }]);
    await Promise.resolve();
    expect(order).toEqual(["start \u{1F44D}"]);
    resolvers[0]();
    await first;
    await Promise.resolve();
    expect(order).toEqual(["start \u{1F44D}", "end \u{1F44D}", `start ${HEART}`]);
    resolvers[1]();
    await second;
    expect(getReactionList(M1)).toEqual([{ emoji: HEART, count: 1, reacted: true }]);
  });

  test("refuses an id that is not a message id", async () => {
    await expect(toggleReaction({ chatId: CHAT, messageId: "local-1", emoji: UP })).resolves.toEqual({ ok: false, status: 400 });
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  test("an older answer from the list does not overwrite a tap on its way", async () => {
    let resolve;
    vi.mocked(reactToMessage).mockReturnValue(new Promise((r) => (resolve = r)));
    const done = toggleReaction({ chatId: CHAT, messageId: M1, emoji: UP });
    syncReactionsFromServer([{ id: M1, reactions: [] }], { startedAt: Date.now() + 5000 });
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 1, reacted: true }]);
    resolve(reply(200, { reactions: [{ emoji: UP, count: 1, reacted: true }] }));
    await done;
  });
});

describe("getReactionsForCache", () => {
  test("gives the list we hold, once we know which are mine", () => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 2, reacted: true }] }]);
    expect(getReactionsForCache(M1)).toEqual([{ emoji: UP, count: 2, reacted: true }]);
  });
  test("leaves the message's own list alone when we only know counts, or nothing", () => {
    applyRealtimeReaction({ messageId: M2, counts: [{ emoji: UP, count: 1 }], actorId: BOB }, ME);
    expect(getReactionsForCache(M2)).toBeNull();
    expect(getReactionsForCache(M1)).toBeNull();
  });
});

describe("requestShowReactors", () => {
  test("tells the chips of that message to open the list", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    try {
      const seen = [];
      target.addEventListener(SHOW_REACTORS_EVENT, (event) => seen.push(event.detail));
      requestShowReactors(M1.toUpperCase(), UP);
      requestShowReactors("not an id");
      expect(seen).toEqual([{ messageId: M1, emoji: UP }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("bindReactionStoreToUser", () => {
  const ref = { items: [{ emoji: UP, count: 1 }] };

  test("the first person to sign in keeps what was already known", () => {
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    bindReactionStoreToUser(ME);
    expect(getReactionEntry(M1)).toMatchObject({ ...ref, mine: [UP] });
  });

  test("the same person again changes nothing", () => {
    bindReactionStoreToUser(ME);
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    bindReactionStoreToUser(ME.toUpperCase());
    expect(getReactionList(M1)).toEqual([{ emoji: UP, count: 1, reacted: true }]);
  });

  test("another person signing in without a reload forgets whose flags those were, and wakes the chips", () => {
    bindReactionStoreToUser(ME);
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    const wake = vi.fn();
    subscribeToReactions(M1, wake);
    bindReactionStoreToUser(BOB);
    expect(getReactionEntry(M1)).toBeNull();
    expect(getReactionList(M1)).toEqual([]);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("signing out and in as the same person starts clean too", () => {
    bindReactionStoreToUser(ME);
    seedReactions([{ id: M1, reactions: [{ emoji: UP, count: 1, reacted: true }] }]);
    bindReactionStoreToUser(null);
    bindReactionStoreToUser(BOB);
    expect(getReactionEntry(M1)).toBeNull();
  });
});

import { describe, test, expect } from "vitest";
import {
  HEART_REACTION,
  QUICK_REACTIONS,
  applyDelta,
  applyReactionEvent,
  applyServerSummary,
  applyToggle,
  buildReactorRows,
  canListReactors,
  canReactToMessage,
  canonicalizeEmoji,
  clampMaxReactions,
  entryFromList,
  getReactionMessageId,
  listFromEntry,
  normalizeReactionList,
  normalizeReactorGroups,
  planReactionChange,
  reactionAriaLabel,
  reactionErrorMessage,
  reactorsErrorMessage,
  replaceEntry,
  revertToggle,
  seedEntry,
} from "../../src/utils/reactions.js";

const ME = "11111111-1111-4111-a111-111111111111";
const BOB = "22222222-2222-4222-a222-222222222222";
const MSG = "33333333-3333-4333-a333-333333333333";

const UP = "\u{1F44D}";
const FIRE = "\u{1F525}";
const HEART = "❤️";

describe("quick reactions", () => {
  test("are the seven Telegram offers, the heart among them", () => {
    expect(QUICK_REACTIONS).toHaveLength(7);
    expect(QUICK_REACTIONS).toContain(HEART_REACTION);
    expect(new Set(QUICK_REACTIONS).size).toBe(7);
  });
});

describe("canonicalizeEmoji", () => {
  test("a text-style heart gets the emoji variation selector, like on the server", () => {
    expect(canonicalizeEmoji("❤")).toBe(HEART);
    expect(canonicalizeEmoji(HEART)).toBe(HEART);
  });
  test("emoji that are emoji already are left alone", () => {
    expect(canonicalizeEmoji(UP)).toBe(UP);
    expect(canonicalizeEmoji("\u{1F44D}\u{1F3FD}")).toBe("\u{1F44D}\u{1F3FD}");
    expect(canonicalizeEmoji("\u{1F1E9}\u{1F1EA}")).toBe("\u{1F1E9}\u{1F1EA}");
  });
  test("a keycap gets its selector", () => {
    expect(canonicalizeEmoji("1⃣")).toBe("1️⃣");
  });
});

describe("clampMaxReactions", () => {
  test("keeps 1 to 3 and defaults to 1", () => {
    expect(clampMaxReactions(2)).toBe(2);
    expect(clampMaxReactions(0)).toBe(1);
    expect(clampMaxReactions(9)).toBe(3);
    expect(clampMaxReactions("2")).toBe(2);
    expect(clampMaxReactions(undefined)).toBe(1);
    expect(clampMaxReactions(NaN)).toBe(1);
  });
});

describe("normalizeReactionList", () => {
  test("drops junk, empty counts and repeated emoji", () => {
    const list = normalizeReactionList([
      { emoji: UP, count: 2, reacted: true },
      { emoji: UP, count: 5 },
      { emoji: "", count: 1 },
      { emoji: FIRE, count: 0 },
      { emoji: "x".repeat(40), count: 1 },
      null,
      { emoji: HEART, count: "3" },
    ]);
    expect(list).toEqual([
      { emoji: UP, count: 2, reacted: true },
      { emoji: HEART, count: 3, reacted: false },
    ]);
  });
  test("anything that is not a list is an empty one", () => {
    expect(normalizeReactionList(undefined)).toEqual([]);
    expect(normalizeReactionList({})).toEqual([]);
  });
});

describe("entries and lists", () => {
  const list = [
    { emoji: UP, count: 3, reacted: true },
    { emoji: FIRE, count: 1, reacted: false },
  ];
  test("round trip a server list", () => {
    const entry = entryFromList(list);
    expect(entry).toEqual({
      items: [
        { emoji: UP, count: 3 },
        { emoji: FIRE, count: 1 },
      ],
      mine: [UP],
      mineKnown: true,
    });
    expect(listFromEntry(entry)).toEqual(list);
  });
  test("no entry is an empty list", () => {
    expect(listFromEntry(undefined)).toEqual([]);
  });
  test("replacing keeps the order the person reacted in", () => {
    const before = { items: [], mine: [FIRE, UP], mineKnown: true };
    const next = replaceEntry(before, [
      { emoji: UP, count: 2, reacted: true },
      { emoji: FIRE, count: 1, reacted: true },
      { emoji: HEART, count: 1, reacted: true },
    ]);
    expect(next.mine).toEqual([FIRE, UP, HEART]);
  });
  test("replacing forgets a reaction the server no longer has as mine", () => {
    const before = { items: [], mine: [FIRE, UP], mineKnown: true };
    const next = replaceEntry(before, [{ emoji: UP, count: 2, reacted: true }]);
    expect(next.mine).toEqual([UP]);
  });
});

describe("seedEntry", () => {
  test("builds an entry when there is none", () => {
    expect(seedEntry(undefined, [{ emoji: UP, count: 1, reacted: true }]).mine).toEqual([UP]);
  });
  test("never replaces what we know with an older list", () => {
    const known = { items: [{ emoji: UP, count: 5 }], mine: [], mineKnown: true };
    const seeded = seedEntry(known, [{ emoji: UP, count: 1, reacted: true }]);
    expect(seeded).toBe(known);
  });
  test("an entry built from an event alone learns which reactions are mine, keeping its counts", () => {
    const fromEvent = { items: [{ emoji: UP, count: 4 }, { emoji: FIRE, count: 1 }], mine: [], mineKnown: false };
    const seeded = seedEntry(fromEvent, [
      { emoji: UP, count: 3, reacted: true },
      { emoji: HEART, count: 1, reacted: true }, // gone since
    ]);
    expect(seeded.items).toEqual(fromEvent.items);
    expect(seeded.mine).toEqual([UP]);
    expect(seeded.mineKnown).toBe(true);
  });
});

describe("applyReactionEvent", () => {
  const known = entryFromList([
    { emoji: UP, count: 1, reacted: true },
    { emoji: FIRE, count: 1, reacted: false },
  ]);

  test("another person's reaction changes the numbers and leaves my flags alone", () => {
    const next = applyReactionEvent(
      known,
      {
        counts: [
          { emoji: UP, count: 2 },
          { emoji: FIRE, count: 1 },
        ],
        actorId: BOB,
        actorEmoji: UP,
        removedEmoji: null,
        removedEmojis: [],
      },
      ME,
    );
    expect(listFromEntry(next)).toEqual([
      { emoji: UP, count: 2, reacted: true },
      { emoji: FIRE, count: 1, reacted: false },
    ]);
  });

  test("another person removing the emoji I also used does not unset mine", () => {
    const next = applyReactionEvent(
      known,
      { counts: [{ emoji: UP, count: 1 }], actorId: BOB, actorEmoji: null, removedEmoji: FIRE, removedEmojis: [FIRE] },
      ME,
    );
    expect(listFromEntry(next)).toEqual([{ emoji: UP, count: 1, reacted: true }]);
  });

  test("my own reaction (from another device) sets my flag and clears the ones it replaced", () => {
    const next = applyReactionEvent(
      known,
      {
        counts: [
          { emoji: FIRE, count: 2 },
        ],
        actorId: ME,
        actorEmoji: FIRE,
        removedEmoji: UP,
        removedEmojis: [UP],
      },
      ME,
    );
    expect(listFromEntry(next)).toEqual([{ emoji: FIRE, count: 2, reacted: true }]);
  });

  test("my own removal clears my flag; the actor id match ignores case", () => {
    const next = applyReactionEvent(
      known,
      {
        counts: [{ emoji: FIRE, count: 1 }],
        actorId: ME.toUpperCase(),
        actorEmoji: null,
        removedEmoji: UP,
        removedEmojis: [UP],
      },
      ME,
    );
    expect(listFromEntry(next)).toEqual([{ emoji: FIRE, count: 1, reacted: false }]);
  });

  test("falls back to removedEmoji when removedEmojis is missing", () => {
    const next = applyReactionEvent(
      known,
      { counts: [{ emoji: FIRE, count: 1 }], actorId: ME, actorEmoji: null, removedEmoji: UP },
      ME,
    );
    expect(next.mine).toEqual([]);
  });

  test("a channel event without actor fields changes the numbers only", () => {
    const next = applyReactionEvent(
      known,
      { counts: [{ emoji: UP, count: 7 }] },
      ME,
    );
    expect(listFromEntry(next)).toEqual([{ emoji: UP, count: 7, reacted: true }]);
  });

  test("no reactions left is an empty list", () => {
    const next = applyReactionEvent(known, { counts: [], actorId: ME, actorEmoji: null, removedEmojis: [UP] }, ME);
    expect(listFromEntry(next)).toEqual([]);
  });

  test("a message we never saw gets counts without any flag, and says so", () => {
    const next = applyReactionEvent(
      undefined,
      { counts: [{ emoji: UP, count: 1 }], actorId: BOB, actorEmoji: UP, removedEmojis: [] },
      ME,
    );
    expect(next.mineKnown).toBe(false);
    expect(listFromEntry(next)).toEqual([{ emoji: UP, count: 1, reacted: false }]);
  });

  test("a message we never saw, reacted to by me elsewhere, shows my flag", () => {
    const next = applyReactionEvent(
      undefined,
      { counts: [{ emoji: UP, count: 1 }], actorId: ME, actorEmoji: UP, removedEmojis: [] },
      ME,
    );
    expect(listFromEntry(next)).toEqual([{ emoji: UP, count: 1, reacted: true }]);
  });

  test("a flag cannot outlive its reaction", () => {
    const next = applyReactionEvent(known, { counts: [{ emoji: FIRE, count: 3 }], actorId: BOB }, ME);
    expect(next.mine).toEqual([]);
  });

  test("does not change the entry it was given", () => {
    const snapshot = JSON.stringify(known);
    applyReactionEvent(known, { counts: [], actorId: ME, removedEmojis: [UP] }, ME);
    expect(JSON.stringify(known)).toBe(snapshot);
  });
});

describe("applyServerSummary", () => {
  test("takes the answer as the truth", () => {
    const next = applyServerSummary(undefined, [{ emoji: HEART, count: 2, reacted: true }]);
    expect(listFromEntry(next)).toEqual([{ emoji: HEART, count: 2, reacted: true }]);
  });
});

describe("planReactionChange", () => {
  test("the same emoji again removes it", () => {
    expect(planReactionChange([UP], UP, 1)).toEqual({ add: null, remove: [UP] });
  });
  test("with a limit of 1 another emoji replaces the old one", () => {
    expect(planReactionChange([UP], FIRE, 1)).toEqual({ add: FIRE, remove: [UP] });
  });
  test("with a limit of 2 it adds a second one, then replaces the oldest", () => {
    expect(planReactionChange([UP], FIRE, 2)).toEqual({ add: FIRE, remove: [] });
    expect(planReactionChange([UP, FIRE], HEART, 2)).toEqual({ add: HEART, remove: [UP] });
  });
  test("null removes all of mine", () => {
    expect(planReactionChange([UP, FIRE], null, 3)).toEqual({ add: null, remove: [UP, FIRE] });
  });
  test("a first reaction just adds", () => {
    expect(planReactionChange([], UP, 1)).toEqual({ add: UP, remove: [] });
  });
});

describe("optimistic toggle", () => {
  test("adding creates the chip with my flag", () => {
    const { entry, plan } = applyToggle(undefined, UP, 1);
    expect(listFromEntry(entry)).toEqual([{ emoji: UP, count: 1, reacted: true }]);
    expect(plan).toEqual({ add: UP, remove: [] });
  });

  test("tapping my own chip removes it, and the chip is gone at zero", () => {
    const start = entryFromList([{ emoji: UP, count: 1, reacted: true }]);
    const { entry } = applyToggle(start, UP, 1);
    expect(listFromEntry(entry)).toEqual([]);
  });

  test("tapping my chip when others reacted too lowers the count", () => {
    const start = entryFromList([{ emoji: UP, count: 3, reacted: true }]);
    const { entry } = applyToggle(start, UP, 1);
    expect(listFromEntry(entry)).toEqual([{ emoji: UP, count: 2, reacted: false }]);
  });

  test("another emoji replaces mine when the limit is 1", () => {
    const start = entryFromList([
      { emoji: UP, count: 2, reacted: true },
      { emoji: FIRE, count: 1, reacted: false },
    ]);
    const { entry } = applyToggle(start, FIRE, 1);
    expect(listFromEntry(entry)).toEqual([
      { emoji: FIRE, count: 2, reacted: true },
      { emoji: UP, count: 1, reacted: false },
    ]);
  });

  test("a chip overtaking another moves up", () => {
    const start = entryFromList([
      { emoji: UP, count: 1, reacted: false },
      { emoji: FIRE, count: 1, reacted: false },
    ]);
    const { entry } = applyToggle(start, FIRE, 1);
    expect(entry.items.map((i) => i.emoji)).toEqual([FIRE, UP]);
  });

  test("a failed tap is undone exactly, keeping what arrived meanwhile", () => {
    const start = entryFromList([
      { emoji: UP, count: 2, reacted: true },
      { emoji: FIRE, count: 1, reacted: false },
    ]);
    const { entry, plan } = applyToggle(start, FIRE, 1);
    // Bob reacts with a heart while the request is on its way
    const meanwhile = { ...entry, items: [...entry.items, { emoji: HEART, count: 1 }] };
    const undone = revertToggle(meanwhile, plan);
    expect(listFromEntry(undone)).toEqual([
      { emoji: UP, count: 2, reacted: true },
      { emoji: FIRE, count: 1, reacted: false },
      { emoji: HEART, count: 1, reacted: false },
    ]);
  });

  test("a failed first reaction leaves no chip", () => {
    const { entry, plan } = applyToggle(undefined, UP, 1);
    expect(listFromEntry(revertToggle(entry, plan))).toEqual([]);
  });

  test("a failed removal puts the chip back", () => {
    const start = entryFromList([{ emoji: UP, count: 1, reacted: true }]);
    const { entry, plan } = applyToggle(start, UP, 1);
    expect(listFromEntry(revertToggle(entry, plan))).toEqual([{ emoji: UP, count: 1, reacted: true }]);
  });
});

describe("message eligibility", () => {
  const ok = { id: MSG, body: "hi" };
  test("a delivered message with a server id can take reactions", () => {
    expect(canReactToMessage(ok)).toBe(true);
    expect(getReactionMessageId({ _serverId: MSG.toUpperCase() })).toBe(MSG);
  });
  test("not a system line, a call entry or a message still on its way", () => {
    expect(canReactToMessage({ ...ok, _systemEvent: { type: "join" } })).toBe(false);
    expect(canReactToMessage({ ...ok, body: "[[system:joined:bob]]" })).toBe(false);
    expect(canReactToMessage({ ...ok, messageType: "call" })).toBe(false);
    expect(canReactToMessage({ ...ok, type: "call" })).toBe(false);
    expect(canReactToMessage({ ...ok, call: { callId: "x" } })).toBe(false);
    expect(canReactToMessage({ ...ok, _delivery: "sending" })).toBe(false);
    expect(canReactToMessage({ ...ok, _delivery: "failed" })).toBe(false);
    expect(canReactToMessage({ ...ok, _awaitingServerEcho: true })).toBe(false);
  });
  test("a message with no server id cannot", () => {
    expect(canReactToMessage({ _clientId: "abc", body: "hi" })).toBe(false);
    expect(canReactToMessage({ id: 7, body: "hi" })).toBe(false);
    expect(canReactToMessage(null)).toBe(false);
  });
  test("a sent local message with its server id can", () => {
    expect(canReactToMessage({ _clientId: "abc", _serverId: MSG, _delivery: "sent" })).toBe(true);
  });
});

describe("labels", () => {
  test("the chip label says what it is", () => {
    expect(reactionAriaLabel({ emoji: UP, count: 3, reacted: true })).toBe(`${UP} 3 reactions, you reacted`);
    expect(reactionAriaLabel({ emoji: UP, count: 1, reacted: false })).toBe(`${UP} 1 reaction`);
  });
  test("error texts", () => {
    expect(reactionErrorMessage(429)).toMatch(/slow down/i);
    expect(reactionErrorMessage(404)).toMatch(/no longer available/i);
    expect(reactionErrorMessage(403)).toMatch(/can't react/i);
    expect(reactionErrorMessage(500, "Unable to update reaction.")).toBe("Unable to update reaction.");
    expect(reactionErrorMessage(500, "")).toMatch(/try again/i);
  });
});

describe("canListReactors", () => {
  test("in a channel only its owner may see who reacted", () => {
    expect(canListReactors({ chatType: "channel", isOwner: true })).toBe(true);
    expect(canListReactors({ chatType: "channel", isOwner: false })).toBe(false);
    expect(canListReactors({ chatType: "Channel", isOwner: false })).toBe(false);
  });

  test("in a chat or a group every member may", () => {
    expect(canListReactors({ chatType: "dm", isOwner: false })).toBe(true);
    expect(canListReactors({ chatType: "group", isOwner: false })).toBe(true);
    expect(canListReactors({ chatType: undefined, isOwner: false })).toBe(true);
  });
});

describe("normalizeReactorGroups", () => {
  const user = (id, extra = {}) => ({ id, username: `u${id}`, nickname: "", avatarUrl: null, color: "#10b981", ...extra });

  test("shapes the server answer: names, groups, total and the truncated flag", () => {
    const result = normalizeReactorGroups({
      messageId: MSG,
      reactions: [
        { emoji: HEART, count: 2, users: [user("1", { nickname: "Alice" }), user("2")] },
        { emoji: UP, count: 1, users: [user("1", { nickname: "Alice" })] },
      ],
      truncated: false,
    });
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.groups.map((g) => g.emoji)).toEqual([HEART, UP]);
    expect(result.groups[0].users.map((u) => u.name)).toEqual(["Alice", "u2"]);
    expect(result.groups[0].users[0].avatarUrl).toBe("");
  });

  test("the true count wins over the capped list of people", () => {
    const result = normalizeReactorGroups({
      reactions: [{ emoji: UP, count: 250, users: [user("1")] }],
      truncated: true,
    });
    expect(result.groups[0].count).toBe(250);
    expect(result.total).toBe(250);
    expect(result.truncated).toBe(true);
  });

  test("leaves out junk: bad emoji, repeated groups, people without an id", () => {
    const result = normalizeReactorGroups({
      reactions: [
        { emoji: "", count: 1, users: [user("1")] },
        { emoji: UP, count: 1, users: [user("1"), null, { nickname: "No id" }] },
        { emoji: UP, count: 5, users: [user("9")] },
      ],
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].users.map((u) => u.id)).toEqual(["1"]);
  });

  test("anything that is not an answer is an empty list", () => {
    for (const raw of [null, undefined, {}, { reactions: "x" }]) {
      expect(normalizeReactorGroups(raw)).toEqual({ groups: [], total: 0, truncated: false });
    }
  });
});

describe("buildReactorRows", () => {
  const groups = [
    { emoji: HEART, count: 2, users: [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }] },
    { emoji: UP, count: 1, users: [{ id: "1", name: "Alice" }] },
  ];

  test("an emoji tab lists the people who used it", () => {
    expect(buildReactorRows(groups, UP).map((r) => r.name)).toEqual(["Alice"]);
    expect(buildReactorRows(groups, HEART).map((r) => r.name)).toEqual(["Alice", "Bob"]);
  });

  test("the All tab lists each person once, with every emoji they used", () => {
    const rows = buildReactorRows(groups, "");
    expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob"]);
    expect(rows[0].emojis).toEqual([HEART, UP]);
    expect(rows[1].emojis).toEqual([HEART]);
  });

  test("an unknown tab or no groups is an empty list", () => {
    expect(buildReactorRows(groups, FIRE)).toEqual([]);
    expect(buildReactorRows(undefined, "")).toEqual([]);
  });
});

describe("reactorsErrorMessage", () => {
  test("says why the list is not shown", () => {
    expect(reactorsErrorMessage(403)).toMatch(/channel owner/i);
    expect(reactorsErrorMessage(404)).toMatch(/no longer available/i);
    expect(reactorsErrorMessage(429)).toMatch(/too many/i);
    expect(reactorsErrorMessage(500, "Unable to load reactions.")).toBe("Unable to load reactions.");
    expect(reactorsErrorMessage(500)).toMatch(/try again/i);
  });
});

describe("applyDelta", () => {
  const entry = { items: [{ emoji: UP, count: 2 }, { emoji: FIRE, count: 1 }], mine: [FIRE], mineKnown: true };

  test("takes one count off what is removed, and drops it at zero", () => {
    const next = applyDelta(entry, { remove: [FIRE] });
    expect(next.items).toEqual([{ emoji: UP, count: 2 }]);
    expect(next.mine).toEqual([]);
  });

  test("puts one count on what is added, most used first, and makes it mine", () => {
    const next = applyDelta(entry, { add: [FIRE, FIRE] });
    expect(next.items).toEqual([{ emoji: FIRE, count: 3 }, { emoji: UP, count: 2 }]);
    expect(next.mine).toEqual([FIRE]);
  });

  test("an entry that does not exist yet starts empty; the one given is not changed", () => {
    expect(applyDelta(null, { add: [UP] })).toEqual({ items: [{ emoji: UP, count: 1 }], mine: [UP], mineKnown: true });
    applyDelta(entry, { add: [UP], remove: [FIRE] });
    expect(entry.items).toEqual([{ emoji: UP, count: 2 }, { emoji: FIRE, count: 1 }]);
  });
});

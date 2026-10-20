import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageForwardService, FORWARD_ERRORS } from "../../../lib/services/messageForwardService.js";
import { createMessageDeleteService, DELETE_ERRORS } from "../../../lib/services/messageDeleteService.js";
import {
  ALICE_ID,
  BOB_ID,
  CALL_MSG,
  CAROL_MSG,
  DELETED_MSG,
  DM,
  GROUP,
  M1,
  M2,
  M3,
  M4,
  MISSING_MSG,
  SERVICE_MSG,
  TARGET_GROUP,
  makeBatchApp,
} from "../../helpers/batchMessageFixture.js";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const alice = { id: ALICE_ID, username: "alice" };
const bob = { id: BOB_ID, username: "bob" };

describe("forward service", () => {
  const make = (options) => {
    const ctx = makeBatchApp(options);
    return { ctx, service: createMessageForwardService(ctx.deps, { computeTextExpiryIso: () => null }) };
  };

  test("one message uses the plain lookup, several use the bulk one", async () => {
    const { ctx, service } = make();
    await service.forward({ user: alice, sourceMessageIds: [M1], targetChatIds: [TARGET_GROUP] });
    expect(ctx.calls.findMessageById).toBe(1);
    expect(ctx.calls.findMessagesByIds).toEqual([]);

    await service.forward({ user: alice, sourceMessageIds: [M1, M2], targetChatIds: [TARGET_GROUP] });
    expect(ctx.calls.findMessagesByIds).toEqual([[M1, M2]]);
    expect(ctx.calls.findMessageById).toBe(1);
  });

  test("the answer of a request that went through", async () => {
    const { service } = make();
    const outcome = await service.forward({
      user: alice,
      sourceMessageIds: [M2, M1],
      targetChatIds: [TARGET_GROUP],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.failed).toEqual([]);
    expect(outcome.forwarded.map((m) => [m.sourceMessageId, m.chatId, m.body])).toEqual([
      [M1, TARGET_GROUP, "first"],
      [M2, TARGET_GROUP, "second (edited)"],
    ]);
  });

  test("failures carry the status the single request answers with", async () => {
    const { service } = make();
    const outcome = await service.forward({
      user: alice,
      sourceMessageIds: [MISSING_MSG, DELETED_MSG, CAROL_MSG, SERVICE_MSG, CALL_MSG],
      targetChatIds: [TARGET_GROUP],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.forwarded).toEqual([]);
    expect(outcome.failed.map((f) => [f.code, f.status])).toEqual([
      ["not_found", 404],
      ["gone", 410],
      ["forbidden", 403],
      ["not_forwardable", 400],
      ["not_forwardable", 400],
    ]);
  });

  test("a refusing target is the answer for the whole request", async () => {
    const { ctx, service } = make();
    const outcome = await service.forward({
      user: bob,
      sourceMessageIds: [M1],
      targetChatIds: [DM, "00000000-0000-4000-8000-0000000010ff"],
    });
    expect(outcome).toMatchObject({ ok: false, status: 403, code: "forbidden_target" });
    expect(ctx.created).toHaveLength(0);
  });

  test("keeps working when the database layer has no hidden-for-me lookups at all", async () => {
    const { ctx } = make();
    const deps = { ...ctx.deps };
    delete deps.isMessageHiddenForUser;
    delete deps.listMessageIdsHiddenForUser;
    delete deps.findMessagesByIds;
    const service = createMessageForwardService(deps, {});
    const outcome = await service.forward({ user: alice, sourceMessageIds: [M1, M2], targetChatIds: [TARGET_GROUP] });
    expect(outcome.forwarded).toHaveLength(2);
    // No expiry function: the text does not expire.
    expect(ctx.created.map((c) => c.expiresAt)).toEqual([null, null]);
  });

  test("the error table is complete and consistent", () => {
    for (const make of Object.values(FORWARD_ERRORS)) {
      const entry = make();
      expect(Number.isInteger(entry.status)).toBe(true);
      expect(entry.code).toMatch(/^[a-z_]+$/);
      expect(entry.error).toMatch(/\.$/);
    }
    expect(new Set(Object.values(FORWARD_ERRORS).map((make) => make().code)).size).toBe(
      Object.keys(FORWARD_ERRORS).length,
    );
  });
});

describe("delete service", () => {
  const make = (options) => {
    const ctx = makeBatchApp(options);
    return { ctx, service: createMessageDeleteService(ctx.deps) };
  };

  test("a person outside the chat refuses the whole request", async () => {
    const { service } = make();
    const outcome = await service.deleteMessages({
      user: { id: "00000000-0000-4000-8000-0000000000c0" },
      chatId: GROUP,
      messageIds: [M1],
      scope: "self",
    });
    expect(outcome).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  test("one result per message, with the status the single request answers with", async () => {
    const { service } = make();
    const outcome = await service.deleteMessages({
      user: bob,
      chatId: GROUP,
      messageIds: [M1, M2, MISSING_MSG],
      scope: "everyone",
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.scope).toBe("everyone");
    expect(outcome.results).toEqual([
      { messageId: M1, ok: true },
      { messageId: M2, ok: false, status: 403, code: "forbidden", error: "You cannot delete this message for everyone." },
      { messageId: MISSING_MSG, ok: false, status: 404, code: "not_found", error: "Message not found." },
    ]);
  });

  test.each([
    [undefined, "self"],
    [null, "self"],
    ["", "self"],
    ["self", "self"],
    ["all", "self"],
    ["EVERYONE ", "self"],
    ["everyone", "everyone"],
    ["Everyone", "everyone"],
  ])("scope %j means %s", async (scope, expected) => {
    const { ctx, service } = make();
    const outcome = await service.deleteMessages({ user: alice, chatId: GROUP, messageIds: [M1], scope });
    expect(outcome.scope).toBe(expected);
    expect(ctx.calls.hideEveryone).toEqual(expected === "everyone" ? [M1] : []);
  });

  test("the chat and the role are looked up at most once, and only for 'everyone'", async () => {
    const { ctx, service } = make();
    await service.deleteMessages({ user: alice, chatId: GROUP, messageIds: [M1, M2, M3, M4], scope: "everyone" });
    expect(ctx.calls.findChatById).toEqual([GROUP]);
    expect(ctx.calls.getChatMemberRole).toEqual([GROUP]);
  });

  test("a chat that vanished is reported per message", async () => {
    const { ctx } = make();
    const service = createMessageDeleteService({ ...ctx.deps, findChatById: () => null });
    const outcome = await service.deleteMessages({ user: alice, chatId: GROUP, messageIds: [M1], scope: "everyone" });
    expect(outcome.results[0]).toMatchObject({ ok: false, status: 404, code: "chat_not_found" });
  });

  test("works without findMessagesByIds and without an unpin function", async () => {
    const { ctx } = make();
    const deps = { ...ctx.deps };
    delete deps.findMessagesByIds;
    delete deps.unpinMessage;
    const service = createMessageDeleteService(deps);
    const outcome = await service.deleteMessages({ user: alice, chatId: GROUP, messageIds: [M1, M2], scope: "everyone" });
    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect(ctx.eventsOfType("message_unpinned")).toEqual([]);
  });

  test("the error table is complete and consistent", () => {
    for (const make of Object.values(DELETE_ERRORS)) {
      const entry = make();
      expect(Number.isInteger(entry.status)).toBe(true);
      expect(entry.code).toMatch(/^[a-z_]+$/);
      expect(entry.error).toMatch(/\.$/);
    }
  });
});

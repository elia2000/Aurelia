import { describe, test, expect, vi } from "vitest";
import { createDeletionService } from "../../../lib/services/deletionService.js";

const CHAT = "22222222-2222-4222-a222-222222222222";
const OTHER = "33333333-3333-4333-a333-333333333333";

const members = [
  { id: "u1", username: "alice" },
  { id: "u2", username: "bob" },
  { id: "u3", username: "carol" },
];

function make(extra = {}) {
  const order = [];
  const api = {
    findChatById: vi.fn(() => ({ id: CHAT, type: "group" })),
    listChatMembers: vi.fn(() => members),
    deleteChatById: vi.fn(() => {
      order.push("delete");
      return { storedNames: ["a.png"] };
    }),
    listChatPinHolders: vi.fn(() => {
      order.push("holders");
      return [
        { user_id: "u1", username: "alice" },
        { user_id: "u3", username: "carol" },
      ];
    }),
    listChatPinsForUsers: vi.fn(() => {
      order.push("remaining");
      return [{ user_id: "u1", chat_id: OTHER, position: 0 }];
    }),
    ...extra,
  };
  return { service: createDeletionService(api), api, order };
}

describe("deleteChat and pins", () => {
  test("asks who pinned the chat before deleting it, and what they have left afterwards", async () => {
    const { service, order } = make();
    await service.deleteChat({ chatId: CHAT });
    expect(order).toEqual(["holders", "delete", "remaining"]);
  });

  test("adds one chat_pins_changed per holder next to the chat_deleted events", async () => {
    const { service } = make();
    const result = await service.deleteChat({ chatId: CHAT });
    const deleted = result.sseEvents.filter((e) => e.payload.type === "chat_deleted");
    const pins = result.sseEvents.filter((e) => e.payload.type === "chat_pins_changed");
    expect(deleted.map((e) => e.targetUsername)).toEqual(["alice", "bob", "carol"]);
    expect(pins).toEqual([
      {
        targetUsername: "alice",
        payload: { type: "chat_pins_changed", pinned: [{ chatId: OTHER, position: 0 }] },
      },
      {
        targetUsername: "carol",
        payload: { type: "chat_pins_changed", pinned: [] },
      },
    ]);
  });

  test("people who did not pin it get no pin event", async () => {
    const { service } = make();
    const result = await service.deleteChat({ chatId: CHAT });
    expect(result.sseEvents.some((e) => e.targetUsername === "bob" && e.payload.type === "chat_pins_changed")).toBe(
      false,
    );
  });

  test("nobody pinned it: only chat_deleted events and no second query", async () => {
    const { service, api } = make({ listChatPinHolders: vi.fn(() => []) });
    const result = await service.deleteChat({ chatId: CHAT });
    expect(result.sseEvents.every((e) => e.payload.type === "chat_deleted")).toBe(true);
    expect(api.listChatPinsForUsers).not.toHaveBeenCalled();
  });

  test("still deletes and reports when the pin lookups fail", async () => {
    const { service, api } = make({
      listChatPinHolders: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const result = await service.deleteChat({ chatId: CHAT });
    expect(api.deleteChatById).toHaveBeenCalledWith(CHAT);
    expect(result.success).toBe(true);
    expect(result.storedFilesToRemove).toEqual(["a.png"]);

    const failing = make({
      listChatPinsForUsers: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const second = await failing.service.deleteChat({ chatId: CHAT });
    expect(second.success).toBe(true);
    expect(second.sseEvents.every((e) => e.payload.type === "chat_deleted")).toBe(true);
  });

  test("works without the pin functions (older callers)", async () => {
    const service = createDeletionService({
      findChatById: () => ({ id: CHAT }),
      listChatMembers: () => members,
      deleteChatById: () => ({ storedNames: [] }),
    });
    const result = await service.deleteChat({ chatId: CHAT });
    expect(result.sseEvents).toHaveLength(3);
  });

  test("works with asynchronous database functions", async () => {
    const { service } = make({
      listChatPinHolders: async () => [{ user_id: "u1", username: "alice" }],
      listChatPinsForUsers: async () => [],
    });
    const result = await service.deleteChat({ chatId: CHAT });
    expect(result.sseEvents.filter((e) => e.payload.type === "chat_pins_changed")).toHaveLength(1);
  });
});

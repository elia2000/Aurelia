import { describe, test, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import {
  addChatMember,
  createCallMessage,
  createChat,
  createMessage,
  createUser,
  getMessages,
} from "../../db.js";

const unique = () => crypto.randomBytes(5).toString("hex");

afterEach(() => {
  vi.useRealTimers();
});

describe("messages written in the same second", () => {
  // created_at has a resolution of one second and a chat sorts equal times by
  // id. A person who sends several messages quickly (or two people who answer
  // each other within a second) must see them in the order they were written,
  // after a reload as well, and a client that asks for "what came after the
  // last message I have" must not miss the ones that sort in between.
  test("keep the order they were written in, whoever wrote them", async () => {
    const tag = unique();
    const alice = await createUser(`so_${tag}_a`, "hash", "Alice", null, "#10b981");
    const bob = await createUser(`so_${tag}_b`, "hash", "Bob", null, "#10b981");
    const chatId = await createChat(`order ${tag}`, "group", { createdByUserId: alice });
    await addChatMember(chatId, alice, "owner");
    await addChatMember(chatId, bob, "member");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-05-05T10:00:00.100Z"));

    const bodies = [];
    for (let i = 0; i < 40; i += 1) {
      bodies.push(`message ${i}`);
      await createMessage(chatId, i % 3 ? alice : bob, `message ${i}`);
      // a few milliseconds pass between some of them, the second does not change
      if (i % 5 === 0) vi.setSystemTime(new Date(Date.now() + 7));
    }
    const { messages } = await getMessages(chatId, { limit: 100, viewerUserId: alice });
    expect(new Set(messages.map((m) => m.created_at)).size).toBe(1);
    expect(messages.map((m) => m.body)).toEqual(bodies);
  });

  test("an incremental fetch from the last known message (inclusive) always contains the next one", async () => {
    const tag = unique();
    const alice = await createUser(`so_${tag}_c`, "hash", "Alice", null, "#10b981");
    const chatId = await createChat(`after ${tag}`, "group", { createdByUserId: alice });
    await addChatMember(chatId, alice, "owner");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-05-05T11:00:00.000Z"));

    let anchor = await createMessage(chatId, alice, "first");
    for (let i = 0; i < 25; i += 1) {
      const next = await createMessage(chatId, alice, `next ${i}`);
      const { messages } = await getMessages(chatId, {
        limit: 50,
        viewerUserId: alice,
        afterId: anchor,
        afterCreatedAt: "2031-05-05 11:00:00",
      });
      // the anchor itself comes back too; the new message must be there as well
      expect(messages.map((m) => m.id)).toEqual([anchor, next]);
      anchor = next;
    }
  });

  // A call that ends writes its history entry into the chat, usually within the
  // same second as the messages around it. It is a message like any other: it
  // sorts by id inside the second, and a client that asks for what came after
  // the last message it has must not miss it.
  test("call history entries keep their place between the messages around them", async () => {
    const tag = unique();
    const alice = await createUser(`so_${tag}_d`, "hash", "Alice", null, "#10b981");
    const bob = await createUser(`so_${tag}_e`, "hash", "Bob", null, "#10b981");
    const chatId = await createChat(`calls ${tag}`, "dm", { createdByUserId: alice });
    await addChatMember(chatId, alice, "member");
    await addChatMember(chatId, bob, "member");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-05-05T12:00:00.000Z"));

    const order = [];
    for (let i = 0; i < 60; i += 1) {
      if (i % 3 === 1) {
        const call = await createCallMessage({
          chatId,
          callerId: alice,
          calleeId: bob,
          callId: crypto.randomUUID(),
          kind: "audio",
          outcome: "completed",
          durationSec: 5,
          expiresAt: null,
          markReadBy: bob,
        });
        order.push(call.id);
      } else {
        order.push(await createMessage(chatId, alice, `text ${i}`));
      }
      if (i % 7 === 0) vi.setSystemTime(new Date(Date.now() + 3));
    }
    const { messages } = await getMessages(chatId, { limit: 100, viewerUserId: bob });
    expect(new Set(messages.map((m) => m.created_at)).size).toBe(1);
    expect(messages.map((m) => m.id)).toEqual(order);
  });

  test("an incremental fetch anchored on a call entry always contains the message that follows it", async () => {
    const tag = unique();
    const alice = await createUser(`so_${tag}_f`, "hash", "Alice", null, "#10b981");
    const bob = await createUser(`so_${tag}_g`, "hash", "Bob", null, "#10b981");
    const chatId = await createChat(`calls after ${tag}`, "dm", { createdByUserId: alice });
    await addChatMember(chatId, alice, "member");
    await addChatMember(chatId, bob, "member");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-05-05T13:00:00.000Z"));

    for (let i = 0; i < 40; i += 1) {
      const call = await createCallMessage({
        chatId,
        callerId: alice,
        calleeId: bob,
        callId: crypto.randomUUID(),
        kind: "audio",
        outcome: "completed",
        durationSec: 5,
        expiresAt: null,
        markReadBy: bob,
      });
      const next = await createMessage(chatId, alice, `after call ${i}`);
      const { messages } = await getMessages(chatId, {
        limit: 100,
        viewerUserId: bob,
        afterId: call.id,
        afterCreatedAt: "2031-05-05 13:00:00",
      });
      expect(messages.map((m) => m.id)).toContain(next);
      expect(messages.map((m) => m.id).indexOf(next)).toBeGreaterThan(messages.map((m) => m.id).indexOf(call.id));
      vi.setSystemTime(new Date(Date.now() + 1000));
    }
  });
});

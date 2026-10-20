import { describe, test, expect } from "vitest";
import { createSseHub } from "../../lib/sse.js";

const CHAT_A = "c0c0c0c0-d1d1-4e2e-af3f-060606060606";
const CHAT_B = "c1c1c1c1-d1d1-4e2e-af3f-070707070707";

function setup() {
  const hub = createSseHub({ listChatMembers: () => [] });
  const wire = { alice: [], alice2: [], bob: [] };
  // alice has two devices connected on one account.
  hub.addSseClient("alice", { write: (chunk) => wire.alice.push(JSON.parse(chunk.replace(/^data: /, ""))) });
  hub.addSseClient("alice", { write: (chunk) => wire.alice2.push(JSON.parse(chunk.replace(/^data: /, ""))) });
  hub.addSseClient("bob", { write: (chunk) => wire.bob.push(JSON.parse(chunk.replace(/^data: /, ""))) });
  return { hub, wire };
}

const event = {
  type: "chat_pins_changed",
  pinned: [
    { chatId: CHAT_A, position: 0 },
    { chatId: CHAT_B, position: 1 },
  ],
};

describe("chat_pins_changed SSE event", () => {
  test("reaches every session of that person and nobody else", () => {
    const { hub, wire } = setup();
    hub.emitSseEvent("alice", event);
    expect(wire.alice).toEqual([event]);
    expect(wire.alice2).toEqual([event]);
    expect(wire.bob).toEqual([]);
  });

  test("the username is matched case-insensitively", () => {
    const { hub, wire } = setup();
    hub.emitSseEvent("Alice", event);
    expect(wire.alice).toHaveLength(1);
  });

  test("an empty list is delivered: it clears the pins on the other devices", () => {
    const { hub, wire } = setup();
    hub.emitSseEvent("alice", { type: "chat_pins_changed", pinned: [] });
    expect(wire.alice).toEqual([{ type: "chat_pins_changed", pinned: [] }]);
  });

  test.each([
    ["no list", { type: "chat_pins_changed" }],
    ["a list that is not an array", { type: "chat_pins_changed", pinned: "x" }],
    ["a chat id that is not a UUID", { type: "chat_pins_changed", pinned: [{ chatId: "nope", position: 0 }] }],
    ["an entry without a chat id", { type: "chat_pins_changed", pinned: [{ position: 0 }] }],
    ["a null entry", { type: "chat_pins_changed", pinned: [null] }],
    ["a position that is not a number", { type: "chat_pins_changed", pinned: [{ chatId: CHAT_A, position: "top" }] }],
    ["a fractional position", { type: "chat_pins_changed", pinned: [{ chatId: CHAT_A, position: 0.5 }] }],
  ])("is dropped with %s", (_name, payload) => {
    const { hub, wire } = setup();
    hub.emitSseEvent("alice", payload);
    expect(wire.alice).toEqual([]);
  });

  test("is never sent to a chat's members: it is not a chat event", () => {
    // emitChatEvent fans out to every member; a pin list must not go that way
    // even if a caller picks the wrong function.
    const members = [{ username: "alice" }, { username: "bob" }];
    const hub = createSseHub({ listChatMembers: () => members });
    const seen = [];
    hub.addSseClient("bob", { write: (chunk) => seen.push(chunk) });
    hub.emitChatEvent(CHAT_A, event);
    expect(seen).toEqual([]);
  });
});

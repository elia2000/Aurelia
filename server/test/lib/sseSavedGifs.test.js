import { describe, test, expect } from "vitest";
import { createSseHub } from "../../lib/sse.js";

const GIF_A = "d0d0d0d0-e1e1-4f2f-b040-171717171717";
const GIF_B = "d1d1d1d1-e1e1-4f2f-b040-171717171717";

function setup() {
  const hub = createSseHub({ listChatMembers: () => [] });
  const wire = { alice: [], alice2: [], bob: [] };
  // alice has two devices connected on one account.
  hub.addSseClient("alice", { write: (chunk) => wire.alice.push(JSON.parse(chunk.replace(/^data: /, ""))) });
  hub.addSseClient("alice", { write: (chunk) => wire.alice2.push(JSON.parse(chunk.replace(/^data: /, ""))) });
  hub.addSseClient("bob", { write: (chunk) => wire.bob.push(JSON.parse(chunk.replace(/^data: /, ""))) });
  return { hub, wire };
}

const added = {
  type: "saved_gif_added",
  gif: {
    id: GIF_A,
    url: `/api/gifs/${GIF_A}/file`,
    thumbUrl: null,
    width: 320,
    height: 200,
    mime: "image/gif",
    size: 1000,
    createdAt: "2026-10-18T10:00:00.000Z",
  },
  evicted: [{ id: GIF_B }],
  limit: 50,
  count: 50,
};
const removed = { type: "saved_gif_removed", gifId: GIF_A, limit: 50, count: 3 };

describe("saved_gif_added / saved_gif_removed SSE events", () => {
  test.each([added, removed])("$type reaches every session of that person and nobody else", (event) => {
    const { hub, wire } = setup();
    hub.emitSseEvent("alice", event);
    expect(wire.alice).toEqual([event]);
    expect(wire.alice2).toEqual([event]);
    expect(wire.bob).toEqual([]);
  });

  test("the username is matched case-insensitively", () => {
    const { hub, wire } = setup();
    hub.emitSseEvent("Alice", added);
    expect(wire.alice).toHaveLength(1);
  });

  test.each([added, removed])("$type is never sent to a chat's members: it is not a chat event", (event) => {
    const members = [{ username: "alice" }, { username: "bob" }];
    const hub = createSseHub({ listChatMembers: () => members });
    const seen = [];
    hub.addSseClient("bob", { write: (chunk) => seen.push(chunk) });
    hub.emitChatEvent("c0c0c0c0-d1d1-4e2e-af3f-060606060606", event);
    expect(seen).toEqual([]);
  });

  test.each([
    ["no gif", { ...added, gif: undefined }],
    ["a gif without an id", { ...added, gif: { ...added.gif, id: undefined } }],
    ["a gif id that is not a UUID", { ...added, gif: { ...added.gif, id: "nope" } }],
    ["an evicted entry that is not a UUID", { ...added, evicted: [{ id: "nope" }] }],
    ["an evicted list that is not an array", { ...added, evicted: "x" }],
    ["a null evicted entry", { ...added, evicted: [null] }],
    ["a removal without an id", { type: "saved_gif_removed", count: 1 }],
    ["a removal whose id is not a UUID", { type: "saved_gif_removed", gifId: "../x", count: 1 }],
  ])("is dropped with %s", (_name, payload) => {
    const { hub, wire } = setup();
    hub.emitSseEvent("alice", payload);
    expect(wire.alice).toEqual([]);
  });

  test("an empty evicted list is fine", () => {
    const { hub, wire } = setup();
    hub.emitSseEvent("alice", { ...added, evicted: [] });
    expect(wire.alice).toHaveLength(1);
  });
});

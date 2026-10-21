import { describe, test, expect, vi, afterEach } from "vitest";
import { deleteMessages, forwardMessages } from "../../src/api/batchApi.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("batchApi", () => {
  test("forwardMessages sends the ids of all the messages in one request", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchMock;
    await forwardMessages({
      username: "alice",
      sourceMessageIds: ["m1", "m2"],
      targetChatIds: ["c1"],
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/messages/forward");
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("include");
    expect(JSON.parse(options.body)).toEqual({
      username: "alice",
      sourceMessageIds: ["m1", "m2"],
      targetChatIds: ["c1"],
    });
    // the batch form has no single id and no body
    expect(JSON.parse(options.body)).not.toHaveProperty("sourceMessageId");
    expect(JSON.parse(options.body)).not.toHaveProperty("body");
  });

  test("deleteMessages sends the ids and the scope in one request", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchMock;
    await deleteMessages({
      chatId: "c1",
      username: "alice",
      messageIds: ["m1", "m2"],
      scope: "everyone",
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/messages/delete");
    expect(options.credentials).toBe("include");
    expect(JSON.parse(options.body)).toEqual({
      chatId: "c1",
      username: "alice",
      messageIds: ["m1", "m2"],
      scope: "everyone",
    });
    expect(JSON.parse(options.body)).not.toHaveProperty("messageId");
  });
});

import { describe, test, expect } from "vitest";
import { serverIdOfMessage } from "../../src/utils/messageIds.js";

const SERVER = "55555555-5555-4555-a555-555555555555";

describe("serverIdOfMessage", () => {
  test("a stored message is known by its id", () => {
    expect(serverIdOfMessage({ id: SERVER })).toBe(SERVER);
  });

  test("a just-sent message keeps its temporary id but is known by the server's", () => {
    expect(serverIdOfMessage({ id: "pending-1700000000000-abc123", _clientId: "pending-1700000000000-abc123", _serverId: SERVER })).toBe(SERVER);
  });

  test("a message the server has not acknowledged has no server id", () => {
    expect(serverIdOfMessage({ id: "pending-1700000000000-abc123" })).toBeNull();
  });

  test("the id is lower-cased and trimmed like every other id", () => {
    expect(serverIdOfMessage({ id: ` ${SERVER.toUpperCase()} ` })).toBe(SERVER);
  });

  test("nothing in, nothing out", () => {
    expect(serverIdOfMessage(null)).toBeNull();
    expect(serverIdOfMessage(undefined)).toBeNull();
    expect(serverIdOfMessage({})).toBeNull();
  });
});

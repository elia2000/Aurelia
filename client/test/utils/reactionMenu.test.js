import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { buildReactionMenuParts } from "../../src/components/chat/reactions/reactionMenu.js";
import { SHOW_REACTORS_EVENT } from "../../src/utils/reactions.js";

const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";

const message = (overrides = {}) => ({ id: MSG, body: "Hello", ...overrides });

describe("buildReactionMenuParts", () => {
  test("a message that can take a reaction gets the quick bar", () => {
    const parts = buildReactionMenuParts({ message: message(), chatId: CHAT, chatType: "dm" });
    expect(parts.reactions).toEqual({ chatId: CHAT, messageId: MSG });
    expect(parts.items).toEqual([]);
  });

  test("the server's own id wins over the local one", () => {
    const serverId = "33333333-3333-4333-a333-333333333339";
    const parts = buildReactionMenuParts({
      message: message({ id: "pending-1", _serverId: serverId }),
      chatId: CHAT,
    });
    expect(parts.reactions.messageId).toBe(serverId);
  });

  test("not for a call entry, a system line, an unsent message or a message with no server id", () => {
    for (const msg of [
      message({ call: { callId: "c" } }),
      message({ body: "[[system:left:Bob]]" }),
      message({ _delivery: "failed" }),
      message({ id: "7" }),
      null,
    ]) {
      expect(buildReactionMenuParts({ message: msg, chatId: CHAT })).toEqual({ reactions: null, items: [] });
    }
  });

  test("no chat, no bar", () => {
    expect(buildReactionMenuParts({ message: message(), chatId: null })).toEqual({ reactions: null, items: [] });
  });

  test("offline: no bar (a reaction could not be sent), but the list can still be asked for", () => {
    const parts = buildReactionMenuParts({
      message: message(),
      chatId: CHAT,
      chatType: "group",
      offline: true,
      hasReactions: true,
    });
    expect(parts.reactions).toBeNull();
    expect(parts.items.map((item) => item.id)).toEqual(["reacted-by"]);
  });

  test("'Reacted by' needs reactions to list, and the right to see who", () => {
    const base = { message: message(), chatId: CHAT };
    expect(buildReactionMenuParts({ ...base, chatType: "group", hasReactions: false }).items).toEqual([]);
    expect(buildReactionMenuParts({ ...base, chatType: "group", hasReactions: true }).items).toHaveLength(1);
    expect(buildReactionMenuParts({ ...base, chatType: "channel", isOwner: false, hasReactions: true }).items).toEqual([]);
    expect(buildReactionMenuParts({ ...base, chatType: "channel", isOwner: true, hasReactions: true }).items).toHaveLength(1);
  });

  describe("the 'Reacted by' item", () => {
    let target;
    beforeEach(() => {
      target = new EventTarget();
      vi.stubGlobal("window", target);
    });
    afterEach(() => vi.unstubAllGlobals());

    test("has an icon and asks the chips of its message for the list", () => {
      const [item] = buildReactionMenuParts({
        message: message(),
        chatId: CHAT,
        chatType: "dm",
        hasReactions: true,
      }).items;
      expect(item.label).toBe("Reacted by");
      expect(typeof item.icon === "function" || typeof item.icon === "object").toBe(true);
      const seen = [];
      target.addEventListener(SHOW_REACTORS_EVENT, (event) => seen.push(event.detail));
      item.onSelect();
      expect(seen).toEqual([{ messageId: MSG, emoji: "" }]);
    });
  });
});

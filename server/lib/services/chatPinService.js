/**
 * Pinned Chats Domain Service
 *
 * A person pins conversations to the top of their own chat list. This service
 * authorises the request, applies it and works out its effects: the pin list
 * for the caller and the "chat_pins_changed" event for the caller's own
 * sessions (other devices). It returns plain `{ status, body }` results for the
 * thin route layer.
 *
 * Pins are private. The event goes to the person's sessions only
 * (emitSseEvent), never to the chat (emitChatEvent): the other members of a
 * chat must not learn who pinned it.
 */

import {
  buildPinsChangedEvents,
  clampMaxPinnedChats,
  toPinnedPayload,
} from "../chatPins.js";
import { isValidUuid } from "../uuidUtils.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

const fail = (status, error, extra = {}) => ({ ok: false, status, body: { error, ...extra } });

export function createChatPinService(deps) {
  const {
    getSetting,
    emitSseEvent,
    isMember,
    listChatPinHolders,
    listChatPins,
    listChatPinsForUsers,
    pinChat,
    removeChatPins,
    reorderChatPins,
  } = deps;

  const maxPinned = () =>
    clampMaxPinnedChats(typeof getSetting === "function" ? getSetting("MAX_PINNED_CHATS") : null);

  // A broken realtime hub must never undo a change that is already stored.
  const emitToSessions = (username, payload) => {
    if (typeof emitSseEvent !== "function" || !username) return;
    try {
      emitSseEvent(String(username).toLowerCase(), payload);
    } catch (error) {
      console.error("chat pins: realtime event failed:", error);
    }
  };

  /** The person's pins as the API shows them: [{ chatId, position }], top first. */
  async function pinsOf(userId) {
    if (typeof listChatPins !== "function") return [];
    return toPinnedPayload((await maybe(listChatPins(userId))) || []);
  }

  /** Tells the person's other devices what their pins are now. */
  function announce(user, pinned) {
    emitToSessions(user.username, { type: "chat_pins_changed", pinned });
  }

  /** PUT /api/chats/:chatId/pin */
  async function setPinned({ user, chatId, pinned }) {
    if (!(await maybe(isMember(chatId, user.id)))) {
      // The same answer for a chat that does not exist and one that is not
      // theirs, so ids of other people's conversations cannot be probed.
      return fail(403, "Not a member of this chat.");
    }

    if (!pinned) {
      const removed = Number(await maybe(removeChatPins(user.id, [chatId]))) || 0;
      const pins = await pinsOf(user.id);
      if (removed > 0) announce(user, pins);
      return {
        ok: true,
        status: 200,
        body: { chatId, pinned: false, pinPosition: null, pins },
      };
    }

    const max = maxPinned();
    const outcome = await maybe(pinChat({ userId: user.id, chatId, max }));
    switch (outcome?.status) {
      case "limit":
        return fail(409, `You can pin at most ${max} chats. Unpin one first.`, {
          code: "pin_limit",
          max,
        });
      case "hidden":
        return fail(409, "This chat is hidden. Open it before pinning it.", {
          code: "chat_hidden",
        });
      case "not_member":
        // They left between our check and the write.
        return fail(403, "Not a member of this chat.");
      case "pinned":
      case "already":
        break;
      default:
        return fail(500, "Unable to pin the chat.");
    }

    const pins = await pinsOf(user.id);
    if (outcome.status === "pinned") announce(user, pins);
    return {
      ok: true,
      status: 200,
      body: {
        chatId,
        pinned: true,
        pinPosition: pins.find((pin) => pin.chatId === chatId)?.position ?? outcome.position ?? null,
        pins,
      },
    };
  }

  /** PUT /api/chats/pins/order */
  async function reorder({ user, chatIds }) {
    const outcome = await maybe(reorderChatPins(user.id, chatIds));
    const pins = await pinsOf(user.id);
    if (outcome?.status !== "ok") {
      // The client is out of date (another device pinned or unpinned): hand it
      // the real list so it can start over.
      return fail(
        409,
        "The list must contain exactly the chats you have pinned, each once.",
        { code: "pin_set_mismatch", pins },
      );
    }
    if (outcome.changed) announce(user, pins);
    return { ok: true, status: 200, body: { pins } };
  }

  /**
   * The person lost the right to these chats in their list (left, was removed,
   * hid them): drop their pins and tell their other devices. Call it before
   * the membership or the hiding changes. It never throws: the caller's own
   * change must go ahead, and the database clears the pin by itself anyway.
   * Resolves to the number of pins removed.
   */
  async function release({ user, chatIds }) {
    try {
      const ids = (Array.isArray(chatIds) ? chatIds : []).filter(
        (id) => typeof id === "string" && isValidUuid(id),
      );
      if (!user?.id || !ids.length || typeof removeChatPins !== "function") return 0;
      const removed = Number(await maybe(removeChatPins(user.id, ids))) || 0;
      if (removed > 0) announce(user, await pinsOf(user.id));
      return removed;
    } catch (error) {
      console.error("chat pins: unable to release pins:", error);
      return 0;
    }
  }

  /** The people who have this chat pinned. Ask before the chat is deleted. */
  async function holdersOf(chatId) {
    try {
      if (typeof listChatPinHolders !== "function") return [];
      return (await maybe(listChatPinHolders(chatId))) || [];
    } catch (error) {
      console.error("chat pins: unable to list who pinned the chat:", error);
      return [];
    }
  }

  /** After a chat is gone: every holder's sessions get their remaining pins. */
  async function announceToHolders(holders) {
    try {
      if (!holders?.length || typeof listChatPinsForUsers !== "function") return;
      const rows = (await maybe(listChatPinsForUsers(holders.map((h) => h.user_id)))) || [];
      for (const event of buildPinsChangedEvents(holders, rows)) {
        emitToSessions(event.targetUsername, event.payload);
      }
    } catch (error) {
      console.error("chat pins: unable to announce the pins:", error);
    }
  }

  return { setPinned, reorder, release, holdersOf, announceToHolders };
}

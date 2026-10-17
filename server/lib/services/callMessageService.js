/**
 * Call History Domain Service
 *
 * When a call between two people reaches a terminal state, writes ONE message
 * into their direct chat ("Outgoing call 0:23", "Missed call", ...) and tells
 * both of them in real time. The entry is written by the CALLER, whoever ended
 * the call, and it is written at most once per call id: the database refuses a
 * second entry for the same call, so two people hanging up together, a person
 * racing the expiry sweeper, or a retried request cannot add a second one.
 *
 * Nothing here ever throws at the caller: a call that has ended must stay
 * ended even when its history entry cannot be saved.
 */

import {
  callCountsAsUnread,
  callPreviewText,
  resolveCallOutcome,
} from "../callMessages.js";
import { CALL_KINDS } from "../calls.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

const skip = (reason, extra = {}) => ({ recorded: false, reason, ...extra });

const DAY_MS = 24 * 60 * 60 * 1000;

export function createCallMessageService(deps) {
  const {
    createCallMessage,
    emitChatEvent,
    findChatById,
    findUserById,
    getSetting,
    isMember,
  } = deps;

  /** Same rule as a text message: it expires MESSAGE_TEXT_RETENTION days after it is written. */
  const expiryIso = () => {
    const days = Number(typeof getSetting === "function" ? getSetting("MESSAGE_TEXT_RETENTION") : 0);
    if (!Number.isFinite(days) || days <= 0) return null;
    return new Date(Date.now() + days * DAY_MS).toISOString();
  };

  // A broken realtime hub must never undo an entry that is already stored.
  const emit = (chatId, payload) => {
    if (typeof emitChatEvent !== "function") return;
    try {
      emitChatEvent(chatId, payload);
    } catch (error) {
      console.error("calls: realtime event for the call entry failed:", error);
    }
  };

  const isUsable = (user) => Boolean(user) && !Number(user.banned);

  /**
   * The facts of the entry: who called whom in which chat, and how it ended.
   * Writes it if the conversation still exists with both of them in it.
   */
  async function write({ callId, kind, chatId, caller, callee, outcome, durationSec }) {
    if (typeof createCallMessage !== "function") return skip("unavailable");
    if (!callId || !chatId || !caller?.id || !callee?.id) return skip("not_a_dm");
    const safeKind = CALL_KINDS.includes(kind) ? kind : "audio";

    // Only a direct chat of the two people gets entries: groups, channels and
    // Saved Messages have no calls, and a chat that is gone has nowhere to
    // write to (messages carry no foreign key to their chat).
    const chat = await maybe(findChatById(chatId));
    if (!chat || String(chat.type).toLowerCase() !== "dm") return skip("not_a_dm");

    // Someone who left, was removed, deleted their account or is banned is not
    // written to, and does not write.
    const [callerIn, calleeIn] = await Promise.all([
      maybe(isMember(chatId, caller.id)),
      maybe(isMember(chatId, callee.id)),
    ]);
    if (!callerIn || !calleeIn) return skip("not_member");
    const [callerRow, calleeRow] = await Promise.all([
      maybe(findUserById(caller.id)),
      maybe(findUserById(callee.id)),
    ]);
    if (!isUsable(callerRow) || !isUsable(calleeRow)) return skip("user_unavailable");

    const countsAsUnread = callCountsAsUnread(outcome);
    let stored;
    try {
      stored = await maybe(
        createCallMessage({
          chatId,
          callerId: caller.id,
          calleeId: callee.id,
          callId,
          kind: safeKind,
          outcome,
          durationSec,
          expiresAt: expiryIso(),
          // Everything but a missed call is already read by the callee.
          markReadBy: countsAsUnread ? null : callee.id,
        }),
      );
    } catch (error) {
      console.error("calls: unable to write the call entry:", error);
      return skip("error");
    }
    if (!stored?.id) return skip("error");
    if (!stored.created) return skip("duplicate", { messageId: stored.id });

    const payload = {
      type: "chat_message",
      chatId,
      messageId: stored.id,
      username: callerRow.username || caller.username,
      userId: caller.id,
      body: "",
      // One payload goes to both people, so the line reads right to both; the
      // chat list (GET /api/chats) words it for the person who asks.
      summaryText: callPreviewText({ kind: safeKind, outcome, outgoing: null }),
      messageType: "call",
      call: { callId, kind: safeKind, outcome, durationSec: durationSec ?? null },
      // Only the callee ever waits on it: the caller wrote it.
      countsAsUnread,
      created_at: stored.createdAt || null,
      ...(countsAsUnread
        ? {}
        : { read_at: new Date().toISOString(), read_by_user_id: callee.id }),
    };
    emit(chatId, payload);
    return { recorded: true, messageId: stored.id, outcome };
  }

  /**
   * Records an ended call from the registry (see lib/calls.js). Safe to call
   * more than once for the same call.
   */
  async function recordEndedCall(call) {
    if (!call || !call.id || !call.chatId || !call.caller || !call.callee) {
      return skip("not_a_dm");
    }
    try {
      const { outcome, durationSec } = resolveCallOutcome(call);
      return await write({
        callId: call.id,
        kind: call.kind,
        chatId: call.chatId,
        caller: call.caller,
        callee: call.callee,
        outcome,
        durationSec,
      });
    } catch (error) {
      console.error("calls: unable to record the ended call:", error);
      return skip("error");
    }
  }

  /**
   * The callee was already in another call: nobody was rung, but the caller
   * tried, so the chat says so. `callId` is the id the caller chose, which is
   * what keeps a retry from adding a second entry.
   */
  async function recordBusyCall({ callId, kind, chatId, caller, callee }) {
    try {
      return await write({
        callId,
        kind,
        chatId,
        caller,
        callee,
        outcome: "busy",
        durationSec: null,
      });
    } catch (error) {
      console.error("calls: unable to record the busy call:", error);
      return skip("error");
    }
  }

  return { recordEndedCall, recordBusyCall };
}

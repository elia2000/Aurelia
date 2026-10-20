/**
 * Message Forward Domain Service
 *
 * Forwards one or many messages into one or many chats. The single-message
 * request (`sourceMessageId`) and the multi-select request (`sourceMessageIds`)
 * both end up here, so a message is checked and copied by exactly the same
 * code whichever way it was asked for.
 *
 * What is decided here, per source message:
 *   - the caller must be a current member of the message's chat (a person
 *     outside it learns nothing else about the message: no "deleted", no
 *     "encrypted");
 *   - a message that is gone (deleted for everyone, or removed from the
 *     caller's own view) is no longer available;
 *   - end-to-end encrypted messages, service entries ("X joined", "X pinned a
 *     message") and call history entries cannot be forwarded.
 * Then, per target chat: the caller must be a member and may post there
 * (channels: the owner only). A target that does not qualify fails the whole
 * request before anything is written.
 *
 * Messages are written oldest first (by their creation time, never by the order
 * of the request) and each becomes its own message in the target chat, with the
 * forward origin (who or which channel it came from) and a copy of its files.
 *
 * The service returns plain data; the route formats the response. Nothing here
 * throws for a bad request: failures are values.
 */

import { animationFlags } from "../animatedImage.js";
import {
  allocateAscendingIds,
  compareChronologically,
} from "../batchMessages.js";
import { isCallMessage } from "../callMessages.js";
import { isServiceMessageBody } from "../serviceMessages.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

const failure = (status, code, error) => ({ status, code, error });

export const FORWARD_ERRORS = Object.freeze({
  notFound: () => failure(404, "not_found", "Source message not found."),
  forbidden: () => failure(403, "forbidden", "You cannot forward from this chat."),
  gone: () => failure(410, "gone", "Source message is no longer available."),
  encrypted: () =>
    failure(400, "encrypted", "End-to-end encrypted messages cannot be forwarded."),
  notForwardable: () => failure(400, "not_forwardable", "This message cannot be forwarded."),
  sourceChatNotFound: () => failure(404, "source_chat_not_found", "Source chat not found."),
  emptyBody: () => failure(400, "empty_body", "Forwarded message body is required."),
  invalidBody: () => failure(400, "invalid_body", "Invalid message body."),
  createFailed: () => failure(500, "create_failed", "Unable to forward message."),
});

export function createMessageForwardService(deps, { computeTextExpiryIso } = {}) {
  const {
    createMessage,
    createMessageFiles,
    emitChatEvent,
    ensureAvatarExists,
    findChatById,
    findMessageById,
    findMessagesByIds,
    findUserById,
    fs,
    getChatMemberRole,
    getSetting,
    hideMessageForEveryone,
    isMember,
    isMessageHiddenForUser,
    listMessageFilesByMessageIds,
    listMessageIdsHiddenForUser,
    markMessageRead,
    path,
    setMessageForwardOrigin,
    unhideChat,
    uploadRootDir,
  } = deps;

  const basename = (value) => {
    if (path && typeof path.basename === "function") return path.basename(value);
    return String(value || "").split("/").pop().split("\\").pop();
  };

  const textExpiry = () =>
    typeof computeTextExpiryIso === "function"
      ? computeTextExpiryIso(new Date().toISOString())
      : null;

  // ── Looking things up (each at most once per request) ─────────────────────

  // One query for a list, the plain lookup for a single message.
  async function loadSourceRows(ids) {
    if (ids.length > 1 && typeof findMessagesByIds === "function") {
      const rows = (await maybe(findMessagesByIds(ids))) || [];
      return new Map(rows.filter(Boolean).map((row) => [String(row.id), row]));
    }
    const rows = await Promise.all(ids.map((id) => maybe(findMessageById(id))));
    const byId = new Map();
    ids.forEach((id, index) => {
      if (rows[index]) byId.set(String(id), rows[index]);
    });
    return byId;
  }

  async function loadHiddenForCaller(ids, userId) {
    if (!ids.length) return new Set();
    if (ids.length > 1 && typeof listMessageIdsHiddenForUser === "function") {
      const rows = (await maybe(listMessageIdsHiddenForUser(ids, userId))) || [];
      return new Set(rows.map((row) => String(row?.message_id ?? row)));
    }
    if (typeof isMessageHiddenForUser !== "function") return new Set();
    const hidden = new Set();
    for (const id of ids) {
      if (await maybe(isMessageHiddenForUser(id, userId))) hidden.add(id);
    }
    return hidden;
  }

  const normalizeOriginAvatarUrl = (userId, avatarUrl) => {
    const normalized =
      typeof ensureAvatarExists === "function" ? ensureAvatarExists(userId, avatarUrl) : avatarUrl;
    return String(normalized || "").trim() || null;
  };

  // Who a forwarded message says it came from: the channel for a channel post,
  // otherwise the person who wrote it.
  async function deriveForwardOrigin(sourceMessage, sourceChat) {
    if (String(sourceChat?.type || "").toLowerCase() === "channel") {
      const label =
        String(sourceChat?.name || "").trim() ||
        String(sourceChat?.group_username || "").trim() ||
        "Channel";
      return {
        sourceChatId: sourceChat?.id || null,
        label,
        sourceUserId: null,
        sourceUsername: null,
        sourceAvatarUrl: null,
        sourceColor: null,
      };
    }

    const sourceUser = await maybe(findUserById(sourceMessage?.user_id));
    return {
      sourceChatId: null,
      label:
        String(sourceUser?.nickname || "").trim() ||
        String(sourceUser?.username || "").trim() ||
        "Deleted user",
      sourceUserId: sourceUser?.id || sourceMessage?.user_id || null,
      sourceUsername: String(sourceUser?.username || "").trim() || null,
      sourceAvatarUrl: sourceUser
        ? normalizeOriginAvatarUrl(sourceUser.id, sourceUser.avatar_url)
        : null,
      sourceColor: String(sourceUser?.color || "").trim() || null,
    };
  }

  // The files a forward can carry along: the ones still on disk. Looked at
  // once per source message, however many chats it goes to.
  function reusableFilesOf(sourceFiles) {
    return (sourceFiles || []).flatMap((file) => {
      const storedName = basename(String(file?.stored_name || "").trim());
      if (!storedName) return [];
      if (!fs.existsSync(path.join(uploadRootDir, storedName))) return [];
      return [
        {
          kind: file.kind,
          originalName: file.original_name,
          storedName,
          mimeType: file.mime_type,
          sizeBytes: Number(file.size_bytes || 0),
          widthPx: Number.isFinite(Number(file.width_px)) ? Number(file.width_px) : null,
          heightPx: Number.isFinite(Number(file.height_px)) ? Number(file.height_px) : null,
          durationSeconds: Number.isFinite(Number(file.duration_seconds))
            ? Number(file.duration_seconds)
            : null,
          expiresAt: file.expires_at || null,
          isAnimated: animationFlags(file).isAnimated,
        },
      ];
    });
  }

  // ── Which of the named messages may be forwarded, and as what ─────────────

  /**
   * Checks every named message for `user`. Returns `{ accepted, failed }`:
   * `accepted` are ready to be copied (oldest first), `failed` explain the
   * rest, both in terms of the ids that were asked for.
   *
   * Every message is forwarded with its own current text, as stored. A
   * forward is labelled "Forwarded from <author>", so the text may never be
   * something the requester typed: the single-message request used to bring
   * its own text along, which let a member put words in somebody else's mouth.
   */
  async function evaluateSources({ user, sourceMessageIds }) {
    const rowsById = await loadSourceRows(sourceMessageIds);

    const memberCache = new Map();
    const isMemberOf = async (chatId) => {
      if (!memberCache.has(chatId)) {
        memberCache.set(chatId, Boolean(await maybe(isMember(chatId, user.id))));
      }
      return memberCache.get(chatId);
    };
    const chatCache = new Map();
    const chatOf = async (chatId) => {
      if (!chatCache.has(chatId)) chatCache.set(chatId, (await maybe(findChatById(chatId))) || null);
      return chatCache.get(chatId);
    };

    // Existence and membership first: a person outside the chat gets the same
    // answer for every message, whatever it is.
    const failed = [];
    const visible = [];
    for (const id of sourceMessageIds) {
      const row = rowsById.get(String(id));
      if (!row) {
        failed.push({ sourceMessageId: id, ...FORWARD_ERRORS.notFound() });
      } else if (!(await isMemberOf(row.chat_id))) {
        failed.push({ sourceMessageId: id, ...FORWARD_ERRORS.forbidden() });
      } else {
        visible.push({ id, row });
      }
    }

    const hiddenForCaller = await loadHiddenForCaller(
      visible.filter(({ row }) => !row.hidden_everyone_at).map(({ id }) => id),
      user.id,
    );

    const originCache = new Map();
    const originOf = async (row, chat) => {
      // Every post of a channel comes from the channel; otherwise from its author.
      const key =
        String(chat?.type || "").toLowerCase() === "channel"
          ? `chat:${chat.id}`
          : `user:${row.user_id}`;
      if (!originCache.has(key)) originCache.set(key, await deriveForwardOrigin(row, chat));
      return originCache.get(key);
    };

    const candidates = [];
    for (const { id, row } of visible) {
      if (row.hidden_everyone_at || hiddenForCaller.has(id)) {
        failed.push({ sourceMessageId: id, ...FORWARD_ERRORS.gone() });
        continue;
      }
      if (row.e2ee_envelope) {
        // The content key is wrapped for the original chat's devices only.
        failed.push({ sourceMessageId: id, ...FORWARD_ERRORS.encrypted() });
        continue;
      }
      if (isServiceMessageBody(row.body) || isCallMessage(row)) {
        failed.push({ sourceMessageId: id, ...FORWARD_ERRORS.notForwardable() });
        continue;
      }
      const chat = await chatOf(row.chat_id);
      if (!chat) {
        failed.push({ sourceMessageId: id, ...FORWARD_ERRORS.sourceChatNotFound() });
        continue;
      }

      const body = String(row.edited_body ?? row.body ?? "");
      if (!body.trim()) {
        failed.push({ sourceMessageId: id, ...FORWARD_ERRORS.emptyBody() });
        continue;
      }
      if (isServiceMessageBody(body)) {
        failed.push({ sourceMessageId: id, ...FORWARD_ERRORS.invalidBody() });
        continue;
      }
      candidates.push({
        id: String(row.id ?? id),
        row,
        chat,
        body,
        origin: await originOf(row, chat),
      });
    }

    // The files of every candidate in one query.
    const filesByMessageId = new Map();
    if (candidates.length && typeof listMessageFilesByMessageIds === "function") {
      const files = (await maybe(listMessageFilesByMessageIds(candidates.map(({ id }) => id)))) || [];
      for (const file of files) {
        const key = String(file?.message_id ?? "");
        if (!filesByMessageId.has(key)) filesByMessageId.set(key, []);
        filesByMessageId.get(key).push(file);
      }
    }

    // Oldest first, whatever the order of the request was.
    const ordered = [...candidates].sort((a, b) => compareChronologically(a.row, b.row));
    const accepted = ordered.map((candidate) => {
      const sourceFiles = filesByMessageId.get(String(candidate.id)) || [];
      return {
        ...candidate,
        files: reusableFilesOf(sourceFiles),
        // A message with attachments lives as long as its files do.
        expiresAt: sourceFiles.length ? null : textExpiry(),
      };
    });
    return { accepted, failed };
  }

  // ── Where the messages go ─────────────────────────────────────────────────

  /** Every target must accept the caller, or nothing is written. */
  async function checkTargets({ user, targetChatIds }) {
    const targets = [];
    for (const targetChatId of targetChatIds) {
      if (!(await maybe(isMember(targetChatId, user.id)))) {
        return {
          ok: false,
          ...failure(403, "forbidden_target", "Cannot send to one or more selected chats."),
        };
      }
      const chat = await maybe(findChatById(targetChatId));
      if (!chat) {
        return {
          ok: false,
          ...failure(404, "target_not_found", "One of the selected chats was not found."),
        };
      }
      if (String(chat.type || "").toLowerCase() === "channel") {
        const role = String((await maybe(getChatMemberRole(targetChatId, user.id))) || "").toLowerCase();
        if (role !== "owner") {
          return {
            ok: false,
            ...failure(403, "channel_owner_only", "You can only forward to channels you own."),
          };
        }
      }
      targets.push({ id: targetChatId, chat });
    }
    return { ok: true, targets };
  }

  // A message that was created but could not be finished must not stay behind
  // as an ordinary-looking message.
  async function retire(messageId) {
    try {
      if (messageId && typeof hideMessageForEveryone === "function") {
        await maybe(hideMessageForEveryone(messageId));
      }
    } catch (error) {
      console.error("forward: unable to retire an unfinished message:", error);
    }
  }

  async function writeOne({ user, target, entry, newId }) {
    const args = newId
      ? [target.id, user.id, entry.body, null, entry.expiresAt, null, { id: newId }]
      : [target.id, user.id, entry.body, null, entry.expiresAt];
    const created = await maybe(createMessage(...args));
    if (!created) return { ok: false, ...FORWARD_ERRORS.createFailed() };

    const isSavedTarget = String(target.chat.type || "").toLowerCase() === "saved";
    try {
      await maybe(
        setMessageForwardOrigin(created, {
          sourceChatId: entry.origin.sourceChatId,
          label: entry.origin.label,
          sourceUserId: entry.origin.sourceUserId,
          sourceUsername: entry.origin.sourceUsername,
          sourceAvatarUrl: entry.origin.sourceAvatarUrl,
          sourceColor: entry.origin.sourceColor,
        }),
      );
      if (entry.files.length) await maybe(createMessageFiles(created, entry.files));
      if (isSavedTarget) {
        await maybe(markMessageRead(created, user.id));
        await maybe(unhideChat(user.id, target.id));
      }
    } catch (error) {
      await retire(created);
      throw error;
    }

    // The message is complete and stored; a broken realtime hub must not undo it.
    try {
      emitChatEvent(target.id, {
        type: "chat_message",
        chatId: target.id,
        messageId: created,
        username: user.username,
        userId: user.id,
        body: entry.body,
        replyToMessageId: null,
        ...(isSavedTarget
          ? { read_at: new Date().toISOString(), read_by_user_id: user.id }
          : {}),
      });
    } catch (error) {
      console.error("forward: realtime event failed:", error);
    }
    return { ok: true, id: created };
  }

  // ── The whole request ─────────────────────────────────────────────────────

  /**
   * Forwards `sourceMessageIds` (already validated UUIDs) to `targetChatIds`
   * for `user`. Each message keeps its own stored text (see evaluateSources).
   *
   * Resolves to `{ ok: false, status, code, error }` when the request as a
   * whole cannot be served (a target refuses the caller), otherwise to
   * `{ ok: true, forwarded, failed }`:
   *   forwarded: [{ id, chatId, sourceMessageId, userId, username, body,
   *                 fileCount, forwardedFrom }]  in the order they were written
   *   failed:    [{ sourceMessageId, code, error, status, targetChatId? }]
   */
  async function forward({ user, sourceMessageIds, targetChatIds }) {
    const { accepted, failed } = await evaluateSources({ user, sourceMessageIds });
    // Failures are reported in the order the messages were asked for.
    const position = new Map(sourceMessageIds.map((id, index) => [String(id), index]));
    const inRequestOrder = (list) =>
      [...list].sort(
        (a, b) =>
          (position.get(String(a.sourceMessageId)) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(String(b.sourceMessageId)) ?? Number.MAX_SAFE_INTEGER),
      );
    const forwarded = [];
    if (!accepted.length) return { ok: true, forwarded, failed: inRequestOrder(failed) };

    const checked = await checkTargets({ user, targetChatIds });
    if (!checked.ok) return checked;

    for (const target of checked.targets) {
      // Messages written in the same second are shown by id: give the batch
      // ascending ids, in the order it is written.
      const newIds = accepted.length > 1 ? allocateAscendingIds(accepted.length) : [];
      for (let index = 0; index < accepted.length; index += 1) {
        const entry = accepted[index];
        try {
          const result = await writeOne({ user, target, entry, newId: newIds[index] || null });
          if (!result.ok) {
            failed.push({
              sourceMessageId: entry.id,
              targetChatId: target.id,
              code: result.code,
              error: result.error,
              status: result.status,
            });
            continue;
          }
          forwarded.push({
            id: result.id,
            chatId: target.id,
            sourceMessageId: entry.id,
            userId: user.id,
            username: user.username,
            body: entry.body,
            fileCount: entry.files.length,
            forwardedFrom: {
              chatId: entry.origin.sourceChatId,
              label: entry.origin.label,
              userId: entry.origin.sourceUserId,
              username: entry.origin.sourceUsername,
              avatarUrl: entry.origin.sourceAvatarUrl,
              color: entry.origin.sourceColor,
            },
          });
        } catch (error) {
          console.error("forward: unable to write a forwarded message:", error);
          failed.push({
            sourceMessageId: entry.id,
            targetChatId: target.id,
            ...FORWARD_ERRORS.createFailed(),
          });
        }
      }
    }
    return { ok: true, forwarded, failed: inRequestOrder(failed) };
  }

  return { forward };
}

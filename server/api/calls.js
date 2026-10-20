import { validateUuidBody, validateUuidParams } from "../lib/uuidMiddleware.js";
import { isBase64Url, isValidP256PublicKey } from "../lib/e2eeKeys.js";
import { CALL_KINDS, CallError } from "../lib/calls.js";
import { buildIceServers } from "../lib/callsConfig.js";
import { createCallMessageService } from "../lib/services/callMessageService.js";
import { createRelayDnsCheck } from "../lib/relayDns.js";
import { createThrottle } from "../lib/throttle.js";

const MAX_SIGNAL_BLOB_CHARS = 32 * 1024;
const SIGNAL_KINDS = new Set(["offer", "answer", "ice"]);
const INVITE_CLOCK_SKEW_MS = 2 * 60 * 1000;
const CALL_PUSH_TTL_SECONDS = 45;
// A "the call is over" push only matters to a device that is still showing the
// ringing notification, so it expires quickly too.
const CALL_END_PUSH_TTL_SECONDS = 60;

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

const isIntegerMs = (value) => Number.isFinite(value) && Math.abs(value) < 8.64e15;

const isStringId = (value) => typeof value === "string" && value.length > 0;

// The invite does not carry the caller's ephemeral key yet, only a hash of it
// (a commitment). The key itself is revealed later, inside the first encrypted
// offer, so that neither side can pick its key after seeing the other's.
function validInviteBlock(block) {
  return Boolean(
    block &&
      typeof block === "object" &&
      isStringId(block.deviceId) &&
      isBase64Url(block.commit, { minBytes: 32, maxBytes: 32 }) &&
      isBase64Url(block.sig, { minBytes: 64, maxBytes: 64 }),
  );
}

function validAcceptBlock(block) {
  return Boolean(
    block &&
      typeof block === "object" &&
      isStringId(block.deviceId) &&
      isValidP256PublicKey(block.eph) &&
      isBase64Url(block.sig, { minBytes: 64, maxBytes: 64 }),
  );
}

// validateUuidBody stringifies its input, so ["<uuid>"] would pass it; make
// sure these really are strings before anything is used as a registry key.
const requireStringFields = (...fields) => (req, res, next) => {
  for (const field of fields) {
    if (typeof req.body?.[field] !== "string") {
      return res.status(400).json({ error: `Field '${field}' must be a string.` });
    }
  }
  next();
};

/**
 * 1:1 call signaling.
 *
 * The server authorizes participants, rings the callee (realtime event or web
 * push), answers "busy", and relays OPAQUE encrypted blobs. It never receives
 * an SDP, ICE candidate, media or key in the clear: the ephemeral public keys
 * in invite/accept are signed with the participants' device identity keys and
 * everything after is AES-GCM encrypted with a key only the two devices can
 * derive.
 */
function registerCallRoutes(app, deps) {
  const {
    requireSession,
    findUserByUsername,
    findChatById,
    isMember,
    listChatMembers,
    findE2eeDevice,
    callRegistry,
    callsConfig,
    relayDnsCheck,
    emitToUser,
    sendPushNotificationToUsers,
    isUserConnected,
    listMutedUserIdsForChat,
    // The history entry a finished call leaves in the chat.
    createCallMessage,
    emitChatEvent,
    findUserById,
    getSetting,
  } = deps;

  const callMessages = createCallMessageService({
    createCallMessage,
    emitChatEvent,
    findChatById,
    findUserById,
    getSetting,
    isMember,
  });

  const emit = (username, payload) => {
    try {
      if (typeof emitToUser === "function") emitToUser(username, payload);
    } catch (_) {
      // Realtime delivery is best effort.
    }
  };

  const config = () =>
    typeof callsConfig === "function" ? callsConfig() : callsConfig || {};

  // A relay host name behind Cloudflare's proxy cannot carry calls. The answer
  // is remembered for a few minutes and never slows or breaks a call.
  const relayDns = relayDnsCheck || createRelayDnsCheck();
  const relayIsProxied = async () => {
    try {
      return Boolean((await relayDns.inspect(config())).proxied);
    } catch (_) {
      return false;
    }
  };

  // Limits are per signed-in person, not per IP address: behind a proxy that
  // does not forward the client address everybody would share one bucket, and
  // a limit per IP does nothing against someone using several addresses.
  const inviteThrottle = createThrottle({ windowMs: 60 * 1000, max: 12 });
  const invitePairThrottle = createThrottle({ windowMs: 2 * 60 * 1000, max: 5 });
  const signalThrottle = createThrottle({ windowMs: 60 * 1000, max: 300 });
  const tooMany = (res) =>
    res.status(429).json({ error: "Too many call requests. Please slow down." });

  const resolveCaller = async (req, res) => {
    if (config().enabled === false) {
      res.status(503).json({ error: "Calls are disabled on this server." });
      return null;
    }
    const session = await requireSession(req, res);
    if (!session) return null;
    const user = await maybe(
      findUserByUsername(String(session.username || "").toLowerCase()),
    );
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return null;
    }
    return user;
  };

  // CALLS_FORCE_RELAY promises that nobody learns the other person's IP
  // address. Without a usable relay the only honest answer is to refuse.
  const relayUnavailable = (res) =>
    res.status(503).json({
      error: "This server requires relayed calls, but no relay is configured.",
      code: "relay_unavailable",
    });

  const sendCallError = (res, error) => {
    if (error instanceof CallError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("[calls] unexpected error:", error);
    return res.status(500).json({ error: "Call failed." });
  };

  const publicUser = (user) => ({
    userId: user.id,
    username: user.username,
    nickname: user.nickname || user.username,
    avatarUrl: user.avatar_url || null,
    color: user.color || null,
  });

  // A phone that is not running the app is told about a call by web push. The
  // same device must also be told when the call is over, otherwise the sticky
  // "Incoming call" notification stays on screen after the caller gave up or
  // another device answered.
  const pushCallOver = (call, reason) => {
    if (!call.pushed || typeof sendPushNotificationToUsers !== "function") return;
    const unanswered = !call.answeredAt && ["cancelled", "missed", "timeout"].includes(reason);
    void Promise.resolve(
      sendPushNotificationToUsers([call.callee.id], {
        title: call.pushTitle || "Aurelle",
        body: call.kind === "video" ? "Missed video call" : "Missed voice call",
        ttl: CALL_END_PUSH_TTL_SECONDS,
        data: {
          type: "call_end",
          callId: call.id,
          chatId: call.chatId,
          reason: unanswered ? "missed" : reason,
          url: "/",
        },
      }),
    ).catch(() => {});
  };

  const endAndNotify = (call, reason, byUserId = null) => {
    const payload = { type: "call_end", callId: call.id, reason, by: byUserId };
    emit(call.caller.username, payload);
    emit(call.callee.username, payload);
    // A call that was answered already told the callee's devices at that
    // moment (see the accept route); only one that rang out needs this.
    if (!call.answeredAt) pushCallOver(call, reason);
    // The chat keeps a line about it ("Missed call", "Outgoing call 0:23").
    // The registry hands an ended call back once, and the database refuses a
    // second entry for the same call, so this is exactly once however the
    // call ended. A failure here never changes how the call ended.
    void callMessages.recordEndedCall(call).catch(() => {});
  };

  // Periodic expiry: unanswered calls become "missed", dead calls are freed.
  const sweepMs = Number(deps.callSweepIntervalMs ?? 5000);
  if (callRegistry && sweepMs > 0) {
    const timer = setInterval(() => {
      const ended = callRegistry.sweep(
        typeof isUserConnected === "function" ? isUserConnected : null,
      );
      ended.forEach(({ call, reason }) => endAndNotify(call, reason));
    }, sweepMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  app.get("/api/calls/ice-config", async (req, res) => {
    const user = await resolveCaller(req, res);
    if (!user) return;
    const result = buildIceServers(config(), user.id);
    res.set("Cache-Control", "no-store");
    if (result.relayUnavailable) return relayUnavailable(res);
    return res.json({ ...result, relayProxied: result.hasRelay ? await relayIsProxied() : false });
  });

  // Lets a freshly (re)loaded client — e.g. opened from a push notification —
  // pick up a call that is still ringing.
  app.get("/api/calls/pending", async (req, res) => {
    const user = await resolveCaller(req, res);
    if (!user) return;
    const call = callRegistry.getPendingIncoming(user.id);
    res.set("Cache-Control", "no-store");
    if (!call) return res.json({ call: null });
    const caller = await maybe(findUserByUsername(call.caller.username));
    return res.json({
      call: {
        callId: call.id,
        kind: call.kind,
        chatId: call.chatId,
        createdAt: call.createdAt,
        from: caller ? publicUser(caller) : { userId: call.caller.id, username: call.caller.username },
        invite: call.invitePayload,
      },
    });
  });

  app.post(
    "/api/calls",
    requireStringFields("callId", "chatId"),
    validateUuidBody([
      { field: "callId", required: true },
      { field: "chatId", required: true },
    ]),
    async (req, res) => {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const { callId, chatId, kind, invite } = req.body || {};

      if (!inviteThrottle.take(caller.id) || !invitePairThrottle.take(`${caller.id}:${chatId}`)) {
        return tooMany(res);
      }
      if (buildIceServers(config(), caller.id).relayUnavailable) {
        return relayUnavailable(res);
      }
      if (!CALL_KINDS.includes(kind)) {
        return res.status(400).json({ error: "Invalid call type." });
      }
      if (!validInviteBlock(invite) || !isIntegerMs(Number(invite.ts))) {
        return res.status(400).json({ error: "Invalid call invitation." });
      }
      if (Math.abs(Date.now() - Number(invite.ts)) > INVITE_CLOCK_SKEW_MS) {
        return res.status(400).json({ error: "Invitation timestamp is out of range." });
      }

      const chat = await maybe(findChatById(chatId));
      if (!chat || chat.type !== "dm") {
        return res.status(400).json({ error: "Calls are only available in direct chats." });
      }
      if (!(await maybe(isMember(chatId, caller.id)))) {
        return res.status(403).json({ error: "Not a member of this chat." });
      }
      const members = (await maybe(listChatMembers(chatId))) || [];
      const calleeRow = members.find((m) => m.id !== caller.id);
      if (!calleeRow) {
        return res.status(400).json({ error: "No one to call in this chat." });
      }

      // The signing device must be one of the caller's own active devices.
      const device = await maybe(findE2eeDevice(caller.id, invite.deviceId));
      if (!device || device.revoked_at) {
        return res.status(400).json({ error: "Unknown or revoked device." });
      }

      try {
        const call = callRegistry.invite({
          callId,
          caller: { id: caller.id, username: caller.username },
          callee: { id: calleeRow.id, username: calleeRow.username },
          chatId,
          kind,
          callerDeviceId: invite.deviceId,
          invitePayload: {
            deviceId: invite.deviceId,
            commit: invite.commit,
            ts: Number(invite.ts),
            sig: invite.sig,
          },
        });

        emit(calleeRow.username, {
          type: "call_invite",
          callId,
          kind,
          chatId,
          createdAt: call.createdAt,
          from: publicUser(caller),
          invite: call.invitePayload,
        });

        // Always ring by push as well: "the user has a live connection" is
        // per person, but a person can have a phone with the app closed and a
        // forgotten desktop tab. The service worker stays quiet when a window
        // of the app is focused, and the notification is replaced (same tag)
        // if the page shows its own.
        const mutedIds = await maybe(
          typeof listMutedUserIdsForChat === "function" ? listMutedUserIdsForChat(chatId) : [],
        );
        const calleeMuted = Array.isArray(mutedIds) && mutedIds.includes(calleeRow.id);
        if (!calleeMuted && typeof sendPushNotificationToUsers === "function") {
          call.pushed = true;
          call.pushTitle = caller.nickname || caller.username;
          void Promise.resolve(
            sendPushNotificationToUsers([calleeRow.id], {
              title: call.pushTitle,
              body: kind === "video" ? "Incoming video call" : "Incoming voice call",
              ttl: CALL_PUSH_TTL_SECONDS,
              data: { type: "call", callId, chatId, url: "/" },
            }),
          ).catch(() => {});
        }

        return res.status(201).json({
          ok: true,
          callId,
          callee: publicUser(calleeRow),
        });
      } catch (error) {
        // The person is in another call: nobody was rung, but the chat keeps a
        // "busy" line so the attempt is not lost.
        if (error instanceof CallError && error.code === "busy") {
          void callMessages
            .recordBusyCall({
              callId,
              kind,
              chatId,
              caller: { id: caller.id, username: caller.username },
              callee: { id: calleeRow.id, username: calleeRow.username },
            })
            .catch(() => {});
        }
        return sendCallError(res, error);
      }
    },
  );

  app.post(
    "/api/calls/:callId/accept",
    validateUuidParams("callId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      const { accept } = req.body || {};
      if (!validAcceptBlock(accept)) {
        return res.status(400).json({ error: "Invalid call answer." });
      }
      const device = await maybe(findE2eeDevice(user.id, accept.deviceId));
      if (!device || device.revoked_at) {
        return res.status(400).json({ error: "Unknown or revoked device." });
      }
      try {
        const call = callRegistry.accept(req.params.callId, user.id, accept.deviceId);
        emit(call.caller.username, {
          type: "call_accept",
          callId: call.id,
          accept: { deviceId: accept.deviceId, eph: accept.eph, sig: accept.sig },
        });
        // Stop ringing on the callee's other devices.
        emit(call.callee.username, {
          type: "call_accepted_elsewhere",
          callId: call.id,
          deviceId: accept.deviceId,
        });
        pushCallOver(call, "answered");
        return res.json({ ok: true });
      } catch (error) {
        return sendCallError(res, error);
      }
    },
  );

  app.post(
    "/api/calls/:callId/signal",
    validateUuidParams("callId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      if (!signalThrottle.take(user.id)) return tooMany(res);
      const { kind, blob, seq, eph } = req.body || {};
      if (!SIGNAL_KINDS.has(kind)) {
        return res.status(400).json({ error: "Invalid signal type." });
      }
      if (
        typeof blob !== "string" ||
        blob.length > MAX_SIGNAL_BLOB_CHARS ||
        !isBase64Url(blob, { minBytes: 29 })
      ) {
        return res.status(400).json({ error: "Invalid signal payload." });
      }
      const auth = callRegistry.authorize(req.params.callId, user.id);
      if (!auth) return res.status(403).json({ error: "Not your call." });
      const { call, role } = auth;
      if (!["connecting", "active"].includes(call.state)) {
        return res.status(409).json({ error: "Call is not in progress." });
      }
      // The caller reveals its ephemeral key (the one it committed to in the
      // invite) in the clear alongside its FIRST offer, once. Everything else
      // in the offer is encrypted with keys derived from it.
      let reveal = null;
      if (eph !== undefined) {
        if (
          kind !== "offer" ||
          role !== "caller" ||
          call.ephRevealed ||
          !isValidP256PublicKey(eph)
        ) {
          return res.status(400).json({ error: "Invalid key reveal." });
        }
        call.ephRevealed = true;
        reveal = eph;
      }
      const peer = role === "caller" ? call.callee : call.caller;
      emit(peer.username, {
        type: "call_signal",
        callId: call.id,
        kind,
        blob,
        seq: Number.isInteger(seq) ? seq : 0,
        ...(reveal ? { eph: reveal } : {}),
        toDeviceId: role === "caller" ? call.calleeDeviceId : call.callerDeviceId,
      });
      return res.json({ ok: true });
    },
  );

  // The callee's app reports that it is showing the incoming-call screen, so
  // the caller can switch from "Waiting…" (nobody reached yet) to "Ringing…".
  // A callee whose app is closed never sends this; its device only gets a push.
  // Someone who chose to appear offline (invisible) keeps that promise: their
  // caller stays on "Waiting…" while the call still rings for them.
  app.post(
    "/api/calls/:callId/ringing",
    validateUuidParams("callId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      if (!signalThrottle.take(user.id)) return tooMany(res);
      try {
        const call = callRegistry.markRinging(req.params.callId, user.id);
        const hidden = String(user.status || "online").toLowerCase() === "invisible";
        if (call && !hidden) emit(call.caller.username, { type: "call_ringing", callId: call.id });
        return res.json({ ok: true });
      } catch (error) {
        return sendCallError(res, error);
      }
    },
  );

  app.post(
    "/api/calls/:callId/connected",
    validateUuidParams("callId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      try {
        callRegistry.markActive(req.params.callId, user.id);
        return res.json({ ok: true });
      } catch (error) {
        return sendCallError(res, error);
      }
    },
  );

  // Cancel (caller, ringing), decline (callee, ringing) or hang up. An
  // optional `durationMs` is how long the device measured the call; it is only
  // a hint (see the registry) and a bad value never stops the call from ending.
  app.post(
    "/api/calls/:callId/end",
    validateUuidParams("callId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      try {
        const ended = callRegistry.endBy(req.params.callId, user.id, req.body?.reason, {
          durationMs: req.body?.durationMs,
        });
        if (ended) endAndNotify(ended, ended.endReason, user.id);
        return res.json({ ok: true });
      } catch (error) {
        return sendCallError(res, error);
      }
    },
  );
}

export { registerCallRoutes };

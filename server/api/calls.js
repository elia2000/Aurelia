import rateLimit from "express-rate-limit";
import { validateUuidBody, validateUuidParams } from "../lib/uuidMiddleware.js";
import { isBase64Url } from "../lib/e2eeKeys.js";
import { CALL_KINDS, CallError } from "../lib/calls.js";
import { buildIceServers } from "../lib/callsConfig.js";

const MAX_SIGNAL_BLOB_CHARS = 32 * 1024;
const SIGNAL_KINDS = new Set(["offer", "answer", "ice"]);
const INVITE_CLOCK_SKEW_MS = 2 * 60 * 1000;
const CALL_PUSH_TTL_SECONDS = 45;

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

const isIntegerMs = (value) => Number.isFinite(value) && Math.abs(value) < 8.64e15;

function validAuthBlock(block) {
  return (
    block &&
    typeof block === "object" &&
    typeof block.deviceId === "string" &&
    isBase64Url(block.eph, { minBytes: 65, maxBytes: 65 }) &&
    isBase64Url(block.sig, { minBytes: 64, maxBytes: 64 })
  );
}

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
    emitToUser,
    sendPushNotificationToUsers,
    isUserConnected,
  } = deps;

  const emit = (username, payload) => {
    try {
      if (typeof emitToUser === "function") emitToUser(username, payload);
    } catch (_) {
      // Realtime delivery is best effort.
    }
  };

  const config = () =>
    typeof callsConfig === "function" ? callsConfig() : callsConfig || {};

  const rateHandler = (_req, res) =>
    res.status(429).json({ error: "Too many call requests. Please slow down." });

  const inviteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateHandler,
  });
  const signalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateHandler,
  });

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

  const endAndNotify = (call, reason, byUserId = null) => {
    const payload = { type: "call_end", callId: call.id, reason, by: byUserId };
    emit(call.caller.username, payload);
    emit(call.callee.username, payload);
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
    return res.json(result);
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
    inviteLimiter,
    validateUuidBody([
      { field: "callId", required: true },
      { field: "chatId", required: true },
    ]),
    async (req, res) => {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const { callId, chatId, kind, invite } = req.body || {};

      if (!CALL_KINDS.includes(kind)) {
        return res.status(400).json({ error: "Invalid call type." });
      }
      if (!validAuthBlock(invite) || !isIntegerMs(Number(invite.ts))) {
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
            eph: invite.eph,
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

        const calleeOnline =
          typeof isUserConnected === "function" && isUserConnected(calleeRow.username);
        if (!calleeOnline && typeof sendPushNotificationToUsers === "function") {
          void Promise.resolve(
            sendPushNotificationToUsers([calleeRow.id], {
              title: caller.nickname || caller.username,
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
      if (!validAuthBlock(accept)) {
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
        return res.json({ ok: true });
      } catch (error) {
        return sendCallError(res, error);
      }
    },
  );

  app.post(
    "/api/calls/:callId/signal",
    signalLimiter,
    validateUuidParams("callId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      const { kind, blob, seq } = req.body || {};
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
      const peer = role === "caller" ? call.callee : call.caller;
      emit(peer.username, {
        type: "call_signal",
        callId: call.id,
        kind,
        blob,
        seq: Number.isInteger(seq) ? seq : 0,
        toDeviceId: role === "caller" ? call.calleeDeviceId : call.callerDeviceId,
      });
      return res.json({ ok: true });
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

  // Cancel (caller, ringing), decline (callee, ringing) or hang up.
  app.post(
    "/api/calls/:callId/end",
    validateUuidParams("callId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      try {
        const ended = callRegistry.endBy(req.params.callId, user.id, req.body?.reason);
        if (ended) endAndNotify(ended, ended.endReason, user.id);
        return res.json({ ok: true });
      } catch (error) {
        return sendCallError(res, error);
      }
    },
  );
}

export { registerCallRoutes };

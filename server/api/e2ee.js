import rateLimit from "express-rate-limit";
import { validateUuidParams } from "../lib/uuidMiddleware.js";
import {
  isValidP256PublicKey,
  sanitizeDeviceLabel,
} from "../lib/e2eeKeys.js";

const MAX_ACTIVE_DEVICES_PER_USER = 20;

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

function serializeDevice(row, usernameById = null) {
  return {
    id: row.id,
    userId: row.user_id,
    ...(usernameById ? { username: usernameById.get(row.user_id) || null } : {}),
    label: row.label || null,
    ecdhPublic: row.ecdh_public,
    ecdsaPublic: row.ecdsa_public,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * End-to-end encryption device directory.
 *
 * The server stores and serves PUBLIC identity keys only. Private keys are
 * generated and kept (non-extractable) in the user's browser/app.
 */
function registerE2eeRoutes(app, deps) {
  const {
    requireSession,
    findUserByUsername,
    findDmChat,
    isMember,
    listChatMembers,
    findE2eeDevice,
    createE2eeDevice,
    countActiveE2eeDevices,
    touchE2eeDevice,
    revokeE2eeDevice,
    listE2eeDevicesByUserIds,
  } = deps;

  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: "Too many device registrations." }),
  });

  const resolveCaller = async (req, res) => {
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

  // Register (or re-confirm) this device's public keys. Keys of an existing
  // device id are immutable: a changed key always becomes a NEW device so
  // peers can detect it, instead of silently replacing trusted keys.
  app.post("/api/e2ee/devices", registerLimiter, async (req, res) => {
    const user = await resolveCaller(req, res);
    if (!user) return;

    const { deviceId, ecdhPublic, ecdsaPublic, label } = req.body || {};
    if (!isValidP256PublicKey(ecdhPublic) || !isValidP256PublicKey(ecdsaPublic)) {
      return res.status(400).json({ error: "Invalid public key." });
    }

    if (deviceId) {
      const existing = await maybe(findE2eeDevice(user.id, String(deviceId)));
      if (
        existing &&
        !existing.revoked_at &&
        existing.ecdh_public === ecdhPublic &&
        existing.ecdsa_public === ecdsaPublic
      ) {
        await maybe(touchE2eeDevice(user.id, existing.id));
        return res.json({ device: serializeDevice(existing) });
      }
    }

    const active = await maybe(countActiveE2eeDevices(user.id));
    if (Number(active) >= MAX_ACTIVE_DEVICES_PER_USER) {
      return res.status(409).json({
        error: "Too many devices. Remove an old device first.",
      });
    }

    const device = await maybe(
      createE2eeDevice({
        userId: user.id,
        label: sanitizeDeviceLabel(label),
        ecdhPublic,
        ecdsaPublic,
      }),
    );
    return res.status(201).json({ device: serializeDevice(device) });
  });

  app.get("/api/e2ee/devices", async (req, res) => {
    const user = await resolveCaller(req, res);
    if (!user) return;
    const rows = (await maybe(listE2eeDevicesByUserIds([user.id]))) || [];
    return res.json({ devices: rows.map((row) => serializeDevice(row)) });
  });

  app.delete(
    "/api/e2ee/devices/:deviceId",
    validateUuidParams("deviceId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      const changed = await maybe(revokeE2eeDevice(user.id, req.params.deviceId));
      if (!changed) return res.status(404).json({ error: "Device not found." });
      return res.json({ ok: true });
    },
  );

  // Public keys of another user. Limited to people the caller already has a
  // direct chat with (or the caller themself) so the directory cannot be
  // used to enumerate arbitrary accounts.
  app.get(
    "/api/e2ee/users/:userId/devices",
    validateUuidParams("userId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      const targetId = req.params.userId;
      if (targetId !== user.id) {
        const dmChatId = await maybe(findDmChat(user.id, targetId));
        if (!dmChatId) {
          return res.status(403).json({ error: "No direct chat with this user." });
        }
      }
      const rows = (await maybe(listE2eeDevicesByUserIds([targetId]))) || [];
      return res.json({ devices: rows.map((row) => serializeDevice(row)) });
    },
  );

  // Every active device of every member of a chat: the recipient list a
  // sender needs to wrap a message key for.
  app.get(
    "/api/e2ee/chats/:chatId/devices",
    validateUuidParams("chatId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      const chatId = req.params.chatId;
      const member = await maybe(isMember(chatId, user.id));
      if (!member) return res.status(403).json({ error: "Not a member of this chat." });

      const members = (await maybe(listChatMembers(chatId))) || [];
      const usernameById = new Map(members.map((m) => [m.id, m.username]));
      const rows =
        (await maybe(listE2eeDevicesByUserIds(members.map((m) => m.id)))) || [];
      const withDevice = new Set(rows.map((row) => row.user_id));
      return res.json({
        devices: rows.map((row) => serializeDevice(row, usernameById)),
        membersWithoutDevice: members
          .filter((m) => !withDevice.has(m.id))
          .map((m) => ({ userId: m.id, username: m.username })),
      });
    },
  );
}

export { registerE2eeRoutes, MAX_ACTIVE_DEVICES_PER_USER };

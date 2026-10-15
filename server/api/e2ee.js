import { validateUuidParams } from "../lib/uuidMiddleware.js";
import { isValidUuid } from "../lib/uuidUtils.js";
import { createThrottle } from "../lib/throttle.js";
import {
  isValidP256PublicKey,
  sanitizeDeviceLabel,
} from "../lib/e2eeKeys.js";

const MAX_ACTIVE_DEVICES_PER_USER = 20;
// New devices per person per hour. Re-confirming an existing device (which the
// app does on every start) is not counted.
const MAX_NEW_DEVICES_PER_HOUR = 12;

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
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
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
    revokeStalestE2eeDevice,
    userHasMessageInChat,
    listE2eeDevicesByUserIds,
  } = deps;

  const newDeviceThrottle = createThrottle({
    windowMs: 60 * 60 * 1000,
    max: Number(deps.e2eeNewDevicesPerHour) || MAX_NEW_DEVICES_PER_HOUR,
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
  app.post("/api/e2ee/devices", async (req, res) => {
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

    // Only creating a device is throttled, per person (not per IP address:
    // behind a proxy or a shared NAT everybody would share one bucket).
    if (!newDeviceThrottle.take(user.id)) {
      return res.status(429).json({ error: "Too many new devices. Try again later." });
    }

    // Browsers that lose their storage (private windows, cleared site data)
    // register a fresh device each time. Rather than locking the person out at
    // the cap, retire whichever device has been idle the longest.
    const active = await maybe(countActiveE2eeDevices(user.id));
    if (Number(active) >= MAX_ACTIVE_DEVICES_PER_USER) {
      const evicted =
        typeof revokeStalestE2eeDevice === "function"
          ? await maybe(revokeStalestE2eeDevice(user.id))
          : null;
      if (!evicted) {
        return res.status(409).json({
          error: "Too many devices. Remove an old device first.",
        });
      }
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

  // Public keys of another user. Limited to the caller themself, to people the
  // caller has a direct chat with, and to people who share a chat with the
  // caller when that chat is named (`?chatId=`), so a group member's messages
  // can be verified without a DM. This keeps the directory from being used to
  // enumerate arbitrary accounts.
  //
  // `?deviceId=` additionally returns that one device when it was revoked, so
  // that messages it signed while it was active can still be verified.
  app.get(
    "/api/e2ee/users/:userId/devices",
    validateUuidParams("userId"),
    async (req, res) => {
      const user = await resolveCaller(req, res);
      if (!user) return;
      const targetId = req.params.userId;

      const chatId = typeof req.query?.chatId === "string" ? req.query.chatId : "";
      const wantedDeviceId =
        typeof req.query?.deviceId === "string" ? req.query.deviceId : "";
      if ((chatId && !isValidUuid(chatId)) || (wantedDeviceId && !isValidUuid(wantedDeviceId))) {
        return res.status(400).json({ error: "Invalid identifier." });
      }

      let allowed = targetId === user.id;
      if (!allowed) {
        allowed = Boolean(await maybe(findDmChat(user.id, targetId)));
      }
      if (!allowed && chatId && (await maybe(isMember(chatId, user.id)))) {
        allowed =
          Boolean(await maybe(isMember(chatId, targetId))) ||
          (typeof userHasMessageInChat === "function" &&
            Boolean(await maybe(userHasMessageInChat(chatId, targetId))));
      }
      if (!allowed) {
        return res.status(403).json({ error: "No shared chat with this user." });
      }

      const rows = (await maybe(listE2eeDevicesByUserIds([targetId]))) || [];
      const devices = rows.map((row) => serializeDevice(row));
      if (wantedDeviceId && !devices.some((d) => d.id === wantedDeviceId)) {
        const old = await maybe(findE2eeDevice(targetId, wantedDeviceId));
        if (old && old.revoked_at) devices.push(serializeDevice(old));
      }
      return res.json({ devices });
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

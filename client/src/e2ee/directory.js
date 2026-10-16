// Cached lookups of other people's public device keys, with trust-on-first-use
// checks applied on every fetch.
//
// Every device handed out carries `pending: true` while it has not been
// acknowledged on this device (see trust.js). Callers decide what that means:
// calls and video messages refuse unacknowledged devices of verified people and
// warn for everybody else. The assessment is never discarded.

import { TRUST } from "./trust.js";
import { isValidUuid } from "../utils/uuidUtils.js";

export class KeyMismatchError extends Error {
  constructor(userId, deviceIds) {
    super("A contact's security keys changed unexpectedly. The action was blocked.");
    this.name = "KeyMismatchError";
    this.userId = userId;
    this.deviceIds = deviceIds;
  }
}

const normalize = (device) => ({
  id: device.id,
  userId: device.userId,
  username: device.username || null,
  label: device.label || null,
  ecdhPublic: device.ecdhPublic,
  ecdsaPublic: device.ecdsaPublic,
  ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
});

// The server only ever hands out UUID device ids. Anything else (such as
// "__proto__") is not a device, so it is never trusted or sent a key.
const hasValidId = (device) => isValidUuid(device?.id);

const markPending = (devices, assessment) =>
  devices.map((device) => ({ ...device, pending: assessment.added.includes(device.id) }));

export function createDirectory({ api, trust, ttlMs = 60_000, now = () => Date.now() }) {
  const userCache = new Map(); // userId -> {at, devices, assessment}

  async function getUserDevices(userId, { force = false, chatId } = {}) {
    const cached = userCache.get(userId);
    if (!force && cached && now() - cached.at < ttlMs) return cached;

    const { devices } = await api.fetchUserDevices(userId, { chatId });
    const list = (devices || []).filter((d) => !d.revokedAt && hasValidId(d)).map(normalize);
    const assessment = await trust.assess(userId, list);
    if (assessment.status === TRUST.KEY_MISMATCH) {
      userCache.delete(userId);
      throw new KeyMismatchError(userId, assessment.mismatched);
    }
    const entry = { at: now(), devices: markPending(list, assessment), assessment };
    userCache.set(userId, entry);
    return entry;
  }

  /**
   * Finds one device of `userId`, re-fetching once if it is not cached yet.
   * Resolves to the device (with `pending` set) or null.
   *
   * @param {object} [options]
   * @param {string} [options.chatId]        a chat both people are in (group members
   *                                         usually have no direct chat)
   * @param {boolean} [options.allowRevoked] also look for a revoked device, to
   *                                         verify something it signed while active
   */
  async function findDevice(userId, deviceId, { chatId, allowRevoked = false } = {}) {
    let entry = await getUserDevices(userId, { chatId });
    let device = entry.devices.find((d) => d.id === deviceId);
    if (!device) {
      entry = await getUserDevices(userId, { force: true, chatId });
      device = entry.devices.find((d) => d.id === deviceId);
    }
    if (!device && allowRevoked) {
      const { devices } = await api.fetchUserDevices(userId, { chatId, deviceId });
      const old = (devices || []).find((d) => d.id === deviceId && d.revokedAt);
      // A revoked key can still prove who signed an old message. It never
      // becomes a recipient and is never pinned. Only the keys we pinned
      // before the device was retired count as known: a revoked device the
      // server makes up now is as unconfirmed as any other new device.
      if (old && hasValidId(old)) {
        const retired = normalize(old);
        device = { ...retired, pending: !(await trust.wasRetiredDevice(userId, retired)) };
      }
    }
    return device || null;
  }

  /**
   * Every active device of every chat member, with TOFU applied per person.
   * `changes` lists the people (possibly including you) who have devices that
   * this device has not acknowledged yet.
   */
  async function getChatDevices(chatId) {
    const data = await api.fetchChatDevices(chatId);
    const devices = (data.devices || []).filter(hasValidId).map(normalize);
    const byUser = new Map();
    devices.forEach((d) => {
      if (!byUser.has(d.userId)) byUser.set(d.userId, []);
      byUser.get(d.userId).push(d);
    });

    const changes = [];
    const pendingIds = new Set();
    for (const [userId, list] of byUser) {
      const assessment = await trust.assess(userId, list);
      if (assessment.status === TRUST.KEY_MISMATCH) {
        throw new KeyMismatchError(userId, assessment.mismatched);
      }
      if (assessment.status === TRUST.DEVICES_ADDED) {
        assessment.added.forEach((id) => pendingIds.add(id));
        changes.push({
          userId,
          username: list[0]?.username || null,
          added: assessment.added,
          verified: assessment.verified,
        });
      }
    }
    return {
      devices: devices.map((d) => ({ ...d, pending: pendingIds.has(d.id) })),
      membersWithoutDevice: data.membersWithoutDevice || [],
      changes,
    };
  }

  /** Accepts the devices currently listed for `userId` (see trust.acknowledge). */
  async function acknowledge(userId, devices) {
    await trust.acknowledge(
      userId,
      devices.map(({ id, ecdhPublic, ecdsaPublic }) => ({ id, ecdhPublic, ecdsaPublic })),
    );
    userCache.delete(userId);
  }

  return {
    getUserDevices,
    findDevice,
    getChatDevices,
    acknowledge,
    invalidate: (userId) => userCache.delete(userId),
    clear: () => userCache.clear(),
  };
}

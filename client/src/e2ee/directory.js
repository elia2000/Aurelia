// Cached lookups of other people's public device keys, with trust-on-first-use
// checks applied on every fetch.

import { TRUST } from "./trust.js";

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
});

export function createDirectory({ api, trust, ttlMs = 60_000, now = () => Date.now() }) {
  const userCache = new Map(); // userId -> {at, devices, assessment}

  async function getUserDevices(userId, { force = false } = {}) {
    const cached = userCache.get(userId);
    if (!force && cached && now() - cached.at < ttlMs) return cached;

    const { devices } = await api.fetchUserDevices(userId);
    const list = (devices || []).map(normalize);
    const assessment = await trust.assess(userId, list);
    if (assessment.status === TRUST.KEY_MISMATCH) {
      userCache.delete(userId);
      throw new KeyMismatchError(userId, assessment.mismatched);
    }
    const entry = { at: now(), devices: list, assessment };
    userCache.set(userId, entry);
    return entry;
  }

  /** Finds one device of `userId`, re-fetching once if it is not cached yet. */
  async function findDevice(userId, deviceId) {
    let entry = await getUserDevices(userId);
    let device = entry.devices.find((d) => d.id === deviceId);
    if (!device) {
      entry = await getUserDevices(userId, { force: true });
      device = entry.devices.find((d) => d.id === deviceId);
    }
    return device || null;
  }

  /** Every active device of every chat member, with TOFU applied per person. */
  async function getChatDevices(chatId) {
    const data = await api.fetchChatDevices(chatId);
    const devices = (data.devices || []).map(normalize);
    const byUser = new Map();
    devices.forEach((d) => {
      if (!byUser.has(d.userId)) byUser.set(d.userId, []);
      byUser.get(d.userId).push(d);
    });
    for (const [userId, list] of byUser) {
      const assessment = await trust.assess(userId, list);
      if (assessment.status === TRUST.KEY_MISMATCH) {
        throw new KeyMismatchError(userId, assessment.mismatched);
      }
    }
    return { devices, membersWithoutDevice: data.membersWithoutDevice || [] };
  }

  return {
    getUserDevices,
    findDevice,
    getChatDevices,
    invalidate: (userId) => userCache.delete(userId),
    clear: () => userCache.clear(),
  };
}

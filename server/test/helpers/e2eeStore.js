/**
 * In-memory stand-ins for the E2EE device directory and the realtime emitter,
 * shaped like the db.js functions the routes depend on.
 */
import { generateUuid } from "../../lib/uuidUtils.js";

export function makeE2eeStore() {
  const devices = new Map(); // id -> row
  const nowTs = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  return {
    devices,
    findE2eeDevice: (userId, deviceId) => {
      const row = devices.get(deviceId);
      return row && row.user_id === userId ? row : null;
    },
    countActiveE2eeDevices: (userId) =>
      [...devices.values()].filter((d) => d.user_id === userId && !d.revoked_at).length,
    createE2eeDevice: ({ userId, label, ecdhPublic, ecdsaPublic }) => {
      const row = {
        id: generateUuid(),
        user_id: userId,
        label: label || null,
        ecdh_public: ecdhPublic,
        ecdsa_public: ecdsaPublic,
        created_at: nowTs(),
        last_seen_at: nowTs(),
        revoked_at: null,
      };
      devices.set(row.id, row);
      return row;
    },
    touchE2eeDevice: (userId, deviceId) => {
      const row = devices.get(deviceId);
      if (!row || row.user_id !== userId || row.revoked_at) return 0;
      row.last_seen_at = nowTs();
      return 1;
    },
    revokeE2eeDevice: (userId, deviceId) => {
      const row = devices.get(deviceId);
      if (!row || row.user_id !== userId || row.revoked_at) return 0;
      row.revoked_at = nowTs();
      return 1;
    },
    listE2eeDevicesByUserIds: (userIds = []) =>
      [...devices.values()].filter(
        (d) => userIds.includes(d.user_id) && !d.revoked_at,
      ),
  };
}

export function makeEventRecorder() {
  const events = [];
  return {
    events,
    emitToUser: (username, payload) => events.push({ username, payload }),
    of: (type) => events.filter((e) => e.payload.type === type),
    clear: () => {
      events.length = 0;
    },
  };
}

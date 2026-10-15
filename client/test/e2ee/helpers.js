import { generateDeviceKeys, exportPublicRaw } from "../../src/e2ee/crypto.js";
import { randomUuid, toB64u } from "../../src/e2ee/encoding.js";

/** A device identity shaped like the one `loadOrCreateIdentity` returns. */
export async function makeIdentity(userId = randomUuid(), deviceId = randomUuid()) {
  const keys = await generateDeviceKeys();
  const ecdhPublic = toB64u(await exportPublicRaw(keys.ecdh.publicKey));
  const ecdsaPublic = toB64u(await exportPublicRaw(keys.ecdsa.publicKey));
  return {
    identity: { userId, deviceId, keys, ecdhPublic, ecdsaPublic },
    /** How the directory lists this device to other people. */
    record: { id: deviceId, userId, label: "test", ecdhPublic, ecdsaPublic },
  };
}

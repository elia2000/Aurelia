// Cryptographic protocol for 1:1 calls (signaling layer).
//
//   caller                                         callee
//   ------                                         ------
//   eph_C  ──signed(identity_C)── invite ─────────▶ verify with identity_C
//                                  ◀── accept ──── eph_R, signed(identity_R)
//   shared = ECDH(eph_C, eph_R)   (forward secret; ephemerals are discarded)
//   keys   = HKDF(shared, transcript)  → caller→callee key, callee→caller key, SAS
//   SDP offer/answer + ICE candidates travel only as AES-256-GCM blobs
//
// Because the SDP (which carries the DTLS certificate fingerprint) is
// authenticated end to end, the signaling server cannot splice itself into the
// DTLS-SRTP media session. The media itself stays peer-to-peer (or via a TURN
// relay that only ever sees SRTP ciphertext).

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  ecdhSharedBits,
  exportPublicRaw,
  generateEphemeralEcdh,
  hkdfBytes,
  importAesKey,
  importEcdhPublic,
  importEcdsaPublic,
  sha256,
  signBytes,
  verifyBytes,
} from "../e2ee/crypto.js";
import { concatBytes, encodeFields, fromB64u, toB64u, utf8 } from "../e2ee/encoding.js";

const V = "AURELLE-CALL-V1";
export const INVITE_MAX_AGE_MS = 3 * 60 * 1000;

export const inviteSigInput = ({ callId, callerUserId, calleeUserId, kind, callerDeviceId, eph, ts }) =>
  encodeFields(`${V}/invite`, [callId, callerUserId, calleeUserId, kind, callerDeviceId, eph, String(ts)]);

export const acceptSigInput = ({ callId, calleeDeviceId, ephCaller, ephCallee }) =>
  encodeFields(`${V}/accept`, [callId, calleeDeviceId, ephCaller, ephCallee]);

async function newEphemeral() {
  const pair = await generateEphemeralEcdh();
  return { pair, pub: toB64u(await exportPublicRaw(pair.publicKey)) };
}

export async function createInvite({ callId, calleeUserId, kind, identity }) {
  const { pair, pub } = await newEphemeral();
  const ts = Date.now();
  const signature = await signBytes(
    identity.keys.ecdsa.privateKey,
    inviteSigInput({
      callId,
      callerUserId: identity.userId,
      calleeUserId,
      kind,
      callerDeviceId: identity.deviceId,
      eph: pub,
      ts,
    }),
  );
  return {
    ephemeral: { privateKey: pair.privateKey, pub },
    invite: { deviceId: identity.deviceId, eph: pub, ts, sig: toB64u(signature) },
  };
}

/** @param callerDevice the caller's device record from the directory */
export async function verifyInvite({ invite, callId, callerUserId, calleeUserId, kind, callerDevice, now = Date.now() }) {
  try {
    if (!callerDevice || callerDevice.id !== invite.deviceId || callerDevice.userId !== callerUserId) {
      return false;
    }
    if (Math.abs(now - Number(invite.ts)) > INVITE_MAX_AGE_MS) return false;
    return await verifyBytes(
      await importEcdsaPublic(fromB64u(callerDevice.ecdsaPublic)),
      fromB64u(invite.sig),
      inviteSigInput({
        callId,
        callerUserId,
        calleeUserId,
        kind,
        callerDeviceId: invite.deviceId,
        eph: invite.eph,
        ts: invite.ts,
      }),
    );
  } catch {
    return false;
  }
}

export async function createAccept({ callId, ephCaller, identity }) {
  const { pair, pub } = await newEphemeral();
  const signature = await signBytes(
    identity.keys.ecdsa.privateKey,
    acceptSigInput({
      callId,
      calleeDeviceId: identity.deviceId,
      ephCaller,
      ephCallee: pub,
    }),
  );
  return {
    ephemeral: { privateKey: pair.privateKey, pub },
    accept: { deviceId: identity.deviceId, eph: pub, sig: toB64u(signature) },
  };
}

/** @param calleeDevice the answering device's record from the directory */
export async function verifyAccept({ accept, callId, ephCaller, calleeUserId, calleeDevice }) {
  try {
    if (!calleeDevice || calleeDevice.id !== accept.deviceId || calleeDevice.userId !== calleeUserId) {
      return false;
    }
    return await verifyBytes(
      await importEcdsaPublic(fromB64u(calleeDevice.ecdsaPublic)),
      fromB64u(accept.sig),
      acceptSigInput({
        callId,
        calleeDeviceId: accept.deviceId,
        ephCaller,
        ephCallee: accept.eph,
      }),
    );
  } catch {
    return false;
  }
}

/**
 * Derives the per-call secrets once both ephemeral keys are known.
 * `role` selects which directional key sends and which receives.
 */
export async function deriveCallSession({ ephemeralPrivateKey, peerEph, callId, ephCaller, ephCallee, role }) {
  const shared = await ecdhSharedBits(ephemeralPrivateKey, await importEcdhPublic(fromB64u(peerEph)));
  const salt = await sha256(encodeFields(`${V}/transcript`, [callId, ephCaller, ephCallee]));
  const [c2r, r2c, sasBytes] = await Promise.all([
    hkdfBytes(shared, salt, `${V}/key/caller-to-callee`, 32),
    hkdfBytes(shared, salt, `${V}/key/callee-to-caller`, 32),
    hkdfBytes(shared, salt, `${V}/sas`, 4),
  ]);
  const [keyC2r, keyR2c] = await Promise.all([importAesKey(c2r), importAesKey(r2c)]);
  const isCaller = role === "caller";
  return {
    callId,
    role,
    sendDir: isCaller ? "c2r" : "r2c",
    recvDir: isCaller ? "r2c" : "c2r",
    sendKey: isCaller ? keyC2r : keyR2c,
    recvKey: isCaller ? keyR2c : keyC2r,
    sasBytes,
  };
}

const signalAad = (callId, dir, kind, seq) =>
  encodeFields(`${V}/signal`, [callId, dir, kind, String(seq)]);

/** Encrypts a JSON-serialisable payload; returns base64url(iv || ciphertext). */
export async function sealSignal(session, { kind, seq, payload }) {
  const plaintext = utf8(JSON.stringify(payload));
  const { iv, ct } = await aesGcmEncrypt(
    session.sendKey,
    plaintext,
    signalAad(session.callId, session.sendDir, kind, seq),
  );
  return toB64u(concatBytes(iv, ct));
}

/** Throws if the blob was not produced by the peer for this call/kind/seq. */
export async function openSignal(session, { kind, seq, blob }) {
  const bytes = fromB64u(blob);
  if (bytes.length < 12 + 16) throw new Error("Signal too short.");
  const plaintext = await aesGcmDecrypt(
    session.recvKey,
    bytes.subarray(0, 12),
    bytes.subarray(12),
    signalAad(session.callId, session.recvDir, kind, seq),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// Cryptographic protocol for 1:1 calls (signaling layer), version 2.
//
//   caller                                                 callee
//   ------                                                 ------
//   commit = H(eph_C)
//   invite{commit}  ──signed(identity_C)────────────────▶  verify with identity_C
//                   ◀── accept{eph_R, signed(identity_R)}  the signature covers both
//                                                          identities, the call type
//                                                          and the caller's commitment
//   first offer carries eph_C in the clear; the callee checks H(eph_C) == commit
//   shared = ECDH(eph_C, eph_R)   (forward secret; ephemerals are discarded)
//   keys   = HKDF(shared, transcript)  → caller→callee key, callee→caller key, SAS
//   SDP offer/answer + ICE candidates travel only as AES-256-GCM blobs
//
// The caller commits to its ephemeral key BEFORE it sees the callee's, and
// reveals it only afterwards. Without that, whoever sits in the middle of a
// call (and has forged both people's directory entries) could keep trying keys
// toward one side until the four emoji happen to agree: about 2^32 tries
// instead of a single 2^-32 chance. With the commitment each side's key is
// fixed before the other's is known, so the emoji comparison is a real check.
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

const V = "AURELLE-CALL-V2";
// How far an invite's timestamp may be from the callee's own clock. The server
// already limits it to two minutes of ITS clock; this wider window only guards
// against a very old invite being replayed, and tolerates a phone whose clock
// is a few minutes off.
export const INVITE_MAX_AGE_MS = 10 * 60 * 1000;

/** Commitment to an ephemeral public key (base64url) for a given call. */
export async function ephemeralCommitment(callId, ephPub) {
  return toB64u(await sha256(encodeFields(`${V}/commit`, [callId, ephPub])));
}

export const inviteSigInput = ({ callId, callerUserId, calleeUserId, kind, callerDeviceId, commit, ts }) =>
  encodeFields(`${V}/invite`, [callId, callerUserId, calleeUserId, kind, callerDeviceId, commit, String(ts)]);

// Signing the whole call context (both people, both devices, the call type and
// the caller's commitment) stops a hostile server from presenting someone
// else's invite, or the same ephemeral key, under another identity.
export const acceptSigInput = ({
  callId,
  callerUserId,
  callerDeviceId,
  calleeUserId,
  calleeDeviceId,
  kind,
  commit,
  ephCallee,
}) =>
  encodeFields(`${V}/accept`, [
    callId,
    callerUserId,
    callerDeviceId,
    calleeUserId,
    calleeDeviceId,
    kind,
    commit,
    ephCallee,
  ]);

async function newEphemeral() {
  const pair = await generateEphemeralEcdh();
  return { pair, pub: toB64u(await exportPublicRaw(pair.publicKey)) };
}

export async function createInvite({ callId, calleeUserId, kind, identity }) {
  const { pair, pub } = await newEphemeral();
  const ts = Date.now();
  const commit = await ephemeralCommitment(callId, pub);
  const signature = await signBytes(
    identity.keys.ecdsa.privateKey,
    inviteSigInput({
      callId,
      callerUserId: identity.userId,
      calleeUserId,
      kind,
      callerDeviceId: identity.deviceId,
      commit,
      ts,
    }),
  );
  return {
    ephemeral: { privateKey: pair.privateKey, pub },
    invite: { deviceId: identity.deviceId, commit, ts, sig: toB64u(signature) },
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
        commit: invite.commit,
        ts: invite.ts,
      }),
    );
  } catch {
    return false;
  }
}

/**
 * @param {object} args
 * @param {string} args.callId
 * @param {object} args.invite             the verified invite being answered
 * @param {string} args.callerUserId
 * @param {string} args.calleeUserId
 * @param {string} args.kind
 * @param {object} args.identity           this (callee) device
 */
export async function createAccept({ callId, invite, callerUserId, calleeUserId, kind, identity }) {
  const { pair, pub } = await newEphemeral();
  const signature = await signBytes(
    identity.keys.ecdsa.privateKey,
    acceptSigInput({
      callId,
      callerUserId,
      callerDeviceId: invite.deviceId,
      calleeUserId,
      calleeDeviceId: identity.deviceId,
      kind,
      commit: invite.commit,
      ephCallee: pub,
    }),
  );
  return {
    ephemeral: { privateKey: pair.privateKey, pub },
    accept: { deviceId: identity.deviceId, eph: pub, sig: toB64u(signature) },
  };
}

/**
 * @param {object} args
 * @param {object} args.invite       the invite THIS caller sent
 * @param {object} args.calleeDevice the answering device's record from the directory
 */
export async function verifyAccept({ accept, callId, invite, callerUserId, calleeUserId, kind, calleeDevice }) {
  try {
    if (!calleeDevice || calleeDevice.id !== accept.deviceId || calleeDevice.userId !== calleeUserId) {
      return false;
    }
    return await verifyBytes(
      await importEcdsaPublic(fromB64u(calleeDevice.ecdsaPublic)),
      fromB64u(accept.sig),
      acceptSigInput({
        callId,
        callerUserId,
        callerDeviceId: invite.deviceId,
        calleeUserId,
        calleeDeviceId: accept.deviceId,
        kind,
        commit: invite.commit,
        ephCallee: accept.eph,
      }),
    );
  } catch {
    return false;
  }
}

/** True when `eph` is the key the caller committed to in its invite. */
export async function verifyReveal({ callId, commit, eph }) {
  try {
    return typeof eph === "string" && (await ephemeralCommitment(callId, eph)) === commit;
  } catch {
    return false;
  }
}

/**
 * Derives the per-call secrets once both ephemeral keys are known.
 * `role` selects which directional key sends and which receives.
 */
export async function deriveCallSession({
  ephemeralPrivateKey,
  peerEph,
  callId,
  callerUserId,
  callerDeviceId,
  calleeUserId,
  calleeDeviceId,
  kind,
  commit,
  ephCaller,
  ephCallee,
  role,
}) {
  const shared = await ecdhSharedBits(ephemeralPrivateKey, await importEcdhPublic(fromB64u(peerEph)));
  const salt = await sha256(
    encodeFields(`${V}/transcript`, [
      callId,
      callerUserId,
      callerDeviceId,
      calleeUserId,
      calleeDeviceId,
      kind,
      commit,
      ephCaller,
      ephCallee,
    ]),
  );
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

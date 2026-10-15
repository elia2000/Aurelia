# End-to-End Encryption Protocol

This page specifies how Aurelle's end-to-end encrypted **calls** and **video messages** work, so that you can build interoperable native apps. The reference implementation lives in the repository:

| Part | File |
|---|---|
| Primitives and encodings | `client/src/e2ee/crypto.js`, `client/src/e2ee/encoding.js` |
| Device keys, directory, trust | `client/src/e2ee/identity.js`, `directory.js`, `trust.js` |
| Safety number, emoji code | `client/src/e2ee/safetyNumber.js`, `sas.js`, `sasEmoji.js` |
| Call handshake and signaling | `client/src/calls/callCrypto.js`, `callManager.js` |
| Video message envelope | `client/src/e2ee/videoNoteCrypto.js` |
| Server | `server/api/e2ee.js`, `server/api/calls.js`, `server/lib/e2eeEnvelope.js` |

## Primitives

| Purpose | Algorithm |
|---|---|
| Key agreement | ECDH, curve **P-256** |
| Signatures | ECDSA, curve **P-256**, SHA-256, **raw `r‖s`** (64 bytes, WebCrypto format, not DER) |
| Key derivation | HKDF-SHA-256 |
| Encryption | AES-256-GCM, 96-bit random IV, 128-bit tag |
| Hashes | SHA-256, SHA-512 |
| Media (calls) | WebRTC DTLS-SRTP, with the DTLS fingerprint authenticated by the handshake below |

**Encodings.** Binary values on the wire are **base64url without padding**. Public keys are the **uncompressed point** `0x04 ‖ X ‖ Y` (65 bytes). The server rejects points that are not on the curve.

**`encodeFields(domain, fields)`** is used for everything that is signed or used as AEAD associated data. It is `u32be(len(domain)) ‖ domain ‖ u32be(count) ‖ (u32be(len(f)) ‖ f)…` where every item is UTF-8 text or raw bytes. The length prefixes make the encoding unambiguous, and the domain label separates the message types.

## Devices

Every app install is a **device** and generates two P-256 key pairs: an **ECDH** pair and an **ECDSA** pair. Private keys never leave the device (the web client stores them as non-extractable `CryptoKey`s in IndexedDB). The public halves are registered with the server.

| Endpoint | Purpose |
|---|---|
| `POST /api/e2ee/devices` `{deviceId?, ecdhPublic, ecdsaPublic, label?}` | Register or re-confirm a device. Returns `{device: {id, …}}`. The keys of an existing id are immutable: sending different keys creates a **new** device. At most 20 active devices per user. |
| `GET /api/e2ee/devices` | Your active devices. |
| `DELETE /api/e2ee/devices/:id` | Revoke one of your devices. |
| `GET /api/e2ee/users/:userId/devices` | Another person's devices. Allowed only with a direct chat. |
| `GET /api/e2ee/chats/:chatId/devices` | Devices of every member of a chat, plus `membersWithoutDevice`. |

**Trust on first use.** A client remembers the fingerprint `SHA-256(ecdhPublic ‖ ecdsaPublic)` of every device it has seen. A known device id that later presents different keys is a hard error and must block the action. A new device of a known person is reported once.

### Safety number

For each person: `fps` = sorted lowercase hex of the fingerprints of all their devices; `input = utf8("aurelle-safety-v1:" + userId + ":") ‖ utf8(fps.join(","))`; `h = SHA-512(input)`, then 1024 times `h = SHA-512(h ‖ input)`. Take 6 chunks of 5 bytes, interpret each as a big-endian integer, reduce modulo 100000 and pad to 5 digits (30 digits). The safety number is the two 30-digit strings **sorted lexicographically and concatenated** (60 digits, shown in groups of five). Adding or removing a device changes it.

## Calls

### Handshake

1. **Invite.** The caller generates an ephemeral ECDH key `eC` and signs
   `encodeFields("AURELLE-CALL-V1/invite", [callId, callerUserId, calleeUserId, kind, callerDeviceId, b64u(eC), String(ts)])`
   with its device ECDSA key. It sends `POST /api/calls {callId, chatId, kind, invite: {deviceId, eph, ts, sig}}` (`kind` is `audio` or `video`; `ts` is milliseconds and must be within two minutes of server time).
2. The callee receives `call_invite` and **verifies** the signature with the caller's device key from the directory (the device must belong to the caller).
3. **Accept.** The callee generates `eR`, signs
   `encodeFields("AURELLE-CALL-V1/accept", [callId, calleeDeviceId, b64u(eC), b64u(eR)])`
   and sends `POST /api/calls/:id/accept {accept: {deviceId, eph, sig}}`. The caller verifies it against the callee's device key.
4. **Session keys.** `shared = ECDH(ephemeral private, peer ephemeral public)`;
   `salt = SHA-256(encodeFields("AURELLE-CALL-V1/transcript", [callId, b64u(eC), b64u(eR)]))`;
   three HKDF-SHA-256 outputs with that salt and these `info` strings (UTF-8):
   - `AURELLE-CALL-V1/key/caller-to-callee`, 32 bytes
   - `AURELLE-CALL-V1/key/callee-to-caller`, 32 bytes
   - `AURELLE-CALL-V1/sas`, 4 bytes (the verification code)

   The ephemeral private keys are then discarded, which gives forward secrecy.

### Encrypted signaling

SDP offers/answers and ICE candidates are sent with `POST /api/calls/:id/signal {kind, blob, seq}` where `kind ∈ {offer, answer, ice}`.

- Plaintext: the UTF-8 JSON payload, `{type, sdp}` for offer and answer, `{candidates: [RTCIceCandidateInit…]}` for ice (candidates are batched).
- `blob = b64u(iv ‖ AES-256-GCM(directionKey, iv, plaintext, aad))` with `aad = encodeFields("AURELLE-CALL-V1/signal", [callId, direction, kind, String(seq)])`, where `direction` is `c2r` for the caller and `r2c` for the callee, and the **sender's** key is used.
- `seq` starts at 1 and must strictly increase per sender and `kind`; receivers drop replays. Three authentication failures end the call.

Because the SDP, which carries the DTLS certificate fingerprint, is authenticated, a signaling server cannot insert itself into the DTLS-SRTP session.

### Verification emoji

Map each of the 4 bytes to `SAS_EMOJI[byte]` (256 distinct emoji, `client/src/e2ee/sasEmoji.js`). A man in the middle that swapped ephemeral keys produces different codes on the two screens.

### Server role and realtime events

The server tracks only the parties and state of a call (ringing, connecting, active, ended), answers *busy*, expires unanswered calls (about 45 s), and relays opaque blobs. Events are delivered over the existing WebSocket/SSE stream:

| Event | Sent to | Meaning |
|---|---|---|
| `call_invite` `{callId, kind, chatId, from, invite}` | callee | Incoming call. If the callee is offline a web push with `data.type = "call"` is sent. |
| `call_accept` `{callId, accept}` | caller | The callee answered. |
| `call_accepted_elsewhere` `{callId, deviceId}` | callee's other devices | Stop ringing. |
| `call_signal` `{callId, kind, blob, seq, toDeviceId}` | the other party | An encrypted signaling message. |
| `call_end` `{callId, reason, by}` | both | `declined`, `cancelled`, `hangup`, `missed`, `failed`, `timeout`. |

Other endpoints: `GET /api/calls/ice-config` (ICE servers with short-lived TURN credentials, plus `forceRelay`), `GET /api/calls/pending` (a call still ringing for you), `POST /api/calls/:id/connected`, `POST /api/calls/:id/end`.

**TURN credentials** follow the coturn REST scheme: `username = "<expiryUnix>:<userId>"`, `credential = base64(HMAC-SHA1(secret, username))`.

### Media recommendations

These are not required for interoperability, but they are what the web client does to save battery and data: Opus mono at about 24 kbps with `usedtx=1;useinbandfec=1`, `a=ptime:40`, a negotiated data channel (`id: 0`) for in-call state `{t:"state", muted, video}`, hardware-friendly video codecs first (H.264 baseline, then VP8), at most about 640×360 at 24 fps and 600 kbps with downward adaptation, and releasing the camera when the app is in the background.

## Video messages

### Sending

1. Fetch every recipient device with `GET /api/e2ee/chats/:chatId/devices`. The list **must include the sender's own devices**.
2. Generate a random 32-byte content key `K` and a 12-byte IV. Encrypt the video container bytes (`video/mp4` or `video/webm`):
   `ciphertext = AES-256-GCM(K, iv, media, encodeFields("AURELLE-VN-V1/media", [senderDeviceId, mime, String(durationMs)]))`.
3. Optionally encrypt a small JPEG preview (at most 12 kB) with `K`, its own IV and `encodeFields("AURELLE-VN-V1/poster", [senderDeviceId, mime, String(durationMs)])` as associated data.
4. Generate one ephemeral ECDH key for the message. For each recipient device: `wrapKey = HKDF-SHA-256(ECDH(ephemeral, device.ecdhPublic), salt = SHA-256(utf8(deviceId)), info = "AURELLE-VN-V1/wrap", 32)`, and `wrapped = AES-256-GCM(wrapKey, wrapIv, K, encodeFields("AURELLE-VN-V1/wrap", [deviceId, b64u(iv)]))` (48 bytes with the tag).
5. Build the envelope and sign it with the sender device ECDSA key over
   `encodeFields("AURELLE-VN-V1/signature", [String(v), kind, senderDeviceId, mime, String(durationMs), b64u(iv), b64u(SHA-256(ciphertext)), posterField, ...for each key: deviceId, epk, iv, ct])`,
   where `posterField` is `poster.iv + "." + poster.ct` or the empty string.
6. Upload: `POST /api/messages/upload` as `multipart/form-data` with `chatId`, `username`, `uploadType=document`, one `files` part (the ciphertext as `application/octet-stream`) and `e2eeEnvelope` (JSON). The server validates the envelope, skips transcoding and stores it with the message.

```json
{
  "v": 1,
  "kind": "video_note",
  "senderDeviceId": "<uuid>",
  "iv": "<b64u 12 bytes>",
  "durationMs": 7300,
  "mime": "video/mp4",
  "poster": { "iv": "<b64u>", "ct": "<b64u>" },
  "keys": [{ "deviceId": "<uuid>", "epk": "<b64u 65 bytes>", "iv": "<b64u 12 bytes>", "ct": "<b64u 48 bytes>" }],
  "sig": "<b64u 64 bytes>"
}
```

Limits enforced by the server: at most 61 s, 128 recipient devices, 48 kB envelope, the sender device must be one of your active devices, one file only, no channels, no edits.

### Receiving

`GET /api/messages` returns the parsed envelope as `message.e2ee`. The preview can be decrypted from the envelope alone. To play, download the file, then in this order: find your device's entry in `keys`, look up the sender's device by `senderDeviceId` **under the message author's user id**, **verify the signature**, unwrap `K`, decrypt. Any failure must be reported to the user and must not play anything. If your device has no entry, the message was sent before the device existed.

## Threat model

**Protected against:** a passive or active network attacker; a curious or compromised signaling/relay/storage server that does not modify the app delivered to users; a database or backup leak (only ciphertext and public keys are stored); a later compromise of a device or of long-term keys for past calls (forward secrecy of signaling and media).

**Not protected against, by design or by current limits:**

- **Metadata** such as who talks to whom, when, and message sizes.
- **A malicious server that serves a modified web app.** In a browser the encryption code is delivered by the server you are trying not to trust. Safety numbers and the emoji code detect a swapped key directory or a man in the middle, but not backdoored JavaScript. A native app removes this gap.
- **Key directory at first contact.** Until you verify the safety number, the first keys you see for a contact are trusted. After that, changes are detected.
- **The relay and the peer see IP addresses** unless `CALLS_FORCE_RELAY` is on, in which case only the relay sees both.
- **A compromised endpoint** can of course read everything shown on it.
- The emoji code has 32 bits. It is a quick check, not a replacement for verifying the safety number of a contact you care about.

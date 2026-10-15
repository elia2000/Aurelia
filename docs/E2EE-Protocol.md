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

**Encodings.** Binary values on the wire are **base64url without padding**. Public keys are the **uncompressed point** `0x04 ‖ X ‖ Y` (65 bytes). The server rejects points that are not on the curve (device keys, the callee's call key, the revealed caller key and every message `epk`). That is a convenience, not a guarantee: a client must validate every point it receives itself (WebCrypto does so when importing a raw key) and must never rely on the server for it.

**`encodeFields(domain, fields)`** is used for everything that is signed or used as AEAD associated data. It is `u32be(len(domain)) ‖ domain ‖ u32be(count) ‖ (u32be(len(f)) ‖ f)…` where every item is UTF-8 text or raw bytes. The length prefixes make the encoding unambiguous, and the domain label separates the message types.

## Devices

Every app install is a **device** and generates two P-256 key pairs: an **ECDH** pair and an **ECDSA** pair. Private keys never leave the device (the web client stores them as non-extractable `CryptoKey`s in IndexedDB). The public halves are registered with the server.

| Endpoint | Purpose |
|---|---|
| `POST /api/e2ee/devices` `{deviceId?, ecdhPublic, ecdsaPublic, label?}` | Register or re-confirm a device. Returns `{device: {id, …}}`. The keys of an existing id are immutable: sending different keys creates a **new** device. At most 20 active devices per user: at the cap the least recently seen one is revoked to make room. Creating devices is limited per person (12 per hour); re-confirming an existing device, which an app does on every start, is not limited. |
| `GET /api/e2ee/devices` | Your active devices. |
| `DELETE /api/e2ee/devices/:id` | Revoke one of your devices. |
| `GET /api/e2ee/users/:userId/devices[?chatId=][&deviceId=]` | Another person's devices. Allowed for yourself, with a direct chat, or when you name (`chatId`) a chat that you are a member of and that the person is a member of or has posted in. Group members therefore do not need a direct chat to verify each other's messages. `deviceId` additionally returns that device if it was **revoked** (flagged with `revokedAt`) so a message it signed while active can still be verified; a revoked device is never a recipient. |
| `GET /api/e2ee/chats/:chatId/devices` | Devices of every member of a chat, plus `membersWithoutDevice`. |

**Trust on first use.** A client remembers the fingerprint `SHA-256(ecdhPublic ‖ ecdsaPublic)` of every device it has seen. A known device id that later presents different keys is a hard error and must block the action.

The first time a person is seen, all of their devices are pinned. After that, a device the client has not seen before is an **added device**, and it is **not trusted until the user acknowledges it**: it is reported again on every lookup, so no code path can consume the warning on the user's behalf. Rules for clients:

- Never send an encrypted message to, or accept a call from, an unacknowledged device of a person the user has **verified**. The user must compare the new safety number first (verifying it also acknowledges the devices it was computed from).
- For everybody else, ask before sending ("send anyway" acknowledges the devices) and show a warning on calls.
- Acknowledging new devices ends an earlier "verified" mark, because the safety number changed.
- A device that merely signed an *incoming* message or call is subject to the same rules: block for verified people, flag for everybody else.

### Safety number

For each person: `fps` = sorted lowercase hex of the fingerprints of all their devices; `input = utf8("aurelle-safety-v1:" + userId + ":") ‖ utf8(fps.join(","))`; `h = SHA-512(input)`, then 1024 times `h = SHA-512(h ‖ input)`. Take 6 chunks of 5 bytes, interpret each as a big-endian integer, reduce modulo 100000 and pad to 5 digits (30 digits). The safety number is the two 30-digit strings **sorted lexicographically and concatenated** (60 digits, shown in groups of five). Adding or removing a device changes it.

## Calls

### Handshake (version 2)

The caller **commits** to its ephemeral key before it learns the callee's, and **reveals** it afterwards. Without the commitment, someone in the middle who had forged both people's directory entries could keep generating keys toward one side until the four emoji happen to agree (about 2^32 tries). With it, each side's key is fixed before the other's is known, so the emoji comparison gives that attacker a single 2^-32 chance per call.

1. **Invite.** The caller generates an ephemeral ECDH key `eC` and computes
   `commit = b64u(SHA-256(encodeFields("AURELLE-CALL-V2/commit", [callId, b64u(eC)])))`.
   It signs
   `encodeFields("AURELLE-CALL-V2/invite", [callId, callerUserId, calleeUserId, kind, callerDeviceId, commit, String(ts)])`
   with its device ECDSA key and sends `POST /api/calls {callId, chatId, kind, invite: {deviceId, commit, ts, sig}}`. `callId` and `chatId` must be strings; `kind` is `audio` or `video`; `ts` is milliseconds and must be within two minutes of the server's clock.
2. The callee receives `call_invite` and **verifies** the signature with the caller's device key from the directory (the device must belong to the caller). It also rejects an invite whose `ts` is more than **10 minutes** away from its own clock: that bounds replay of old invites and still tolerates a phone whose clock is a few minutes off. It should tell the user when the cause is the device clock.
3. **Accept.** The callee generates `eR` and signs
   `encodeFields("AURELLE-CALL-V2/accept", [callId, callerUserId, callerDeviceId, calleeUserId, calleeDeviceId, kind, commit, b64u(eR)])`
   and sends `POST /api/calls/:id/accept {accept: {deviceId, eph, sig}}` (`eph` is `eR`). The caller verifies it against the callee's device key **using its own invite's values**, so an accept given for another invite (another caller identity, another call type, another commitment) never authenticates this call.
4. **Reveal.** The caller sends its first `offer` (see below) with `eph: b64u(eC)` in the request body. The server relays it once, to the callee only, and refuses a second one. The callee checks that `eph` hashes to the `commit` it verified in step 1 and ends the call otherwise.
5. **Session keys.** `shared = ECDH(ephemeral private, peer ephemeral public)`;
   `salt = SHA-256(encodeFields("AURELLE-CALL-V2/transcript", [callId, callerUserId, callerDeviceId, calleeUserId, calleeDeviceId, kind, commit, b64u(eC), b64u(eR)]))`;
   three HKDF-SHA-256 outputs with that salt and these `info` strings (UTF-8):
   - `AURELLE-CALL-V2/key/caller-to-callee`, 32 bytes
   - `AURELLE-CALL-V2/key/callee-to-caller`, 32 bytes
   - `AURELLE-CALL-V2/sas`, 4 bytes (the verification code)

   The caller derives them after step 3, the callee when the reveal arrives. The ephemeral private keys are then discarded, which gives forward secrecy.

### Encrypted signaling

SDP offers/answers and ICE candidates are sent with `POST /api/calls/:id/signal {kind, blob, seq}` where `kind ∈ {offer, answer, ice}`. The very first `offer` also carries `eph` (the reveal above); no other message does.

- Plaintext: the UTF-8 JSON payload, `{type, sdp}` for offer and answer, `{candidates: [RTCIceCandidateInit…]}` for ice (candidates are batched).
- `blob = b64u(iv ‖ AES-256-GCM(directionKey, iv, plaintext, aad))` with `aad = encodeFields("AURELLE-CALL-V2/signal", [callId, direction, kind, String(seq)])`, where `direction` is `c2r` for the caller and `r2c` for the callee, and the **sender's** key is used.
- `seq` starts at 1 and must strictly increase per sender and `kind`; receivers drop replays. Three authentication failures end the call.
- The callee cannot read anything before the reveal. A callee should hold back (a handful of) messages that arrive earlier and process them once the session exists, and a caller should send its first ICE batch only after the offer was delivered.

Because the SDP, which carries the DTLS certificate fingerprint, is authenticated, a signaling server cannot insert itself into the DTLS-SRTP session.

### Verification emoji

Map each of the 4 bytes to `SAS_EMOJI[byte]` (256 distinct emoji, `client/src/e2ee/sasEmoji.js`). A man in the middle that swapped ephemeral keys produces different codes on the two screens, and thanks to the commitment cannot search for keys that make them agree.

### Server role and realtime events

The server tracks only the parties and state of a call (ringing, connecting, active, ended), answers *busy*, expires unanswered calls (about 45 s), and relays opaque blobs. Events are delivered over the existing WebSocket/SSE stream:

| Event | Sent to | Meaning |
|---|---|---|
| `call_invite` `{callId, kind, chatId, from, invite}` | callee | Incoming call. `invite` is `{deviceId, commit, ts, sig}`. A web push with `data.type = "call"` is always sent as well (it is per device: a phone with the app closed must ring even when a desktop tab is connected), unless the callee muted the chat. |
| `call_ringing` `{callId}` | caller | The callee's app is showing the incoming-call screen (it sent `POST /api/calls/:id/ringing`). Until then a caller should show *waiting*, not *ringing*: a callee whose app is closed only receives a push. Sent once. |
| `call_accept` `{callId, accept}` | caller | The callee answered. |
| `call_accepted_elsewhere` `{callId, deviceId}` | callee's other devices | Stop ringing. |
| `call_signal` `{callId, kind, blob, seq, eph?, toDeviceId}` | the other party | An encrypted signaling message; `eph` only on the caller's first offer. |
| `call_end` `{callId, reason, by}` | both | `declined`, `cancelled`, `hangup`, `missed`, `failed`, `timeout`. |

When a push was sent, a second push with `data.type = "call_end"` (`data.reason`: `missed` when the call was never answered, otherwise `answered`, `declined`, `hangup`, …) follows when the call stops ringing, so a device can remove the sticky "Incoming call" notification (or replace it with a "missed call" one). Clients must not navigate or reload an open app window when such a notification is tapped: a call lives in that window.

Other endpoints: `GET /api/calls/ice-config` (ICE servers with short-lived TURN credentials, plus `forceRelay`; `503 {code: "relay_unavailable"}` when the operator demands relayed calls but no relay is configured, so that a typo can never silently expose both IP addresses; `POST /api/calls` refuses in that case too), `GET /api/calls/pending` (a call still ringing for you; clients also ask for it whenever the realtime connection reopens, because invites are not replayed), `POST /api/calls/:id/ringing` (callee only; idempotent), `POST /api/calls/:id/connected`, `POST /api/calls/:id/end`. Throttles are per signed-in person (invites: 12 per minute and 5 per two minutes per conversation), not per IP address.

A device that learns that another device of the same person answered (`call_accepted_elsewhere` with a different `deviceId`, or a `409 not_ringing` on its own accept) drops the call **locally and quietly**: reporting `failed` to the server would end the call the other device just connected. Likewise, closing a page that is merely ringing must not decline the call for the person's other devices.

**TURN credentials** follow the coturn REST scheme: `username = "<expiryUnix>:<userId>"`, `credential = base64(HMAC-SHA1(secret, username))`.

### Media recommendations

These are not required for interoperability, but they are what the web client does to save battery and data: Opus mono at about 24 kbps with `usedtx=1;useinbandfec=1`, `a=ptime:40`, a negotiated data channel (`id: 0`) for in-call state `{t:"state", muted, video}`, hardware-friendly video codecs first (H.264 baseline, then VP8), at most about 640×360 at 24 fps and 600 kbps with downward adaptation, and releasing the camera when the app is in the background.

## Video messages

### Sending

1. Fetch every recipient device with `GET /api/e2ee/chats/:chatId/devices`. The list **must include the sender's own devices**. At most 128 devices fit one envelope; refuse to send (tell the user) when there are more. Apply the trust rules above to every person in the list, including yourself, **before** encrypting.
2. Choose the **context** the message is bound to: `chatId`, a `clientRequestId` (non-empty, at most 120 characters, unique per message) and `senderUserId`. The same values are used as the upload's `chatId` / `clientRequestId` fields and are read back from the stored message by recipients.
3. Generate a random 32-byte content key `K` and a 12-byte IV. Encrypt the video container bytes (`video/mp4` or `video/webm`):
   `ciphertext = AES-256-GCM(K, iv, media, encodeFields("AURELLE-VN-V2/media", [senderDeviceId, mime, String(durationMs), chatId, clientRequestId, senderUserId]))`.
4. Optionally encrypt a small JPEG preview (at most 12 kB) with `K`, its own IV and `encodeFields("AURELLE-VN-V2/poster", [senderDeviceId, mime, String(durationMs), chatId, clientRequestId, senderUserId])` as associated data.
5. Generate one ephemeral ECDH key for the message. For each recipient device: `wrapKey = HKDF-SHA-256(ECDH(ephemeral, device.ecdhPublic), salt = SHA-256(utf8(deviceId)), info = "AURELLE-VN-V2/wrap", 32)`, and `wrapped = AES-256-GCM(wrapKey, wrapIv, K, encodeFields("AURELLE-VN-V2/wrap", [deviceId, b64u(iv)]))` (48 bytes with the tag).
6. Build the envelope and sign it with the sender device ECDSA key over
   `encodeFields("AURELLE-VN-V2/signature", [String(v), kind, senderDeviceId, mime, String(durationMs), chatId, clientRequestId, senderUserId, b64u(iv), b64u(SHA-256(ciphertext)), posterField, ...for each key: deviceId, epk, iv, ct])`,
   where `posterField` is `poster.iv + "." + poster.ct` or the empty string.
7. Upload: `POST /api/messages/upload` as `multipart/form-data` with `chatId`, `username`, `uploadType=document`, `clientRequestId` (**required** for encrypted messages, and it must come back unchanged), one `files` part (the ciphertext as `application/octet-stream`) and `e2eeEnvelope` (JSON). The server validates the envelope, skips transcoding and stores it with the message. Keep the recording until the server accepted the upload, so a refused or failed send never costs the user their clip.

Binding the context means a stored envelope and file cannot be re-posted by a hostile server (or any chat member) into another chat or as another message: the signature and the AES-GCM data no longer match.

```json
{
  "v": 2,
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

Limits enforced by the server: at most 61 s, 128 recipient devices, 48 kB envelope, every `epk` a valid curve point, a `clientRequestId`, the sender device must be one of your active devices, one file only, no channels, no edits. Version 1 envelopes are no longer accepted.

### Receiving

`GET /api/messages` returns the parsed envelope as `message.e2ee`, and for encrypted messages also `chat_id` (message rows otherwise carry none), `client_request_id` and the author's `user_id`: together they are the context. The preview can be decrypted from the envelope alone. To play, download the file, then in this order: find your device's entry in `keys`; look up the sender's device by `senderDeviceId` **under the message author's user id**, naming the chat (`?chatId=`, and `deviceId=` to also find a revoked device); apply the trust rules (an unacknowledged sender device of a verified person must stop playback; for others, show that the message came from a new device); **verify the signature** with the context taken from the message; unwrap `K`; decrypt. Any failure must be reported to the user and must not play anything. If your device has no entry, the message was sent before the device existed.

Anything you cache (decrypted media, previews) must be keyed by the sender's account and the envelope signature, **never** by a value the sender chose (such as the client request id), and must be forgotten on sign-out.

## Threat model

**Protected against:** a passive or active network attacker; a curious or compromised signaling/relay/storage server that does not modify the app delivered to users; a database or backup leak (only ciphertext and public keys are stored); a later compromise of a device or of long-term keys for past calls (forward secrecy of signaling and media).

**Not protected against, by design or by current limits:**

- **Metadata** such as who talks to whom, when, and message sizes.
- **A malicious server that serves a modified web app.** In a browser the encryption code is delivered by the server you are trying not to trust. Safety numbers and the emoji code detect a swapped key directory or a man in the middle, but not backdoored JavaScript. A native app removes this gap.
- **Key directory at first contact.** Until you verify the safety number, the first keys you see for a contact are trusted. After that, a new device is reported until acknowledged (and blocked for verified contacts), and changed keys are detected.
- **The relay and the peer see IP addresses** unless `CALLS_FORCE_RELAY` is on, in which case only the relay sees both.
- **A compromised endpoint** can of course read everything shown on it.
- The emoji code has 32 bits. Because of the key commitment an attacker gets one 2^-32 chance per call, but it is still a quick check, not a replacement for verifying the safety number of a contact you care about.

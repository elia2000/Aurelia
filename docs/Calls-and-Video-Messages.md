# Calls & Video Messages

Aurelle can place **end-to-end encrypted voice and video calls** and send **round video messages** (like Telegram's "circles"). Both are designed to be gentle on battery and mobile data.

:::tip

Everything here works in the browser and in the installed PWA. The protocol is documented in [End-to-End Encryption Protocol](./E2EE-Protocol.md) so native apps can interoperate.

:::

## What is protected

| | Protected from the server | Notes |
|---|---|---|
| Call audio and video | ✅ End-to-end encrypted (DTLS-SRTP between the two devices) | Media goes directly between devices, or through a relay that only sees ciphertext. |
| Call signaling (SDP, ICE candidates) | ✅ Encrypted and authenticated | The server only forwards opaque blobs, so it cannot swap in its own keys. |
| Video message content and preview frame | ✅ Encrypted on the sender's device | The server stores ciphertext only. |
| Who calls whom, when, call type, duration of the ring | ❌ Visible to the server | Needed to ring the other person and route push notifications. |
| Who sent a video message, when, to which chat, its size and length | ❌ Visible to the server | Needed to deliver and retain it. |
| Text messages, voice messages, files, photos | ❌ Not end-to-end encrypted | These keep using encryption at rest on the server. |

## Requirements

- **HTTPS** (or `localhost` for development). Browsers only allow the camera, microphone and cryptography APIs in a secure context. Without HTTPS the call and camera buttons are hidden.
- A current version of Chrome, Edge, Firefox or Safari. On iOS, use 16.4 or newer and install the app to your home screen to receive notifications.
- For calls across different networks you need a **relay (TURN) server**, see [Setting up the relay](#setting-up-the-relay).

## Using it

### Calls

1. Open a **direct chat** and press the phone (voice) or camera (video) button in the header.
2. The other person gets an incoming-call screen (and a push notification if the app is closed).
3. Once connected, both screens show the same **four emoji**. Ask each other to read them out: if they match, nobody is intercepting the call.
4. Tap the lock badge to open the **safety number**. If the numbers match on both phones, press *Mark as verified*. That contact is then remembered as verified on this device until their devices change.

Calls are one-to-one and happen in direct chats. You can minimise the call screen and keep browsing.

### Video messages

1. In a direct chat, group or *Saved messages*, press the **camera** button next to the microphone.
2. Press the red button to record (up to **60 seconds**), press stop, preview, then **Send** or **Retake**.
3. Recipients see a round bubble with a blurred preview. The video is downloaded and decrypted only when they press play.

Video messages are not available in broadcast channels. They cannot be forwarded, because the key is wrapped only for the devices that were in the chat when it was sent.

:::warning

A video message can only be opened by devices that existed when it was sent. A person who adds a new device later will not be able to watch older video messages on it.

:::

## Setting up the relay

Most home and office networks allow two devices to connect directly. Mobile carriers and strict firewalls often do not, and then a **TURN relay** forwards the (already encrypted) packets. Without one, calls between two networks may fail to connect.

Aurelle supports the standard [coturn](https://github.com/coturn/coturn) server with short-lived per-user credentials. No third-party STUN server is used by default, so peer IP addresses are never sent to an outside party.

### Option A: the bundled coturn (Docker Compose)

1. Generate a secret and add the settings to your `.env`:

   ```bash
   openssl rand -hex 32   # use the output as CALLS_TURN_SECRET
   ```

   ```bash
   CALLS_TURN_SECRET=<the generated secret>
   CALLS_TURN_URLS=stun:turn.example.com:3478,turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
   CALLS_TURN_EXTERNAL_IP=<your server's public IPv4>
   ```

2. Open these ports in your firewall (the relay uses host networking):

   | Port | Protocol | Purpose |
   |---|---|---|
   | `3478` | UDP and TCP | STUN/TURN |
   | `49160-49260` | UDP | Relay range (change with `CALLS_TURN_MIN_PORT` / `CALLS_TURN_MAX_PORT`) |

3. Start it:

   ```bash
   docker compose --profile calls up -d
   ```

The bundled configuration refuses to relay to private networks (so it cannot be used to reach services behind your firewall), limits each user to a few allocations and caps per-session bandwidth.

### Option B: your own coturn

Run coturn with `use-auth-secret` and `static-auth-secret=<secret>`, then set `CALLS_TURN_SECRET` and `CALLS_TURN_URLS` to match. Use `turns:` URLs for TLS.

### Hide IP addresses (high-security mode)

Set `CALLS_FORCE_RELAY=true` to send **all** call media through your relay. Then the two people never learn each other's IP address. It uses a little more server bandwidth and adds a few milliseconds of latency. It requires a working relay.

### Checking your setup

Signed in, open `/api/calls/ice-config` in the browser. With a relay configured it lists `turn:` servers with a temporary `username` and `credential`. The call screen shows *Relayed through your server* when a call uses the relay.

## Settings

All call settings are environment variables. See [Environment Variables](./Environment-Variables.md#calls).

## Battery and data

| Measure | Effect |
|---|---|
| Peer-to-peer media | Nothing flows through your server in the normal case. |
| Opus voice at 24 kbps, mono, silence suppression (DTX) | About 0.2 MB per minute per direction while someone talks, and almost nothing during pauses. |
| 40 ms audio packets | Half as many packets and radio wake-ups as the default 20 ms. |
| Video off by default for voice calls | The camera is never opened. |
| Hardware-friendly codecs first (H.264, then VP8) | Lower CPU and heat than VP9/AV1 software encoding. |
| Video capped near 640×360, 24 fps, 600 kbps | Adaptive: it steps down on a poor network and falls back to audio only, then returns. |
| Camera released when the page is hidden | No capture power draw, and the camera light turns off. |
| Screen kept awake only during visible video calls | Voice calls let the screen sleep. |
| Batched, encrypted signaling | A handful of small requests per call; no polling. |
| Round video: 384 px, 24 fps, about 350 kbps | About 3 MB per minute including sound. |
| Video messages download on demand | Scrolling a chat costs no data. Only a tiny preview is decrypted up front. |
| Your own video messages replay from memory | No second download. |

## Limitations

- Calls are **one-to-one** and start from a direct chat. Group calls need a media-forwarding server and are not included.
- Call signaling state lives in the memory of one app process. If you run several app instances behind a load balancer, use sticky routing for `/api/calls`.
- A device that is offline when a call starts gets a push notification (if enabled). The ring lasts about 45 seconds.
- **Trust in the web app:** like any browser-based end-to-end encryption, the code that does the encryption is delivered by your server. Comparing the emoji code or the safety number detects a tampered *connection or directory*, but a server operator who modifies the web app itself could in principle read future calls. Use verified safety numbers and, for the strongest guarantee, a native client built from audited source. See [End-to-End Encryption Protocol](./E2EE-Protocol.md#threat-model).

## Admin

Set `CALLS_ENABLED=false` to turn off calling for everyone; the call buttons disappear. Video messages are controlled by the existing file-upload setting (`FILE_UPLOAD`) and retention applies to them like any other file.

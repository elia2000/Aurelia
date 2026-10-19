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
4. Tap the lock badge to open the **safety number**. If the numbers match on both phones, press *Mark as verified*. That contact is then remembered as verified on this device until their devices change. You do not need a call for this: the shield button in the header of a direct chat opens the same screen.

While you call, the screen tells you where things stand:

| You see | Meaning |
|---|---|
| **Calling…** | The call is being placed. |
| **Waiting…** | The call is placed, but the other person's app has not reported that it is ringing: it is closed or offline, or they appear offline (*invisible*). They get a push notification (if they enabled notifications), and the call connects if they open the app in time (the call stays open for about 45 seconds). |
| **Ringing…** | Their app is open, on screen, and is ringing right now (an app in the background, or a phone with the screen off, keeps you on *Waiting…* until it is looked at; people who appear offline never trigger this: their callers stay on *Waiting…* while the phone rings). The ring tone on your side only plays during this step. |
| **Connecting…** | They answered and the two devices are setting up the encrypted connection. After about 10 seconds it adds *Still connecting*. |

When a call cannot be set up, the screen says why and stays for about 10 seconds (press **Close** to dismiss it sooner):

- *Couldn't connect. Check your network…*: the two devices could not reach each other.
- *Couldn't connect. This server has no relay (TURN) set up…*: the same, on a server without a relay. People on different networks need one; see [Setting up the relay](#setting-up-the-relay).
- *Connection lost*: the call was working and then stopped.
- Any other problem (for example a refused security check) is shown as what it is and is never passed off as a network problem.

Calls are one-to-one and happen in direct chats. You can minimise the call screen and keep browsing.

### Video calls and the camera

- In a video call the camera button turns your video on and off at any time. When someone's camera is off the other person sees a **black screen** that says *Camera off* (their name stays visible), and a small black tile stands in for your own picture.
- On an incoming video call you can press **Answer with camera off** to join without showing yourself. You still see them, and you can switch your camera on later without reconnecting.
- If the camera is blocked or missing, the call is **not** dropped: you join without video and the screen tells you why. Only a blocked or missing microphone ends a call.
- **Swap the pictures.** The other person fills the screen and you are the small tile. Tap your own tile to put yourself full screen and the other person in the tile; tap again to swap back. The swap is there once the call is connected, and it stays if you minimise the call and open it again.
- **A clear view.** Click or tap the picture to hide the name, the emoji code and the buttons; click or tap again to bring them back. They also hide by themselves after 5 seconds, come back when you move the mouse or press a key, and stay while a warning or the call settings are open, while you move through the buttons with the keyboard, or when there is no picture to look at. If you hid them with a mouse click, moving the mouse does not bring them back: click the picture again or press a key.

### Sound and video quality during a call

The sliders button next to the microphone and camera buttons opens the call's settings. It only appears when there is something to choose.

- **On a computer:** pick the *Speaker* and the *Microphone* when the computer has more than one. The speaker choice is remembered on that device. The speaker list appears only where the browser lets a page choose the speaker (Chrome and Edge do; other browsers vary), and the microphone list only when there is more than one.
- **On an Android phone (Chrome):** the browser cannot pick a speaker like a computer, but it lists the phone's ways of playing a call: *Speaker*, *Phone earpiece*, *Bluetooth*, *Wired headset*. They appear as a *Sound* choice, and a speaker button next to the microphone button flips between the loudspeaker and the earpiece like in a phone call. Aurelle switches by opening the matching microphone entry, which is how Chrome routes a call's sound. This depends on the phone and browser: if they list fewer than two ways, no sound choice is shown. An iPhone or iPad with iOS 26 or newer lists its speakers the same way, if Safari allows it; on older ones use the system's audio output switcher. The call plays through the loudspeaker by default.
- **Video quality** (video calls): *Auto* keeps the call smooth: it starts at 360p, climbs up to 720p while the connection is healthy, steps down when it is not and, in the worst case, pauses the picture to keep the voice going. Or pick one fixed level: 240p (saves data), 360p, 480p, 720p HD or 1080p Full HD. Your choice is what *you* watch: the other person's phone sends you that quality (it cannot exceed what their camera and connection can do). A fixed level is kept even when the network is poor, so choose *Auto* if the picture freezes. The menu shows the size and frame rate that is arriving. Your choice is remembered on that device.
- **Picture.** Chooses how the picture sits on the screen: *Auto* fills the screen unless that would cut off a lot (a wide picture on an upright phone is shown whole), *Fill the screen* (the edges may be cut off) or *Show the whole picture* (with bars at the sides or at the top and bottom).

### Video messages

The round button at the right end of the message box is the **record button**. While the box is empty it shows a microphone (voice message) or a camera (video message); as soon as you type something, or add a file, it becomes *Send*.

1. In a direct chat, group or *Saved messages*, **tap** the record button to switch between microphone and camera. Aurelle remembers your choice on that device.
2. **Press and hold** the button to record (video messages stop at **60 seconds**). A round preview of your camera floats above the message box. **Let go to send.** Slide **left** to cancel. Slide **up** to lock the recording: you can then let go, and the bar offers *Delete*, *Stop* and *Send*. *Stop* opens a preview that you can play before you send or delete it. If the phone has more than one camera, a button flips between them while the recording is locked.
3. A hold shorter than a second is not sent; Aurelle tells you to hold longer. If the page loses focus or the camera is unplugged, the recording is kept for you to review instead of being lost.
4. Recipients see a round video with no bubble around it. It plays muted on a loop while it is on screen, unless the device is offline, on a slow connection or in data-saver mode, or has reduced motion on; the first frame is shown instead and the video is downloaded and decrypted only when they press play. A tap plays it from the start with sound, and a second tap pauses it. While it plays, a dot rides the progress ring (like in Telegram): drag it round the ring to jump to another moment, or focus it and use the arrow keys. The time shown counts down what is left.

On a computer the keyboard works too: focus the button, press Space or Enter to switch the mode, hold Space to record, press the up arrow to lock and Escape to cancel.

Your recording stays in the message box until the server has accepted it. If sending does not work (you are offline, a contact has a new device, an earlier upload is still running) the reason is shown with the recording and you can simply press *Send* again.

Voice messages use the same button. A voice message that is left recording for 30 minutes stops by itself and waits for you to review it.

Video messages are not available in broadcast channels. They cannot be forwarded or saved as a file, because the key is wrapped only for the devices that were in the chat when it was sent and the stored file is ciphertext. In groups, members do not need a direct chat with each other to watch each other's messages.

:::warning

A video message can only be opened by devices that existed when it was sent. A person who adds a new device later will not be able to watch older video messages on it.

:::

### When a contact gets a new device

A safety number covers **all** of a person's devices, so a new device changes it. Aurelle never accepts a new device silently:

- **Sending a video message** to someone who has a device you have not seen asks first and names who it is. For a contact you have *not* verified you can choose *Send anyway* (that accepts the device). For a contact you **have** verified there is no shortcut: open *Review*, compare the new safety number with them and mark it verified again.
- **Calls** from, or answered by, a new device of a verified contact are stopped. For everybody else the call screen shows a warning with a *Review* button.
- **Messages** that were signed by a new device show *Sent from a new device*. For a verified contact they stay locked until the number is checked again.
- This applies to **your own account** too: a browser you signed in on later is mentioned once, the first time you send from another device.

Someone who clears their browser data or uses private windows registers new devices. Old ones are retired automatically once a person has 20, so nobody gets locked out.

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
   CALLS_TURN_URLS=stun:turn.example.com:3478,turn:turn.example.com:3478
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

::: warning Stop the relay reaching your own network
A TURN relay forwards packets to whatever address a caller names. Unless told otherwise coturn will happily relay to your server's other services and to private networks, so a signed-in user could probe them through it. Add these lines to `turnserver.conf` (the bundled Docker configuration already has them):

```ini
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1-::1
denied-peer-ip=::ffff:0:0-::ffff:ffff:ffff
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
```

If the relay machine uses another private range (for example a cloud provider's), deny that too. Do not enable `allow-loopback-peers`.
:::

::: warning The relay's DNS record must not be proxied
If your domain is on Cloudflare, the record for the relay host (`turn.example.com`) must be **DNS only** (grey cloud). The orange-cloud proxy only carries web traffic, so a proxied relay can never be reached and calls between different networks stay on *Connecting…*. Aurelle checks this at start-up and tells you in the log and on the call screen. The record of the app itself should stay proxied.
:::

### Behind a VPN, a proxy or a censored network

Calls need a path from each phone to the relay. Two things commonly get in the way:

- **A VPN or proxy that does not carry UDP.** WebRTC prefers UDP, and many VPN apps (especially "proxy mode" ones, where the browser talks to a local SOCKS/HTTP proxy) only carry TCP or leave UDP outside the tunnel, where a censor may drop it. Aurelle therefore offers every `turn:` address **over TCP as well** (an address with no transport, or with `transport=udp`, gets a `transport=tcp` twin; `CALLS_TURN_TCP_FALLBACK=false` turns this off). Make sure coturn listens on TCP `3478` (it does by default) and that port is open. Where possible use a VPN app in system-wide (VPN service / TUN) mode.
- **Port filtering.** If the people on a call reach Aurelle *through a VPN*, the censor only sees the VPN's own traffic, so the relay port does not matter to it: what matters is that the VPN can reach your server. If people could reach the relay *without* a VPN, `turns:` on port `443` (TLS) is the address least likely to be blocked, but `443` must then be shared with whatever else listens there (for example an SNI-routing front such as nginx `stream` with `ssl_preread`). Another service already on `443` (a proxy panel, say) is the usual blocker, so this is an advanced setup and not needed for the VPN case.

When a call cannot connect, the *Couldn't reach this server's relay* card (and the *Technical details* under it) tells you which case you are in:

| You see | Meaning |
|---|---|
| `Relay candidates: 0` and `error 701 … timed out` for each `turn:` address | This phone could not reach the relay at all: the VPN/proxy does not carry the connection, a firewall blocks it, or coturn is not running there. Test with the Trickle ICE page from [Troubleshooting](./Troubleshooting.md#calls-not-connecting) on the same phone and the same VPN. |
| `Relay candidates: 1` or more (for example `tcp 1`) but the call still fails | This phone reaches the relay. The other person's phone is the one that cannot, so check their connection and VPN. |
| *This server's relay is behind Cloudflare's proxy* | The relay's DNS record is proxied (orange cloud). Set it to **DNS only**, or use the server's IP address in `CALLS_TURN_URLS`. |
| *This server's relay refused this device* (`error 401 Unauthorized`) | The relay was reached but refused the credentials: `CALLS_TURN_SECRET` differs from coturn's `static-auth-secret`, or the clocks of the app server and the relay differ. |

The details also say which device this is (`Role: caller` or `callee`), which servers it was given (`Servers:`, without credentials), which kinds of address it found (`Candidates found here: host 2, relay 1`) and which kinds the other device sent (`Candidates from the other device`). `Pairs tried` lists how each pair of addresses fared (`host udp -> relay udp: failed, sent 7, answered 0`): a pair that was *sent* requests but never *answered* is a path that drops packets. **Copy report** puts all of this, with the app build and browser, on the clipboard so it can be pasted to whoever runs the server. It contains kinds of address only: no IP addresses and no credentials.

### Hide IP addresses (high-security mode)

Set `CALLS_FORCE_RELAY=true` to send **all** call media through your relay. Then the two people never learn each other's IP address. It uses a little more server bandwidth and adds a few milliseconds of latency. It requires a working relay, and it **fails closed**: if the relay is missing or misconfigured, calls are refused with a clear message (and a warning is logged at start-up) instead of quietly connecting directly and exposing both addresses.

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
- Every device of the person you call gets a push notification (if enabled), also when another of their devices has the app open: a phone with the app closed still rings. A chat the callee muted does not ring by push. The ring lasts about 45 seconds. When it ends (answered elsewhere, cancelled, unanswered) the notification is removed, or replaced by a *missed call* one.
- Calls are limited per person (12 invitations a minute, 5 per two minutes per conversation) so that nobody can ring someone repeatedly.
- Keep your device clock roughly right: an invitation whose time is more than ten minutes off from the receiving device is refused, and the call screen then says to check the clock.
- **Trust in the web app:** like any browser-based end-to-end encryption, the code that does the encryption is delivered by your server. Comparing the emoji code or the safety number detects a tampered *connection or directory*, but a server operator who modifies the web app itself could in principle read future calls. Use verified safety numbers and, for the strongest guarantee, a native client built from audited source. See [End-to-End Encryption Protocol](./E2EE-Protocol.md#threat-model).

## Admin

Set `CALLS_ENABLED=false` to turn off calling for everyone; the call buttons disappear, but devices still register and encrypted video messages keep working. Video messages are controlled by the existing file-upload setting (`FILE_UPLOAD`) and retention applies to them like any other file.

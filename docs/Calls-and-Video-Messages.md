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

### Call history in the chat

When a call ends, the direct chat gets **one entry about it**, the same for both of you, in order with the messages. It is a small bubble like the others: yours on the right, theirs on the left. From left to right it shows:

- an **arrow** for the direction: up and to the right for a call you made, down and to the left for one you received. It turns **red** when nobody talked (missed, declined, busy, failed);
- a **title** that says what happened, and under it the **length** (*0:23*, *2:05*, *1:02:03*) or, when there was no conversation, the **reason** (*Not answered*, *They declined*, *You hung up first*, *Couldn't connect*);
- the **time**, at the bottom corner;
- a round **call-back button**: a **phone** on a voice call, a **camera** on a video call.

| Title | What happened |
|---|---|
| *Outgoing call* / *Incoming call* with the length | The call was answered and connected. The time counts from the moment it connected. |
| *Missed call* (for the caller: *No answer*) | Nobody picked up before the ring ended. |
| *Declined call* | The other person refused it. |
| *Cancelled call* | The caller hung up before it was answered. |
| *Busy* | The other person was already in a call. |
| *Call failed* | It was answered, but the connection never worked. |

Video calls say *video call* (*Outgoing video call*, *Missed video call*). Good to know:

- **Calling back:** press the round button to place a new call of the **same kind** to the same person, like the phone and camera buttons in the chat header. It works from the keyboard too (Tab to it, then Enter). It is greyed out while you are in another call and when calls are not available (the server or the browser does not support them, or the other person's account is gone).
- There is **one entry per call**, however it ends: both of you hanging up at once, or the call timing out, still leaves one.
- The **chat list** shows the same line as the last message (*Outgoing call*, *Missed video call*, ...) with the arrow, without *You:* and without read ticks. Only a **missed call** counts as unread for the person who did not answer; it clears when they open the chat. The other entries are already read, so they never add to the unread count, and a call entry never pops up a notification of its own.
- Call entries cannot be edited, forwarded, replied to, reacted to, copied or pinned, and they are not searched. The menu of an entry (right click, or a long press on a phone) offers only **Delete**, which removes it from your own view; it cannot be deleted for both. In selection mode an entry can be ticked and deleted together with other messages.
- A call entry stands on its own: it ends the run of bubbles before it, like a service line.
- They expire with the other messages (`MESSAGE_TEXT_RETENTION`) and go with the chat when it is deleted.
- A call entry sends no push notification of its own; the call's own notification is the only one.
- When the server sends a message of a kind this version of the app does not know, a small *not supported* note stands in its place instead of an empty bubble.

### Video calls and the camera

- In a video call the camera button turns your video on and off at any time. When someone's camera is off the other person sees a **black screen** that says *Camera off* (their name stays visible), and a small black tile stands in for your own picture.
- On an incoming video call you can press **Answer with camera off** to join without showing yourself. You still see them, and you can switch your camera on later without reconnecting.
- If the camera is blocked or missing, the call is **not** dropped: you join without video and the screen tells you why. Only a blocked or missing microphone ends a call.
- **Swap the pictures.** The other person fills the screen and you are the small tile. Tap your own tile to put yourself full screen and the other person in the tile; tap again to swap back. The swap is there once the call is connected, and it stays if you minimise the call and open it again.
- **A clear view.** Click or tap the picture to hide the name, the emoji code and the buttons; click or tap again to bring them back. They also hide by themselves after 5 seconds, come back when you move the mouse or press a key, and stay while a warning or the call settings are open, while you move through the buttons with the keyboard, or when there is no picture to look at. If you hid them with a mouse click, moving the mouse does not bring them back: click the picture again or press a key.

### Sharing your screen

On a computer you can show your screen to the person you are talking to, in a voice call or a video call.

- **Start.** Press **Share screen** (the monitor button between the camera and the sliders). Your browser asks what to share: the entire screen, one window or one browser tab. While the call is still connecting the button is there but off, and its tooltip says why; it stays off if the other person's app is too old to show a shared screen. The button does not exist on phones and tablets: their browsers cannot capture the screen. They can still *watch* one.
- **While you share.** A red banner at the bottom of the call says **You are sharing your screen**, what is shared, and has a **Stop sharing** button; it stays on screen even when the other details hide. If you minimise the call, the small pill at the top shows a **Sharing** button that stops it. A small tile in the corner reminds you what you share. For an entire screen or a window it is a still label rather than a live picture: a live copy would show the call inside the call, over and over. Only another browser tab (this one is never offered) is previewed live.
- **Stopping.** Press **Stop sharing**, or the browser's own *Stop sharing* bar. The picture also stops when the call ends. Picking another source while sharing replaces the share without a gap.
- **What the other person sees.** Your screen fills their call screen, **never cropped** (the *Picture* choice in the settings only applies to the cameras), under the label **Sharing their screen**. In a voice call the call screen turns into the same black stage; on a computer the call card grows to make room. If they also have their camera on, it is a small tile (yours is another one under it). Tap the tile to swap the camera and the screen; tap again to swap back. The name, emoji code and buttons hide after a few seconds, exactly as in a video call. The settings show the size and frame rate of the shared screen that arrives.
- **Camera and screen together.** Both can be on at the same time, and both people can share at once (each sees the other's). Turning the camera off or on does not touch the screen, and neither does hiding the tab: unlike the camera, the screen is not paused when the page is in the background.
- **Sound.** The sound of the shared screen is **not** sent. Only the microphone is.
- **Quality.** The screen is sent for detail (text stays sharp): at most 15 frames a second and about 2.5 Mbit/s, scaled down when it is larger than 1920×1080. On a poor connection Aurelle lowers the frame rate first, then the bitrate and, last, the size, but the screen is never given up for the voice and the voice is never touched.
- **If it does not start.** Closing the picker or refusing the permission shows a small hint on the call (and clears itself); the call carries on. On macOS the browser needs *Screen Recording* permission in the system settings. Hanging up while the picker is open leaves nothing running.
- **Privacy and security.** Sharing needs no new negotiation and no new connection: the screen travels on a line that was set up (empty) in the call's first offer, under the same end-to-end authenticated DTLS session as the voice and the camera. Nothing is sent on that line until someone shares. Older versions of the app (which have no such line) still connect: they simply cannot show a screen, and the button stays off. See the [protocol notes](./E2EE-Protocol.md#screen-sharing).

### Sound and video quality during a call

The sliders button next to the microphone and camera buttons opens the call's settings. While the call is still connecting it only appears when there is something to choose. Once the call is connected it is always there: below the choices it shows how the [connection](#connection-quality) is doing and the [keyboard shortcuts](#keyboard-shortcuts).

- **On a computer:** pick the *Speaker* and the *Microphone* when the computer has more than one. The speaker choice is remembered on that device. The speaker list appears only where the browser lets a page choose the speaker (Chrome and Edge do; other browsers vary), and the microphone list only when there is more than one.
- **On an Android phone (Chrome):** the browser cannot pick a speaker like a computer, but it lists the phone's ways of playing a call: *Speaker*, *Phone earpiece*, *Bluetooth*, *Wired headset*. They appear as a *Sound* choice, and a speaker button next to the microphone button flips between the loudspeaker and the earpiece like in a phone call. Aurelle switches by opening the matching microphone entry, which is how Chrome routes a call's sound. This depends on the phone and browser: if they list fewer than two ways, no sound choice is shown. An iPhone or iPad with iOS 26 or newer lists its speakers the same way, if Safari allows it; on older ones use the system's audio output switcher. The call plays through the loudspeaker by default.
- **Video quality** (video calls): *Auto* keeps the call smooth: it starts at 360p, climbs up to 720p while the connection is healthy, steps down when it is not and, in the worst case, pauses the picture to keep the voice going. Or pick one fixed level: 240p (saves data), 360p, 480p, 720p HD or 1080p Full HD. Your choice is what *you* watch: the other person's phone sends you that quality (it cannot exceed what their camera and connection can do). A fixed level is kept even when the network is poor, so choose *Auto* if the picture freezes. The menu shows the size and frame rate that is arriving. Your choice is remembered on that device.
- **Picture.** Chooses how the picture sits on the screen: *Auto* fills the screen unless that would cut off a lot (a wide picture on an upright phone is shown whole), *Fill the screen* (the edges may be cut off) or *Show the whole picture* (with bars at the sides or at the top and bottom).

### Connection quality

Voice and video calls show a small **signal icon** with four bars in the header, next to the lock badge. It tells you how good the connection is, so that you know whether a choppy voice is your network or theirs:

| Bars | Level | Colour |
|---|---|---|
| 4 | **Excellent** | light green |
| 3 | **Good** | light green |
| 2 | **Fair** | amber |
| 1 | **Poor** | red |

Hover over the icon (or open it with a screen reader) to read *Connection: Good*. Before the first measurement it reads *Connection: Checking…* and the bars are dim.

- **How it is measured.** Every 5 seconds the app reads its own connection statistics (they never leave your device) and takes the **worst** of these numbers, so a fine round trip does not hide heavy loss:

  | | Excellent | Good | Fair | Poor |
  |---|---|---|---|---|
  | Round-trip time | under 150 ms | under 300 ms | under 600 ms | 600 ms or more |
  | Lost packets | under 1 % | under 3 % | under 8 % | 8 % or more |
  | Jitter of the voice | under 30 ms | under 60 ms | under 120 ms | 120 ms or more |
  | Bandwidth to send with (while a camera or screen is sent) | 500 kbit/s or more | 200 kbit/s or more | 60 kbit/s or more | less |

  In a voice call the bandwidth only counts when it is tiny (under 50 kbit/s is *Fair*, under 25 kbit/s *Poor*): a voice needs next to nothing.
- **No flicker.** The icon only moves after several samples in a row: it drops after **two** worse ones (about 10 seconds) and rises after **three** better ones (about 15 seconds), and one odd sample inside a good stretch changes nothing.
- **Relayed.** When the call goes through your server's relay the tooltip says so (*Connection: Good · relayed*).
- **Reconnecting.** When the connection drops (the browser calls it *disconnected*) the bars pulse and the call says **Reconnecting…**; the buttons and the name stay on screen while it lasts. The call carries on by itself if the path comes back. If it does not return within about 25 seconds the call ends as *Connection lost*.
- **The numbers.** Press the icon (or open the call settings) to see the *Connection* section: round-trip time, packet loss, jitter, outgoing bandwidth and the path (*Direct* or *Relayed through your server*). On a fair or poor connection it adds what holds it back (*Held back by lost packets.*). A call that broke after it had worked also puts the last measured quality, as numbers only, into the **Copy report** under its technical details.

### Picture in picture

Take the other person's video out of the call screen into a small floating window that stays on top of other apps:

- **Start.** Press the small window button in the call header (next to *Minimise*), or press **P**. The button is only there when your browser can do it and the other person's camera or shared screen is on your call screen.
- **What floats.** Their camera, or their shared screen while it fills your call. If they start or stop sharing while the window is open it follows to the other picture. Your own picture never floats. The call's sound keeps playing from the call, not from the window.
- **Buttons in the window.** Browsers that support it show the call's own **mute**, **camera** and **hang up** buttons in the window, and the window reflects whether your microphone and camera are on.
- **On its own.** In a video call, switching to another tab or app can open the window for you, where the browser allows it (Chrome and Edge 134 or newer, which may ask once whether this site may do that, and Safari on a Mac). It closes again when you come back. Browsers that have no such feature are not tried on their own, because they would refuse without a click: press the button before you switch.
- **The camera stays on.** A page in the background normally lets go of the camera. While the call floats in picture in picture, the camera keeps sending.
- **It closes** when you press the button (or **P**) again, when the call ends, and when you minimise the call (a minimised call has no picture to float). If the browser says no, the call says *Picture in picture is not available right now.* for a few seconds.
- **Privacy.** The window shows the picture the call screen already shows, decrypted on this device; nothing new is sent anywhere.

| Browser | Button and **P** | Mute, camera, hang up in the window | Opens by itself |
|---|---|---|---|
| Chrome, Edge (computer) | yes | yes | yes (134 or newer) |
| Safari (Mac) | yes | the window's own controls | where Safari allows |
| Firefox | no (its own hover button on a video has no call controls) | – | – |
| Phones and tablets | no | – | – |

### Keyboard shortcuts

On a computer the call screen has these keys:

| Key | What it does |
|---|---|
| **M** | Mute or unmute the microphone |
| **V** | Turn the camera on or off (video calls) |
| **S** | Share your screen, or stop sharing |
| **P** | [Picture in picture](#picture-in-picture) |
| **F** | Full screen for the call card (and back) |
| **Esc** | Minimise the call. It closes an open menu or the settings first, and does not minimise a call that is ringing for you (its buttons would be gone) |
| **Shift + H** | End the call (or cancel it while it rings), straight away: a plain **H** does nothing, so it is never one slip of the finger |
| **?** | Open the settings on this list, and close them again |

- **Only when the keys are yours.** They work while the call card is on screen. They are ignored while you type in the message box or any other field, while a window or menu is open in front of the call (the safety number, a confirmation, a context menu), with **Ctrl**, **Cmd** or **Alt** held, and for a key held down. A **minimised** call leaves every key to the chat.
- **Other keyboards.** On a layout without Latin letters (Persian, say) the letters work by the physical key: the one marked M on a US keyboard mutes.
- **Screen readers** are told what a key did (*Microphone muted*, *Camera off*, *Picture in picture on*, *Full screen on* and so on), even when the buttons are hidden for a clear view. A shortcut also brings the buttons back, so you can see the change.
- **Where to find them.** The call settings list them under *Keyboard shortcuts* (a phone with only a touch screen does not show the list), and the tooltips of the buttons name their key (*Mute microphone (M)*).
- Full screen is not available where the browser does not offer it (an iPhone, for example); the key then does nothing.

### Ringtone, ringback and vibration

Aurelle makes its call sounds itself, so there is no sound file to download and nothing to license.

| When | What you hear |
|---|---|
| Someone calls you | A two-note bell **ringtone**, repeated about every 3 seconds, until you answer or decline, the caller hangs up, the ring times out, or you answer on another device. Phones also vibrate in a ringing pattern. |
| You call someone and the screen says *Ringing…* | A soft double **ringback tone**, like a telephone's, until they answer or decline or you hang up. It plays for *Ringing…* only: during *Calling…* and *Waiting…* nobody's phone is ringing yet. |
| The call connects | A short rising blip and a very short buzz. |
| The call ends | A short sound that says how: one for an ordinary hang-up, and one each for a call that was **declined**, a **busy** line and a call that **could not connect**. A call you declined yourself, one that rang without being answered and one you were not able to place because you are already in a call are silent. |

- **Settings.** *Settings → Call sounds* has **Call sounds** (on or off, on by default), **Ringtone volume** (70% by default), **Vibrate on incoming calls** (only on devices that can vibrate) and **Play test sound**. They are kept on that device only and apply at once, also to a call that is ringing right now. The section is hidden where calls are not available.
- **After your first tap.** A browser only lets a page make sound once you have tapped or typed in it. Aurelle gets the audio ready at your first tap or key press anywhere in the app, so a call that comes in later can ring. If a call arrives before that, you still get the call screen and the system notification, just no sound. *Play test sound* tells you when the browser refuses.
- **Speaker.** The ringtone follows the speaker you chose in the call settings where the browser can route a page's sound (Chrome and Edge), and otherwise uses the default speaker. It never touches the sound of the call itself.
- **Quiet when it should be.** Nothing rings while you are in another call (the caller hears the busy tone), and a call that had already ended when you opened Aurelle makes no sound. A hidden page does not vibrate: the notification does.

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

:::tip Installed with the deployment script?

The [deployment script](./Deployment-Script.md#calls-relay) installs and configures coturn for you (a fresh unattended install does it by default; menu option 10 does it later). You can skip Options A and B and only open the ports in your provider's firewall.

:::

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
| Camera released when the page is hidden | No capture power draw, and the camera light turns off. Not while the call floats in picture in picture. |
| Screen kept awake only during visible video calls | Voice calls let the screen sleep. |
| Screen sharing: 15 fps, at most about 2.5 Mbit/s, no sound | Text stays sharp; the frame rate falls first on a poor network. The idle screen line sends nothing. |
| Batched, encrypted signaling | A handful of small requests per call; no polling. |
| Round video: 384 px, 24 fps, about 350 kbps | About 3 MB per minute including sound. |
| Video messages download on demand | Scrolling a chat costs no data. Only a tiny preview is decrypted up front. |
| Your own video messages replay from memory | No second download. |

## Limitations

- Calls are **one-to-one** and start from a direct chat. Group calls need a media-forwarding server and are not included.
- Call signaling state lives in the memory of one app process. If you run several app instances behind a load balancer, use sticky routing for `/api/calls`. Restarting the server while a call is running ends it without a line in the chat.
- Every device of the person you call gets a push notification (if enabled), also when another of their devices has the app open: a phone with the app closed still rings. A chat the callee muted does not ring by push. The ring lasts about 45 seconds. When it ends (answered elsewhere, cancelled, unanswered) the notification is removed, or replaced by a *missed call* one.
- Picture in picture needs a browser that offers it for a page (Chrome, Edge, Safari on a Mac) and a picture on the call screen, so it ends when the call is minimised. The connection indicator is a guide: it reads the browser's own statistics, and the browser's estimate of the bandwidth is rough.
- Screen sharing works in one-to-one calls on computers only (a browser must be able to capture the screen), and the sound of the shared screen is not sent. Both people need a version of Aurelle that has it; with an older one the call works and nothing can be shared.
- Calls are limited per person (12 invitations a minute, 5 per two minutes per conversation) so that nobody can ring someone repeatedly.
- Keep your device clock roughly right: an invitation whose time is more than ten minutes off from the receiving device is refused, and the call screen then says to check the clock.
- **Trust in the web app:** like any browser-based end-to-end encryption, the code that does the encryption is delivered by your server. Comparing the emoji code or the safety number detects a tampered *connection or directory*, but a server operator who modifies the web app itself could in principle read future calls. Use verified safety numbers and, for the strongest guarantee, a native client built from audited source. See [End-to-End Encryption Protocol](./E2EE-Protocol.md#threat-model).

## Admin

Set `CALLS_ENABLED=false` to turn off calling for everyone; the call buttons disappear, but devices still register and encrypted video messages keep working. Video messages are controlled by the existing file-upload setting (`FILE_UPLOAD`) and retention applies to them like any other file.

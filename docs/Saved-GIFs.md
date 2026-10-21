# GIFs

GIFs stay GIFs. A GIF (also an animated WebP or an animated PNG) is sent exactly as it is, plays on its own in the chat and carries a small **GIF** tag. Every person also has a private **GIFs** collection, like Telegram's saved GIFs: pick one there and it is sent at once.

:::tip

GIFs need file uploads, so they follow the [`FILE_UPLOAD`](./Environment-Variables.md) setting. When the admin turns uploads off, the **GIFs** tab, **Save GIF** and **Add GIF** are hidden. GIFs are **not** available in end-to-end encrypted video messages.

:::

## Sending and watching GIFs

- **Attach** a GIF with the paperclip (**Photo or Video**). It is uploaded untouched: nothing is turned into a still picture or a video, and the original file is what the other person receives.
- In the chat a GIF **autoplays and loops**, with no tap needed, and the **GIF** tag sits in its corner. It is sized like any other picture. Tap it to open the viewer, where it keeps playing.
- In the chat list and in replies it is described as **Sent a GIF** (or **Sent 3 GIFs**).
- Old GIFs sent before this feature are recognised by their type and show the same way.

## Your GIFs

Open the emoji button next to the message field. The picker has two tabs, **Emoji** and **GIFs** (the app remembers the one you used last).

| You want to | Do this |
|---|---|
| Send a saved GIF | Tap it in the **GIFs** tab. It is sent to the open chat at once and the picker closes. |
| Save a GIF from a chat | **Right-click** the GIF (mouse) or **press and hold** it (touch) and choose **Save GIF**. This works for GIFs you received and for your own. The app says **GIF saved**, or **Already in your GIFs** when you had it. |
| Add a GIF from your device | Press **Add GIF** in the **GIFs** tab and choose a file (GIF, WebP or PNG; it must really be animated). |
| Remove a GIF | **Right-click** (mouse) or **press and hold** (touch) it in the **GIFs** tab and choose **Remove from saved**. |
| See how many you have | The counter at the top of the tab, for example **12/50**. |

The tab shows a dense grid of three columns, newest first. The pictures load as you scroll and play while visible. An empty collection explains how to add GIFs.

### Only you see your GIFs

Your collection is **private**. Nobody else can see it, list it or fetch its files; another person's request for your GIF gets the same "not found" as a GIF that never existed. When you send a saved GIF, the server makes a normal copy for the chat, so the people in the chat get an ordinary message without any link to your collection. Your GIFs are not touched by message retention, and when you sign out or another person signs in on the same device, the app forgets the list.

### The limit and the notice

One person can keep **50 GIFs** by default (the admin can change this with [`MAX_SAVED_GIFS`](./Environment-Variables.md), `1` to `200`). When you save or add another GIF while the collection is full, the **oldest GIF is removed automatically** and the app tells you, in a notice that stays on the screen until you press **OK**:

> Your GIF collection is full (50 GIFs). The oldest GIF was removed.

Screen readers announce it. The removed GIF disappears from the grid at once (also on your other devices). The number in the notice is the one the server uses, so it follows the admin's setting. Saving a GIF you already have never removes anything.

## What can be saved

- GIF, animated WebP and animated PNG, **20 MB** at most (or the server's per-file upload limit, if that is lower), up to 4096 px on a side and 2000 frames. A picture that is not animated is refused with a clear message.
- Messages of end-to-end encrypted chats cannot be saved.
- The server accepts at most 10 added files per minute and 60 saves per minute per person ("Too many GIF requests. Please slow down.").

# Pinned Messages and Chats

Pin a message so everybody in the conversation can find it again, and pin your favourite chats to the top of your chat list, like in Telegram.

:::tip

Both work in the browser and in the installed PWA, in direct chats, groups, channels and **Saved messages**. The two limits are set in [Environment Variables](/Environment-Variables) (`MAX_PINNED_MESSAGES`, default 20 per chat, and `MAX_PINNED_CHATS`, default 5 per person).

:::

## Pinned messages

### Pinning and unpinning

| You want to | Do this |
|---|---|
| Pin a message | **Right-click** it (on a phone: **press and hold** it) and choose **Pin**. |
| Unpin it | Choose **Unpin** in the same menu, or press the **X** on the bar under the chat header. |
| Unpin several | With more than one pin the **X** opens a menu: **Unpin message** (the one shown) or **Unpin all N messages**. The same menu opens with a right-click (or a long press) on the bar. |

The **Pin** item only appears where you are allowed to pin:

- **Direct chats and Saved messages**: either person can pin and unpin, and it applies to both.
- **Groups**: the group's owner. The owner can let every member pin by turning on **Members Can Pin Messages** (open the group, choose **Edit**, then **Privacy**).
- **Channels**: only the channel's owner. Subscribers see the pins but cannot change them.

A message that is still being sent, a call entry, and lines like "Bob joined the group" cannot be pinned. If the server refuses a pin anyway (for example the owner just changed the rule), you get a short notice and nothing changes.

### The bar under the header

When a chat has pins, a bar shows the **most recent pin** under the chat header: an accent line on the left, the title **Pinned message**, and a one-line preview with the name of the sender. A photo, video, voice message or file without text shows its kind ("Photo", "Video", "Audio", "File", "Video message") instead of text.

- **Click the bar** to go to that message. If it is far back in the history, the app loads the older messages first. The message is highlighted for a moment.
- With **several pins** the title carries a number (**Pinned message #3**, counted from the oldest), and the accent line becomes one segment per pin, the shown one lit. Each click goes to the shown pin and then moves the bar to the **next older** one; after the oldest it starts again at the newest.
- A pin that someone adds shows on the bar at once, on every device. When the last pin is removed the bar disappears.
- The bar follows edits: if the pinned message is edited, the preview changes.
- Deleting a message for everyone removes its pin.

### The line in the chat

When someone pins a message, a centered line says **"Bob pinned a message"** (**"You pinned a message"** for your own pin). Click it to go to the pinned message. Channels get no such line. The line is a normal chat entry, so you can delete it for yourself like any other.

### Limits

A chat can have `MAX_PINNED_MESSAGES` pins at once. Over that, the app says **"You can pin up to N messages in a chat"** and the message is not pinned. There is a limit of 30 pin changes per minute per person.

## Pinned chats

Pinned chats stay at the top of **your own** chat list; nobody else sees them, and they follow you to your other devices.

| You want to | Do this |
|---|---|
| Pin a chat | **Right-click** the chat in the list (on a phone: **press and hold**) and choose **Pin to top**. The chat goes to the top and shows a small pin next to its time. |
| Unpin it | Choose **Unpin** in the same menu. The chat goes back to its place by time of the last message. |
| Reorder | **Drag** a pinned chat up or down with the mouse. On a phone, **press and hold** the chat for a moment and then drag without lifting your finger: the menu closes and the row follows your finger. |
| Reorder with the keyboard | Focus the chat, press the **Menu** key (or **Shift+F10**) and choose **Move up** or **Move down**. These items are also in the touch menu. |

Good to know:

- A new pin goes to the **top** of the pinned chats.
- You can pin up to `MAX_PINNED_CHATS` chats. Pinning one more says **"You can pin up to N chats"**.
- Muted chats and **Saved messages** can be pinned. A chat you **hide** loses its pin, and it is not pinned again when it comes back.
- While you search the list, the pinned section is not shown and nothing can be dragged; clear the search to see it again.
- Changes show at once and are put back with a notice if the server refuses them (no connection, over the limit). If you reorder on two devices at the same moment, the server's order wins and the other device is told.
- Dragging does not open the chat; a plain click or tap still does.

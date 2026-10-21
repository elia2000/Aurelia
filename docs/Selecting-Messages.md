# Selecting Messages

Select several messages at once to forward, delete or copy them together, like in Telegram.

:::tip

Selecting works in direct chats, groups, channels and **Saved messages**, in the browser and in the installed PWA. Up to **100 messages** can be selected at once.

:::

## Starting and ending selection

| You want to | Do this |
|---|---|
| Start with a mouse | **Right-click** a message and choose **Select**, or move the pointer over a message and click the small circle that appears at its left edge. |
| Start on a phone | **Press and hold** a message and choose **Select**. |
| Select more | Click or tap anywhere on a message. Every message shows a circle on the left; a ticked circle is filled. |
| Select a range | **Shift+click** the last message of the range. Everything between it and the message you ticked last is selected. |
| Tick or untick one message | **Ctrl+click** (**Cmd+click** on a Mac), or just click: in selection mode every click toggles the message. |
| Finish | Press **Esc**, press the **X** at the left of the bar, or untick the last selected message. |

While you select, the chat header turns into a bar that says **N selected** and has **Copy**, **Forward** and **Delete** buttons. The message box is hidden (what you were typing is kept). Selection ends when you open another chat. It survives new messages, edits, and loading older messages by scrolling up. A message that someone deletes leaves the selection.

Links, pictures and buttons inside a message do nothing while you select: a click only ticks the message. Dragging with the mouse still selects text, and does not tick the message.

If you try to select more than 100 messages, the app stops at 100 and says "You can select up to 100 messages at once."

### Keyboard

- Press **Tab** to reach the messages, move to one with **Up**/**Down**, press the **Menu** key (or **Shift+F10**), then choose **Select**.
- In selection mode every message is a checkbox: **Up**/**Down** move between messages, **Space** or **Enter** ticks the focused one.
- **Delete** asks to delete the selected messages, **Ctrl+C** (**Cmd+C**) copies them (unless you have selected text, which is copied as usual), **Esc** ends selection.
- Screen readers hear "N selected" every time the count changes.

## Forward

**Forward** opens the same chat chooser as forwarding one message. Pick one or more chats (or **Saved messages**) and press **Send**.

- The messages arrive **oldest first**, as separate messages, each with its own "Forwarded from" line (the author, or the channel for channel posts). Each is sent with its current text, edits included.
- A success notice says "N messages forwarded". If some could not be forwarded, the notice says how many went and why (for example "Some messages were deleted or removed from your view"). If none went, the chooser stays open so you can try again.
- **Call entries, service lines** ("Bob joined the group") **and end-to-end encrypted messages** (round video messages) cannot be forwarded. They are left out, and the app tells you how many.
- Large forwards are split into several requests automatically: the server takes at most 100 messages, 20 chats and 500 message-chat pairs in one request. There is a limit of 30 forward requests per minute per person, and a person can create at most 500 forwarded messages (messages × chats) per minute, because every forwarded message is delivered to everyone in the target chat. Over that, the app says "Too many messages forwarded in a short time"; wait a moment and try again.

## Delete

**Delete** asks "Delete N messages?" first, and says what will happen:

- **Your own messages** can be deleted **for everyone**. In a group you own you can delete anyone's message for everyone; in a channel only the owner can. Turn on **Delete for everyone** to do that. The choice is remembered, and it is the same switch the single-message delete uses.
- Everything else (other people's messages, call entries, anything in **Saved messages**) can only be **removed from your own view**. Other people keep those messages.
- When a mix is selected, the dialog says how many go for everyone and how many are only hidden for you.

A notice says "N messages deleted". If the server refuses some (for example a message was already gone), the notice says how many were deleted and why; the ones that failed **stay selected**, so you can try again. Call entries and service lines can be selected for deleting, too.

Deleting needs a connection. There is a limit of 120 delete requests per minute per person.

## Copy

**Copy** puts the text of the selected messages on the clipboard and shows "Copied":

- One message: just its text.
- Several messages: one block per message, a blank line between blocks, in chat order:

  ```text
  Alice, [20.10.2026 14:03]
  Are we still on for tomorrow?

  Bob, [20.10.2026 14:05]
  Yes, see you at ten.
  ```

- Messages without text (photos or voice messages without a caption, call entries, service lines) are skipped, and the app says how many.

Copy works offline.

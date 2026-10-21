# Reactions

People can react to any message with an emoji, like in Telegram. A reaction shows as a small chip under the message with the emoji and how many people used it. Everyone in the chat sees chips appear and change live.

:::tip

Reactions work in direct chats, groups and channels, in the browser and in the installed PWA. Reactions are **not** end-to-end encrypted (they are stored with the message on the server), and they are not available on system lines ("Bob joined the group") or call entries.

:::

## Reacting

| You want to | Do this |
|---|---|
| Pick a reaction | **Right-click** the message (mouse) or **press and hold** it (touch). A row of seven quick reactions (👍 ❤️ 🔥 🥰 👏 😁 🤔) appears above the menu. Tap one. |
| Use any other emoji | Press **+** at the end of the quick row to open the full emoji picker. |
| Send a heart quickly | **Double-click** the message (mouse) or **double-tap** it (touch). Do it again to take your heart back. |
| Change or remove your reaction | Tap a chip. Tapping the chip you used takes it off. The quick row highlights the reactions you already have. |
| Use the keyboard | Focus a message and press the **Menu** key (or **Shift+F10**). Press **Up** from the first menu item to reach the quick row, move with **Left**/**Right**, and press **Enter**. Chips are buttons: reach them with **Tab** and press **Enter**. |

A reaction appears at once. If the server refuses it (too many reactions in a short time, or the message was deleted) it is taken back and a short notice appears at the bottom of the chat.

Double-clicking a message used to start a reply on desktop. It now adds a heart; messages that cannot take a reaction (for example one that is still being sent) keep the old behaviour. Use the menu's **Reply** instead.

### How many reactions can one person leave?

The admin decides with [`MAX_REACTIONS_PER_USER`](./Environment-Variables.md) (`1` to `3`, default `1`):

- With **1**, choosing another emoji **replaces** your previous reaction, and choosing the same emoji removes it. This is how Telegram behaves.
- With **2** or **3**, you can keep that many different emoji on one message. A new one pushes out your oldest.

The setting applies without restarting the server. Open clients pick it up when the page is loaded again.

## Who reacted

- **Right-click** a chip (mouse), **press and hold** a chip (touch), or choose **Reacted by** in the message menu to see the people behind the reactions. There is a tab for each emoji and an **All** tab. Up to 200 people are listed; the tabs always show the true totals.
- In **direct chats and groups** every member can see the list.
- In **channels** only the **channel owner** can see who reacted. Subscribers see the counts and can react, but they get no list (the server refuses the request), because subscribers of a public channel are strangers to each other.

## Notifications

When someone reacts to your message you get a push notification ("Bob reacted ❤️ to your message"), at most one per person and message per minute. You do not get one when you react to your own message, when the chat is muted, when you are online in the app, or when you hid the message. If you turned **message preview** off, the notification only says "New reaction". The text of the message is never part of a reaction notification.

## Limits

- 30 reaction changes per minute per person. Beyond that the app shows "Too many reactions. Please slow down."
- A reaction is exactly one emoji (skin tones, flags and joined emoji are fine).
- Reactions go away with their message, chat or account. When someone deletes their account, the counts on other people's screens update the next time the messages are loaded.

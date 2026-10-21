import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { MessageItem } from "../../../src/components/chat/messages/MessageItem.jsx";
import ServiceChip from "../../../src/components/chat/messages/ServiceChip.jsx";
import { buildPinSystemEvent } from "../../../src/utils/messagePins.js";

const ME = { id: "11111111-1111-4111-a111-111111111111", username: "alice", nickname: "Alice", color: "#10b981" };
const CHAT = "44444444-4444-4444-a444-444444444444";
const PINNED = "33333333-3333-4333-a333-333333333331";
const ENTRY = "33333333-3333-4333-a333-333333333399";

const pinEntry = (overrides = {}) => ({
  id: ENTRY,
  user_id: "22222222-2222-4222-a222-222222222222",
  username: "bob",
  nickname: "Bob",
  body: `[[system:pinned:${PINNED}]]`,
  service: { action: "pin", messageId: PINNED, actorId: "22222222-2222-4222-a222-222222222222" },
  created_at: "2024-01-01T12:00:00.000Z",
  files: [],
  replyTo: null,
  ...overrides,
});

const withChip = (msg, isOwn = false) => ({ ...msg, _systemEvent: buildPinSystemEvent(msg, { isOwn }) });

const BASE_PROPS = {
  user: ME,
  chatId: CHAT,
  formatTime: () => "12:00",
  unreadMarkerId: null,
  messageFilesProps: {},
  getMessageDayLabel: null,
  isDesktop: true,
  isMobileTouchDevice: false,
};

describe("ServiceChip", () => {
  test("a plain service line is text, not a button", async () => {
    await render(<ServiceChip event={{ type: "joined", name: "Carol", suffix: "joined the group" }} />);
    await expect.element(page.getByText("Carol")).toBeVisible();
    expect(document.querySelector("button")).toBeNull();
  });

  test("a line that points at a message is a button that jumps there", async () => {
    const onJump = vi.fn();
    await render(
      <ServiceChip
        event={{ type: "pin", name: "Bob", suffix: "pinned a message", text: "Bob pinned a message", jumpToMessageId: PINNED }}
        onJump={onJump}
      />,
    );
    await page.getByRole("button", { name: /Bob pinned a message/ }).click();
    expect(onJump).toHaveBeenCalledWith(PINNED);
  });

  test("without a jump handler it stays text", async () => {
    await render(
      <ServiceChip event={{ type: "pin", name: "Bob", suffix: "pinned a message", jumpToMessageId: PINNED }} />,
    );
    expect(document.querySelector("button")).toBeNull();
  });
});

describe("MessageItem - 'X pinned a message'", () => {
  test("shows a centered chip with the actor's name and no bubble", async () => {
    await render(<MessageItem {...BASE_PROPS} msg={withChip(pinEntry())} onJumpToMessage={vi.fn()} />);
    await expect.element(page.getByText("Bob")).toBeVisible();
    await expect.element(page.getByText("pinned a message")).toBeVisible();
    expect(document.querySelector("[data-message-bubble]")).toBeNull();
    expect(document.body.textContent).not.toContain("[[system");
  });

  test("my own pin reads 'You pinned a message'", async () => {
    const mine = pinEntry({ username: ME.username, nickname: ME.nickname, user_id: ME.id });
    await render(<MessageItem {...BASE_PROPS} msg={withChip(mine, true)} onJumpToMessage={vi.fn()} />);
    await expect.element(page.getByText("You")).toBeVisible();
  });

  test("a click on the chip jumps to the pinned message", async () => {
    const onJumpToMessage = vi.fn();
    await render(<MessageItem {...BASE_PROPS} msg={withChip(pinEntry())} onJumpToMessage={onJumpToMessage} />);
    await page.getByRole("button", { name: /Go to the message/ }).click();
    expect(onJumpToMessage).toHaveBeenCalledWith(PINNED);
  });

  test("in selection mode the chip does not jump (a click only ticks the row)", async () => {
    const onJumpToMessage = vi.fn();
    await render(
      <MessageItem
        {...BASE_PROPS}
        msg={withChip(pinEntry())}
        onJumpToMessage={onJumpToMessage}
        selectionMode
        onToggleSelect={vi.fn()}
      />,
    );
    expect(document.querySelector("button")).toBeNull();
    expect(onJumpToMessage).not.toHaveBeenCalled();
  });
});

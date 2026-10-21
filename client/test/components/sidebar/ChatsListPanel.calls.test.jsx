/**
 * The chat list line for a chat whose last message is a call entry.
 */
import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import ChatsListPanel from "../../../src/components/sidebar/list/ChatsListPanel.jsx";

const ME = { id: "u-alice", username: "alice", nickname: "Alice", color: "#10b981" };
const BOB = { id: "u-bob", username: "bob", nickname: "Bob", color: "#3b82f6" };

const member = (user) => ({
  id: user.id,
  username: user.username,
  nickname: user.nickname,
  avatar_url: null,
  color: user.color,
  status: "offline",
  role: "member",
  user_role: "user",
  user_verified: 0,
});

const chatWith = (last = {}) => ({
  id: "chat-1",
  type: "dm",
  verified: false,
  members: [member(ME), member(BOB)],
  last_message: "",
  last_message_files: [],
  last_message_type: "message",
  last_call: null,
  last_time: "2026-09-01T12:00:00Z",
  last_sender_id: BOB.id,
  last_sender_username: BOB.username,
  last_message_read_at: null,
  unread_count: 0,
  _muted: false,
  ...last,
});

const BASE_PROPS = {
  loadingChats: false,
  user: ME,
  editMode: false,
  activeChatId: null,
  selectedChats: [],
  formatChatTimestamp: () => "12:00 PM",
  requestDeleteChats: vi.fn(),
  toggleSelectChat: vi.fn(),
  setActiveChatId: vi.fn(),
  setActivePeer: vi.fn(),
  setMobileTab: vi.fn(),
  setUnreadInChat: vi.fn(),
  lastMessageIdRef: { current: null },
  chatsSearchQuery: "",
  chatsSearchFocused: false,
  discoverLoading: false,
  discoverUsers: [],
  discoverGroups: [],
  discoverChannels: [],
  discoverSaved: false,
  isSavedChatActive: false,
};

const callChat = ({ from = BOB, kind = "audio", outcome = "completed", durationSec = 5, last_message = "x", ...rest } = {}) =>
  chatWith({
    last_message,
    last_message_type: "call",
    last_call: { callId: "c-1", kind, outcome, durationSec },
    last_sender_id: from.id,
    last_sender_username: from.username,
    ...rest,
  });

const row = () => document.querySelector("button[class*='w-full'], [role='button']") || document.body;

describe("ChatsListPanel - call entry as the last message", () => {
  test.each([
    ["a call I made that connected", { from: ME }, "Outgoing call"],
    ["a call I received that connected", { from: BOB }, "Incoming call"],
    ["my video call that connected", { from: ME, kind: "video" }, "Outgoing video call"],
    ["their video call that connected", { from: BOB, kind: "video" }, "Incoming video call"],
    ["a call I missed", { from: BOB, outcome: "missed", durationSec: null }, "Missed call"],
    ["a video call I missed", { from: BOB, kind: "video", outcome: "missed", durationSec: null }, "Missed video call"],
    ["a call they did not answer", { from: ME, outcome: "missed", durationSec: null }, "No answer"],
    ["a declined call", { from: ME, outcome: "declined", durationSec: null }, "Declined call"],
    ["a cancelled video call", { from: BOB, kind: "video", outcome: "cancelled", durationSec: null }, "Cancelled video call"],
    ["a busy call", { from: ME, outcome: "busy", durationSec: null }, "Busy"],
    ["a failed call", { from: BOB, outcome: "failed", durationSec: null }, "Call failed"],
  ])("%s says %s", async (_label, overrides, text) => {
    render(<ChatsListPanel {...BASE_PROPS} visibleChats={[callChat(overrides)]} />);
    await expect.element(page.getByText(text, { exact: true })).toBeInTheDocument();
  });

  test("never shows an empty line, even when the server's line is missing", async () => {
    render(<ChatsListPanel {...BASE_PROPS} visibleChats={[callChat({ from: BOB, last_message: "" })]} />);
    await expect.element(page.getByText("Incoming call", { exact: true })).toBeInTheDocument();
  });

  test("my call has no 'You:' and no read ticks, it belongs to both of us", async () => {
    render(<ChatsListPanel {...BASE_PROPS} visibleChats={[callChat({ from: ME })]} />);
    await expect.element(page.getByText("Outgoing call", { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("You:");
    expect(document.body.textContent).not.toMatch(/\bRead\b|\bSent\b/);
  });

  test("draws the direction arrow, red for a missed call", async () => {
    render(
      <ChatsListPanel
        {...BASE_PROPS}
        visibleChats={[callChat({ from: BOB, outcome: "missed", durationSec: null })]}
      />,
    );
    await expect.element(page.getByText("Missed call", { exact: true })).toBeInTheDocument();
    const arrow = document.querySelector("[data-call-direction]");
    expect(arrow.getAttribute("data-call-direction")).toBe("in");
    expect(arrow.getAttribute("class")).toMatch(/rose/);
  });

  test("an outgoing arrow points the other way and is green when the call connected", async () => {
    render(<ChatsListPanel {...BASE_PROPS} visibleChats={[callChat({ from: ME })]} />);
    await expect.element(page.getByText("Outgoing call", { exact: true })).toBeInTheDocument();
    const arrow = document.querySelector("[data-call-direction]");
    expect(arrow.getAttribute("data-call-direction")).toBe("out");
    expect(arrow.getAttribute("class")).toMatch(/emerald/);
  });

  test("a missed call counts as unread through the usual badge", async () => {
    render(
      <ChatsListPanel
        {...BASE_PROPS}
        visibleChats={[callChat({ from: BOB, outcome: "missed", durationSec: null, unread_count: 1 })]}
      />,
    );
    await expect.element(page.getByText("Missed call", { exact: true })).toBeInTheDocument();
    expect(row().textContent).toContain("1");
  });

  test("a text message after a call is drawn as a normal line again", async () => {
    render(
      <ChatsListPanel
        {...BASE_PROPS}
        visibleChats={[chatWith({ last_message: "See you soon", last_message_type: "message", last_call: null })]}
      />,
    );
    await expect.element(page.getByText("See you soon")).toBeInTheDocument();
    expect(document.querySelector("[data-call-direction]")).toBeNull();
  });
});

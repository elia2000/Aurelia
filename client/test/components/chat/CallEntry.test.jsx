import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

import { MessageItem } from "../../../src/components/chat/messages/MessageItem.jsx";
import { CallContext } from "../../../src/calls/callContext.js";

const ME = { id: "11111111-1111-4111-a111-111111111111", username: "alice", nickname: "Alice", color: "#10b981" };
const BOB = {
  id: "22222222-2222-4222-a222-222222222222",
  username: "bob",
  nickname: "Bob",
  avatar_url: "/bob.png",
  color: "#3b82f6",
};
const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";

const entry = ({ from = BOB, kind = "audio", outcome = "completed", durationSec = 23, ...rest } = {}) => ({
  id: MSG,
  chat_id: CHAT,
  user_id: from.id,
  username: from.username,
  nickname: from.nickname,
  color: from.color,
  avatar_url: null,
  body: "",
  type: "call",
  messageType: "call",
  call: { callId: "c-1", kind, outcome, durationSec },
  created_at: "2024-01-01T12:00:00.000Z",
  read_at: null,
  edited: 0,
  files: [],
  replyTo: null,
  reactions: [],
  ...rest,
});

const BASE_PROPS = {
  user: ME,
  chatId: CHAT,
  formatTime: () => "12:00",
  unreadMarkerId: null,
  messageFilesProps: {},
  getMessageDayLabel: null,
  isDesktop: true,
  isMobileTouchDevice: false,
  isGroupChat: false,
  isChannelChat: false,
  onJumpToMessage: vi.fn(),
  callPeer: BOB,
};

let startCall;

const renderEntry = (msg, { calls = {}, ...props } = {}) =>
  render(
    <CallContext.Provider
      value={{ supported: true, inCall: false, startCall, state: { phase: "idle" }, ...calls }}
    >
      <MessageItem {...BASE_PROPS} msg={msg} {...props} />
    </CallContext.Provider>,
  );

const entryEl = () => document.querySelector("[data-call-entry]");

beforeEach(() => {
  startCall = vi.fn(async () => {});
});

describe("CallEntry - what each entry says", () => {
  test.each([
    // [label, message overrides, title, subtitle, direction, outcome]
    ["my voice call that connected", { from: ME, durationSec: 23 }, "Outgoing call", "0:23", "out"],
    ["their voice call that connected", { from: BOB, durationSec: 125 }, "Incoming call", "2:05", "in"],
    ["my video call that connected", { from: ME, kind: "video", durationSec: 3723 }, "Outgoing video call", "1:02:03", "out"],
    ["their video call that connected", { from: BOB, kind: "video", durationSec: 9 }, "Incoming video call", "0:09", "in"],
    ["a call I missed", { from: BOB, outcome: "missed", durationSec: null }, "Missed call", "Not answered", "in"],
    ["a video call I missed", { from: BOB, kind: "video", outcome: "missed", durationSec: null }, "Missed video call", "Not answered", "in"],
    ["a call they did not answer", { from: ME, outcome: "missed", durationSec: null }, "No answer", "They didn't answer", "out"],
    ["a call they declined", { from: ME, outcome: "declined", durationSec: null }, "Declined call", "They declined", "out"],
    ["a call I declined", { from: BOB, outcome: "declined", durationSec: null }, "Declined call", "You declined", "in"],
    ["a call I cancelled", { from: ME, outcome: "cancelled", durationSec: null }, "Cancelled call", "You hung up first", "out"],
    ["a call they cancelled", { from: BOB, kind: "video", outcome: "cancelled", durationSec: null }, "Cancelled video call", "They hung up first", "in"],
    ["a call when they were busy", { from: ME, outcome: "busy", durationSec: null }, "Busy", "They were on another call", "out"],
    ["a call that failed", { from: ME, outcome: "failed", durationSec: null }, "Call failed", "Couldn't connect", "out"],
    ["a video call that failed", { from: BOB, kind: "video", outcome: "failed", durationSec: null }, "Video call failed", "Couldn't connect", "in"],
  ])("%s", async (_label, overrides, title, subtitle, direction) => {
    renderEntry(entry(overrides));
    await expect.element(page.getByText(title, { exact: true })).toBeInTheDocument();
    expect(entryEl().textContent).toContain(subtitle);
    expect(entryEl().getAttribute("data-call-direction")).toBe(direction);
    expect(entryEl().getAttribute("data-call-kind")).toBe(overrides.kind || "audio");
  });

  test("the length is also spoken in words for a screen reader", async () => {
    renderEntry(entry({ from: ME, durationSec: 125 }));
    await expect.element(page.getByText("2 min 5 s")).toBeInTheDocument();
  });

  test("a call with no length (unreadable) still shows its title", async () => {
    renderEntry(entry({ from: BOB, durationSec: null }));
    await expect.element(page.getByText("Incoming call", { exact: true })).toBeInTheDocument();
  });

  test("an outcome the client does not know is a plain Call, not an empty bubble", async () => {
    renderEntry(entry({ from: BOB, kind: "video", outcome: "from-the-future", durationSec: null }));
    await expect.element(page.getByText("Video call", { exact: true })).toBeInTheDocument();
    expect(entryEl()).not.toBeNull();
  });

  test("an entry with no call object at all still draws", async () => {
    renderEntry(entry({ from: BOB, call: null }));
    await expect.element(page.getByText("Call", { exact: true })).toBeInTheDocument();
  });

  test("a missed call's arrow and reason are red", async () => {
    renderEntry(entry({ from: BOB, outcome: "missed", durationSec: null }));
    await expect.element(page.getByText("Missed call", { exact: true })).toBeInTheDocument();
    expect(entryEl().querySelector("p:nth-of-type(2)").className).toMatch(/rose/);
  });

  test("a connected call's arrow and length are green", async () => {
    renderEntry(entry({ from: BOB, durationSec: 5 }));
    await expect.element(page.getByText("Incoming call", { exact: true })).toBeInTheDocument();
    const detail = entryEl().querySelector("p:nth-of-type(2)");
    expect(detail.className).toMatch(/emerald/);
    expect(detail.className).not.toMatch(/rose/);
  });
});

describe("CallEntry - place in the chat", () => {
  test("my entry sits on the right, like my other bubbles", async () => {
    renderEntry(entry({ from: ME }));
    await expect.element(page.getByText("Outgoing call", { exact: true })).toBeInTheDocument();
    expect(document.querySelector("[data-message-row]").className).toContain("justify-end");
  });

  test("their entry sits on the left, like their other bubbles", async () => {
    renderEntry(entry({ from: BOB }));
    await expect.element(page.getByText("Incoming call", { exact: true })).toBeInTheDocument();
    expect(document.querySelector("[data-message-row]").className).toContain("justify-start");
  });

  test("shows the time but no sent or read ticks", async () => {
    renderEntry(entry({ from: ME, read_at: "2024-01-01T12:01:00.000Z" }));
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    expect(document.querySelector("[data-message-meta]").textContent).toBe("12:00");
    expect(document.body.textContent).not.toMatch(/\bRead\b|\bSent\b/);
  });

  test("has no text body and no swipe-to-reply hint target", async () => {
    renderEntry(entry({ from: BOB }));
    await expect.element(page.getByText("Incoming call", { exact: true })).toBeInTheDocument();
    expect(document.querySelector(".sb-markdown")).toBeNull();
  });

  test("double click does not reply to it", async () => {
    const onReply = vi.fn();
    renderEntry(entry({ from: BOB }), { onReply });
    await expect.element(page.getByText("Incoming call", { exact: true })).toBeInTheDocument();
    const bubble = document.querySelector("[data-message-bubble]");
    bubble.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(onReply).not.toHaveBeenCalled();
  });

  test("a right click opens the message menu for it (the menu then offers delete only)", async () => {
    const onOpenContextMenu = vi.fn();
    const msg = entry({ from: BOB });
    renderEntry(msg, { onOpenContextMenu });
    await expect.element(page.getByText("Incoming call", { exact: true })).toBeInTheDocument();
    const row = document.querySelector("[data-message-row]");
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30, button: 2 }),
    );
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
    expect(onOpenContextMenu.mock.calls[0][0]).toMatchObject({ kind: "message", data: { message: msg } });
  });
});

describe("CallEntry - the call back button", () => {
  test("a voice entry has a phone button that starts a voice call to the same person", async () => {
    renderEntry(entry({ from: ME, kind: "audio" }));
    const button = page.getByRole("button", { name: "Call back" });
    await expect.element(button).toBeInTheDocument();
    expect(document.querySelector("[data-call-back]").getAttribute("data-call-back")).toBe("audio");
    await button.click();
    expect(startCall).toHaveBeenCalledTimes(1);
    expect(startCall).toHaveBeenCalledWith({
      chatId: CHAT,
      kind: "audio",
      peer: { userId: BOB.id, username: "bob", nickname: "Bob", avatarUrl: "/bob.png", color: "#3b82f6" },
    });
  });

  test("a video entry has a camera button that starts a video call to the same person", async () => {
    renderEntry(entry({ from: BOB, kind: "video", outcome: "missed", durationSec: null }));
    const button = page.getByRole("button", { name: "Video call back" });
    await expect.element(button).toBeInTheDocument();
    expect(document.querySelector("[data-call-back]").getAttribute("data-call-back")).toBe("video");
    await button.click();
    expect(startCall).toHaveBeenCalledWith({
      chatId: CHAT,
      kind: "video",
      peer: expect.objectContaining({ userId: BOB.id, username: "bob" }),
    });
  });

  test("the button calls the other person even when the entry is mine", async () => {
    renderEntry(entry({ from: ME, kind: "video" }));
    await page.getByRole("button", { name: "Video call back" }).click();
    expect(startCall.mock.calls[0][0].peer.userId).toBe(BOB.id);
  });

  test("it can be reached and used from the keyboard", async () => {
    renderEntry(entry({ from: BOB, kind: "audio" }));
    await expect.element(page.getByRole("button", { name: "Call back" })).toBeInTheDocument();
    const button = document.querySelector("[data-call-back]");
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    expect(startCall).toHaveBeenCalledTimes(1);
  });

  test("it is off while another call is going on", async () => {
    renderEntry(entry({ from: BOB, kind: "video" }), { calls: { inCall: true } });
    const button = page.getByRole("button", { name: "Video call back" });
    await expect.element(button).toBeDisabled();
    expect(document.querySelector("[data-call-back]").title).toMatch(/current call/i);
    await button.click({ force: true }).catch(() => {});
    expect(startCall).not.toHaveBeenCalled();
  });

  test("it is off when calls are not available", async () => {
    renderEntry(entry({ from: BOB, kind: "audio" }), { calls: { supported: false } });
    await expect.element(page.getByRole("button", { name: "Call back" })).toBeDisabled();
    expect(document.querySelector("[data-call-back]").title).toMatch(/unavailable/i);
    expect(startCall).not.toHaveBeenCalled();
  });

  test("it is off when the other person's account is gone", async () => {
    renderEntry(entry({ from: ME, kind: "audio" }), { callPeer: { nickname: "Deleted account", isDeleted: true } });
    await expect.element(page.getByRole("button", { name: "Call back" })).toBeDisabled();
  });

  test("it is off when the chat has no other person to call", async () => {
    renderEntry(entry({ from: ME, kind: "audio" }), { callPeer: null });
    await expect.element(page.getByRole("button", { name: "Call back" })).toBeDisabled();
  });

  test("a call that fails to start does not break the page", async () => {
    startCall = vi.fn(async () => {
      throw new Error("A call is already in progress.");
    });
    renderEntry(entry({ from: BOB, kind: "audio" }));
    await page.getByRole("button", { name: "Call back" }).click();
    expect(startCall).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole("button", { name: "Call back" })).toBeEnabled();
  });
});

describe("CallEntry - selection mode", () => {
  test("the call back button does nothing and is not focusable while messages are being selected", async () => {
    const onToggleSelect = vi.fn();
    renderEntry(entry({ from: BOB, kind: "video" }), { selectionMode: true, onToggleSelect, isSelected: false });
    await expect.element(page.getByText("Incoming video call", { exact: true })).toBeInTheDocument();
    const button = document.querySelector("[data-call-back]");
    expect(button.closest("[inert]")).not.toBeNull();
    button.click();
    expect(startCall).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(document.activeElement).not.toBe(button);
  });

  test("a click on the entry ticks the row instead", async () => {
    const onToggleSelect = vi.fn();
    renderEntry(entry({ from: BOB, kind: "audio" }), { selectionMode: true, onToggleSelect, isSelected: false });
    await expect.element(page.getByText("Incoming call", { exact: true })).toBeInTheDocument();
    document.querySelector("[data-call-entry]").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(startCall).not.toHaveBeenCalled();
  });

  test("outside selection mode nothing is inert", async () => {
    renderEntry(entry({ from: BOB, kind: "audio" }));
    await expect.element(page.getByRole("button", { name: "Call back" })).toBeInTheDocument();
    expect(document.querySelector("[inert]")).toBeNull();
  });

  test("the row is described by what the entry says, not just 'Call'", async () => {
    renderEntry(entry({ from: ME, kind: "video", outcome: "declined", durationSec: null }), {
      selectionMode: true,
      onToggleSelect: vi.fn(),
    });
    await expect.element(page.getByText("Declined video call", { exact: true })).toBeInTheDocument();
    const label = document.querySelector("[role=checkbox]").getAttribute("aria-label");
    expect(label).toContain("Declined video call");
    expect(label).toContain("They declined");
  });
});

describe("messages of a type the client does not know", () => {
  test("show a small note instead of an empty bubble", async () => {
    renderEntry({
      id: MSG,
      chat_id: CHAT,
      user_id: BOB.id,
      username: "bob",
      nickname: "Bob",
      color: BOB.color,
      body: "",
      messageType: "poll",
      call: null,
      created_at: "2024-01-01T12:00:00.000Z",
      files: [],
      replyTo: null,
    });
    await expect.element(page.getByText(/not supported by your version/i)).toBeInTheDocument();
    expect(document.querySelector("[data-call-entry]")).toBeNull();
  });

  test("an unknown type that carries text is drawn as a normal message", async () => {
    renderEntry({
      id: MSG,
      chat_id: CHAT,
      user_id: BOB.id,
      username: "bob",
      nickname: "Bob",
      color: BOB.color,
      body: "Lunch at noon?",
      messageType: "poll",
      call: null,
      created_at: "2024-01-01T12:00:00.000Z",
      files: [],
      replyTo: null,
    });
    await expect.element(page.getByText("Lunch at noon?")).toBeInTheDocument();
    expect(document.querySelector("[data-unsupported-message]")).toBeNull();
  });
});

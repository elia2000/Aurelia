import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import KeyChangeNotice from "../../../src/components/chat/messages/KeyChangeNotice.jsx";
import { MessageItem } from "../../../src/components/chat/messages/MessageItem.jsx";
import { MessageTimeline } from "../../../src/components/chat/messages/MessageTimeline.jsx";
import {
  NOTICE_KIND as K,
  NOTICE_RESOLUTION as R,
  NOTICE_STATE as S,
  __setKeyNoticeStoreForTests,
  createKeyNoticeStore,
  mergeKeyNotices,
  noticeToMessage,
  STORAGE_PREFIX,
} from "../../../src/e2ee/keyChangeNotices.js";
import { onSafetyNumberRequest } from "../../../src/e2ee/safetyNumberRequests.js";

const line = (over = {}) => ({
  id: "n1",
  kind: K.ADDED,
  userId: "bob",
  at: Date.UTC(2026, 2, 1, 10, 30),
  deviceIds: ["d2"],
  count: 1,
  verified: false,
  state: S.OPEN,
  resolution: null,
  ...over,
});
const eventOf = (over = {}, peerName = "Alice") =>
  noticeToMessage(line(over), { chatId: "chat-1", peerName, selfUserId: "me" })._systemEvent;

let storage;
let store;
beforeEach(() => {
  const map = new Map();
  storage = { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  store = createKeyNoticeStore({ storage });
  __setKeyNoticeStoreForTests(store);
});
afterEach(() => __setKeyNoticeStoreForTests(null));

describe("KeyChangeNotice", () => {
  test("a new device of a contact never verified: an amber line with a Verify button", async () => {
    await render(<KeyChangeNotice event={eventOf()} />);
    await expect.element(page.getByText("Alice added a new device. Verify the safety number")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Verify" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Dismiss this notice" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-key-notice]").getAttribute("data-severity")).toBe("warning");
  });

  test("several new devices are counted", async () => {
    await render(<KeyChangeNotice event={eventOf({ count: 3, deviceIds: ["a", "b", "c"] })} />);
    await expect.element(page.getByText("Alice added 3 new devices. Verify the safety number")).toBeVisible();
  });

  test("a verified contact's change is the stronger, red 'Safety number changed'", async () => {
    await render(<KeyChangeNotice event={eventOf({ verified: true })} />);
    await expect.element(page.getByText("Safety number changed")).toBeVisible();
    await expect.element(page.getByText(/Alice added a new device\. It is blocked until you verify the new number/)).toBeVisible();
    const box = document.querySelector("[data-key-notice]");
    expect(box.getAttribute("data-severity")).toBe("danger");
    expect(box.className).toContain("border-s-rose-500");
    await expect.element(page.getByRole("button", { name: "Verify" })).toBeVisible();
  });

  test("changed keys are red too, and not dismissible while they conflict", async () => {
    await render(<KeyChangeNotice event={eventOf({ kind: K.MISMATCH })} />);
    await expect.element(page.getByText("Alice's security keys changed unexpectedly")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Dismiss this notice" })).not.toBeInTheDocument();
  });

  test("a removed device is news that can be dismissed at once", async () => {
    store.handleTrustEvent("me", { type: "assessed", userId: "bob", status: "ok", added: [], removed: ["d9"], mismatched: [], listed: [], known: 1, verified: false });
    const notice = store.list("me", "bob")[0];
    const event = noticeToMessage(notice, { chatId: "chat-1", peerName: "Alice", selfUserId: "me" })._systemEvent;
    await render(<KeyChangeNotice event={event} />);
    await expect.element(page.getByText("Alice removed a device. Verify the safety number")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss this notice" }).click();
    expect(store.list("me", "bob")).toHaveLength(0);
  });

  test("Verify asks for the safety number of this chat", async () => {
    const asked = vi.fn();
    const stop = onSafetyNumberRequest(asked);
    await render(<KeyChangeNotice event={eventOf()} />);
    await page.getByRole("button", { name: "Verify" }).click();
    stop();
    expect(asked).toHaveBeenCalledWith("chat-1");
  });

  test("once resolved the line is calm, has no Verify, and can be dismissed from the store", async () => {
    store.handleTrustEvent("me", { type: "assessed", userId: "bob", status: "devices_added", added: ["d2"], removed: [], mismatched: [], listed: ["d1", "d2"], known: 1, verified: false });
    store.handleTrustEvent("me", { type: "acknowledged", userId: "bob" });
    const notice = store.list("me", "bob")[0];
    expect(notice).toMatchObject({ state: S.RESOLVED, resolution: R.ACCEPTED });
    await render(<KeyChangeNotice event={noticeToMessage(notice, { chatId: "chat-1", peerName: "Alice", selfUserId: "me" })._systemEvent} />);
    await expect.element(page.getByText("You accepted Alice's new device")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Verify" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-key-notice]").getAttribute("data-severity")).toBe("calm");
    await page.getByRole("button", { name: "Dismiss this notice" }).click();
    expect(store.list("me", "bob")).toHaveLength(0);
    expect(storage.map.has(`${STORAGE_PREFIX}me:bob`)).toBe(false);
  });

  test("while messages are being selected the line has no buttons", async () => {
    await render(<KeyChangeNotice event={eventOf()} interactive={false} />);
    await expect.element(page.getByText("Alice added a new device. Verify the safety number")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Verify" })).not.toBeInTheDocument();
  });

  test("a name in Persian is drawn in its own script and direction", async () => {
    await render(<KeyChangeNotice event={eventOf({}, "علی")} />);
    const name = document.querySelector("bdi");
    expect(name.textContent).toBe("علی");
    expect(name.getAttribute("dir")).toBe("auto");
    expect(name.className).toContain("font-fa");
  });

  test("a line that is not a notice draws nothing", async () => {
    await render(<KeyChangeNotice event={{ type: "joined", name: "x" }} />);
    expect(document.querySelector("[data-key-notice]")).toBeNull();
  });
});

const BASE = {
  user: { id: 1, username: "me", nickname: "Me" },
  isFirstInGroup: true,
  formatTime: () => "10:30",
  unreadMarkerId: null,
  messageFilesProps: {},
  getMessageDayLabel: null,
  isDesktop: true,
  isMobileTouchDevice: false,
  isGroupChat: false,
  isChannelChat: false,
  onReply: vi.fn(),
  onJumpToMessage: vi.fn(),
  onForwardMessage: vi.fn(),
  onOpenSenderProfile: null,
  onOpenMention: null,
  onOpenForwardOrigin: null,
  onOpenContextMenu: null,
};

describe("a notice in the conversation", () => {
  const messageOf = (over = {}) => noticeToMessage(line(over), { chatId: "chat-1", peerName: "Alice", selfUserId: "me" });

  test("is drawn as a centered service line, not as a bubble", async () => {
    await render(<MessageItem {...BASE} msg={messageOf()} />);
    await expect.element(page.getByText("Alice added a new device. Verify the safety number")).toBeVisible();
    expect(document.querySelector("[data-message-row]")).toBeNull();
    const row = document.querySelector("[data-message-key]");
    expect(row.className).toContain("justify-center");
    expect(row.hasAttribute("data-no-select")).toBe(true);
  });

  test("shows the new state when the notice is resolved (the row re-renders)", async () => {
    const view = await render(<MessageItem {...BASE} msg={messageOf()} />);
    await expect.element(page.getByRole("button", { name: "Verify" })).toBeVisible();
    await view.rerender(<MessageItem {...BASE} msg={messageOf({ state: S.RESOLVED, resolution: R.VERIFIED })} />);
    await expect.element(page.getByText("You verified Alice's new safety number")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Verify" })).not.toBeInTheDocument();
  });

  test("in selection mode it is an unselectable row without buttons", async () => {
    await render(<MessageItem {...BASE} msg={messageOf()} selectionMode isSelected={false} onToggleSelect={vi.fn()} />);
    const row = document.querySelector("[data-message-key]");
    expect(row.getAttribute("role")).toBe("checkbox");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("aria-label")).toContain("Alice added a new device");
    await expect.element(page.getByRole("button", { name: "Verify" })).not.toBeInTheDocument();
  });
});

describe("a notice in the timeline", () => {
  const at = (hour, minute = 0) => new Date(Date.UTC(2026, 2, 1, hour, minute)).toISOString();
  const msg = (id, hour, minute, extra = {}) => ({
    id: `00000000-0000-4000-8000-00000000000${id}`,
    user_id: 2,
    username: "bob",
    nickname: "Bob",
    body: `hello ${id}`,
    created_at: at(hour, minute),
    files: [],
    replyTo: null,
    ...extra,
  });

  function groupsOf(messages) {
    const groups = [];
    messages.forEach((m) => {
      const key = new Date(m.created_at).toISOString().slice(0, 10);
      const last = groups[groups.length - 1];
      if (last?.dayKey === key) last.items.push(m);
      else groups.push({ dayKey: key, dayLabel: key, items: [m] });
    });
    return groups;
  }

  test("sits between the messages around the time it was noticed, under the one date chip", async () => {
    const merged = mergeKeyNotices(
      [msg(1, 10, 0), msg(2, 11, 0), msg(3, 12, 0)],
      [line({ at: Date.UTC(2026, 2, 1, 10, 30) })],
      { chatId: "chat-1", peerName: "Alice", selfUserId: "me" },
    );
    await render(
      <div style={{ height: 600 }}>
        <MessageTimeline
          activeChatId="chat-1"
          loadingMessages={false}
          messages={merged}
          groupedMessages={groupsOf(merged)}
          loadingOlderMessages={false}
          handleGroupChipClick={vi.fn()}
          renderMessageItem={(m) => <MessageItem {...BASE} msg={m} />}
          chatScrollRef={{ current: null }}
          handlePanelScroll={vi.fn()}
          handleScrollIntent={vi.fn()}
          timelineBottomSpacerPx={4}
        />
      </div>,
    );
    await expect.element(page.getByText("Alice added a new device. Verify the safety number")).toBeVisible();
    const order = [...document.querySelectorAll("[data-message-key], [data-key-notice]")]
      .map((el) => (el.hasAttribute("data-key-notice") ? "notice" : el.textContent.match(/hello \d/)?.[0] || null))
      .filter(Boolean);
    expect(order).toEqual(["hello 1", "notice", "hello 2", "hello 3"]);
    expect(document.querySelectorAll("[data-day-chip]")).toHaveLength(1);
  });

  test("a chat with nothing else still shows it", async () => {
    const merged = mergeKeyNotices([], [line()], { chatId: "chat-1", peerName: "Alice", selfUserId: "me" });
    await render(
      <div style={{ height: 400 }}>
        <MessageTimeline
          activeChatId="chat-1"
          loadingMessages={false}
          messages={merged}
          groupedMessages={groupsOf(merged)}
          loadingOlderMessages={false}
          handleGroupChipClick={vi.fn()}
          renderMessageItem={(m) => <MessageItem {...BASE} msg={m} />}
          chatScrollRef={{ current: null }}
          handlePanelScroll={vi.fn()}
          handleScrollIntent={vi.fn()}
          timelineBottomSpacerPx={4}
        />
      </div>,
    );
    await expect.element(page.getByText("Alice added a new device. Verify the safety number")).toBeVisible();
    await expect.element(page.getByText("Say something to start")).not.toBeInTheDocument();
  });
});

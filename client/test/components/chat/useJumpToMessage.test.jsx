import { useEffect, useRef, useState } from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("../../../src/utils/toast.js", () => ({ showToast: vi.fn() }));

import { useJumpToMessage } from "../../../src/hooks/chat/useJumpToMessage.js";
import { getMessageElement, jumpToLoadedMessage } from "../../../src/utils/messageJump.js";
import { showToast } from "../../../src/utils/toast.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CHAT = id(1000);
const msg = (n) => ({ id: id(n), body: `message ${n}`, created_at: `2026-03-01T10:${String(n % 60).padStart(2, "0")}:00.000Z` });

// A chat window: `all` is the whole history (oldest first); the window shows
// the newest `shown` of them, and a "load older" call reveals `limit` more.
function ChatHarness({ all, shown, hasOlder = true, onReady, onJump, chatId = CHAT, pageSize = 5 }) {
  const [count, setCount] = useState(shown);
  // plain objects that live as long as the harness (not read while drawing)
  const [stable] = useState(() => ({ loadCalls: [], chatIdRef: { current: chatId } }));
  const scrollRef = useRef(null);
  const messages = all.slice(Math.max(0, all.length - count));
  const loadMessages = async (_chatId, options) => {
    stable.loadCalls.push(options);
    setCount((current) => Math.min(all.length, current + options.limit));
  };
  const jump = useJumpToMessage({
    activeChatIdRef: stable.chatIdRef,
    messages,
    hasOlderMessages: hasOlder && count < all.length,
    loadMessages,
    chatScrollRef: scrollRef,
    pageSize,
    onJump,
  });
  useEffect(() => {
    onReady({ jump, loadCalls: stable.loadCalls, chatIdRef: stable.chatIdRef });
  });
  return (
    <div ref={scrollRef} style={{ height: 200, overflow: "auto" }}>
      {messages.map((m) => (
        <div key={m.id} id={`message-${m._serverId || m.id}`} style={{ height: 60 }}>
          <div data-message-bubble>{m.body}</div>
        </div>
      ))}
    </div>
  );
}

const history = (n) => Array.from({ length: n }, (_, i) => msg(i + 1));

async function setup(props) {
  let api;
  await render(<ChatHarness onReady={(value) => { api = value; }} {...props} />);
  return () => api;
}

beforeEach(() => vi.mocked(showToast).mockReset());

describe("jumpToLoadedMessage", () => {
  test("false when the message is not on the page", () => {
    expect(jumpToLoadedMessage(id(999), null)).toBe(false);
    expect(getMessageElement(id(999))).toBeNull();
  });

  test("scrolls a message that is on the page into view and flashes its bubble", async () => {
    const root = document.createElement("div");
    root.style.cssText = "height:100px;overflow:auto";
    for (let i = 0; i < 20; i += 1) {
      const row = document.createElement("div");
      row.id = `message-${id(i + 1)}`;
      row.style.height = "60px";
      row.innerHTML = '<div data-message-bubble>x</div>';
      root.appendChild(row);
    }
    document.body.appendChild(root);
    try {
      expect(jumpToLoadedMessage(id(15), root)).toBe(true);
      await vi.waitFor(() => expect(root.scrollTop).toBeGreaterThan(300));
      await vi.waitFor(() => expect(root.querySelector(".reply-flash")).not.toBeNull(), { timeout: 2000 });
      await vi.waitFor(() => expect(root.querySelector(".reply-flash")).toBeNull(), { timeout: 2000 });
    } finally {
      root.remove();
    }
  });
});

describe("jumpToLoadedMessage - motion", () => {
  const withRow = (run) => {
    const root = document.createElement("div");
    root.style.cssText = "height:400px;overflow:auto";
    const row = document.createElement("div");
    row.id = `message-${id(7)}`;
    row.style.height = "60px";
    row.innerHTML = "<div data-message-bubble>x</div>";
    root.appendChild(row);
    document.body.appendChild(root);
    const spy = vi.spyOn(row, "scrollIntoView").mockImplementation(() => {});
    try {
      run(root, spy);
    } finally {
      root.remove();
    }
  };

  const prefersReducedMotion = (reduce) =>
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: reduce && String(query).includes("prefers-reduced-motion"),
      media: String(query),
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));

  test("scrolls smoothly for a message that is close", () => {
    prefersReducedMotion(false);
    withRow((root, spy) => {
      jumpToLoadedMessage(id(7), root);
      expect(spy).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    });
    vi.restoreAllMocks();
  });

  test("jumps at once when the person asked for reduced motion", () => {
    prefersReducedMotion(true);
    withRow((root, spy) => {
      jumpToLoadedMessage(id(7), root);
      expect(spy).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
    });
    vi.restoreAllMocks();
  });
});

describe("useJumpToMessage", () => {
  test("a message that is on the page: no request, a flash, true", async () => {
    const onJump = vi.fn();
    const get = await setup({ all: history(30), shown: 10, onJump });
    const ok = await get().jump(id(28));
    expect(ok).toBe(true);
    expect(get().loadCalls).toHaveLength(0);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  test("an older message: loads older pages (before the oldest shown) until it is there", async () => {
    const onJump = vi.fn();
    const get = await setup({ all: history(40), shown: 10, pageSize: 5, onJump });
    const ok = await get().jump(id(3));
    expect(ok).toBe(true);
    const calls = get().loadCalls;
    expect(calls).toHaveLength(2);
    // each call asks for the page before the oldest message shown at that time
    expect(calls[0]).toMatchObject({ silent: true, prepend: true, beforeId: id(31), limit: 20 });
    expect(calls[1]).toMatchObject({ silent: true, prepend: true, beforeId: id(11) });
    // the pages grow, so a very old pin costs a few requests, not hundreds
    expect(calls[1].limit).toBeGreaterThan(calls[0].limit);
    expect(getMessageElement(id(3))).not.toBeNull();
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  test("one page is enough for a message just above the window", async () => {
    const get = await setup({ all: history(40), shown: 10, pageSize: 5 });
    expect(await get().jump(id(25))).toBe(true);
    expect(get().loadCalls).toHaveLength(1);
  });

  test("a message that is older than all history says so and returns false", async () => {
    const get = await setup({ all: history(12), shown: 10, hasOlder: true, pageSize: 5 });
    const ok = await get().jump(id(500));
    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith("That message is no longer available.", { tone: "error" });
  });

  test("when there is nothing older to load it does not ask", async () => {
    const get = await setup({ all: history(10), shown: 10, hasOlder: false });
    expect(await get().jump(id(500))).toBe(false);
    expect(get().loadCalls).toHaveLength(0);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  test("a message sent in this page session (temporary id, server id on the side) is found by its server id", async () => {
    const own = { id: "pending-1700000000000-abc123", _clientId: "pending-1700000000000-abc123", _serverId: id(10), body: "pin target", created_at: "2026-03-01T10:10:00.000Z" };
    const all = [...history(9), own];
    const onJump = vi.fn();
    const get = await setup({ all, shown: 10, onJump });
    expect(await get().jump(id(10))).toBe(true);
    expect(get().loadCalls).toHaveLength(0);
    expect(showToast).not.toHaveBeenCalled();
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  test("a message that still exists but is further back than the rounds reach says it is too far back, not gone", async () => {
    const get = await setup({ all: history(3300), shown: 10, pageSize: 20 });
    expect(await get().jump(id(1))).toBe(false);
    expect(get().loadCalls).toHaveLength(6);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("That message is too far back to jump to.", { tone: "error" });
  });

  test("bad ids do nothing", async () => {
    const get = await setup({ all: history(10), shown: 10 });
    expect(await get().jump("nope")).toBe(false);
    expect(await get().jump(null)).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  test("leaving the chat in the middle stops the search quietly", async () => {
    const get = await setup({ all: history(60), shown: 10, pageSize: 5 });
    const pending = get().jump(id(2));
    get().chatIdRef.current = id(2000); // another chat is opened
    expect(await pending).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  test("a newer jump replaces an older one that is still searching", async () => {
    const get = await setup({ all: history(60), shown: 10, pageSize: 5 });
    const first = get().jump(id(2));
    const second = get().jump(id(55));
    expect(await first).toBe(false);
    expect(await second).toBe(true);
  });

  test("the function stays the same between renders", async () => {
    const get = await setup({ all: history(10), shown: 5 });
    const first = get().jump;
    await get().jump(id(3)); // changes nothing, but forces a render in the harness
    expect(get().jump).toBe(first);
  });
});

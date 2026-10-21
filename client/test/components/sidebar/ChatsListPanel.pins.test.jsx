import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import ChatsListPanel from "../../../src/components/sidebar/list/ChatsListPanel.jsx";

const ME = { id: "11111111-1111-4111-a111-111111111111", username: "alice", nickname: "Alice", color: "#10b981" };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const dm = (n, nickname, extra = {}) => ({
  id: id(n),
  type: "dm",
  members: [
    { id: ME.id, username: ME.username, nickname: ME.nickname, color: ME.color, status: "offline", role: "member", user_role: "user", user_verified: 0 },
    { id: id(n + 100), username: nickname.toLowerCase(), nickname, avatar_url: null, color: "#3b82f6", status: "offline", role: "member", user_role: "user", user_verified: 0 },
  ],
  last_message: `hello ${nickname}`,
  last_time: "2026-09-01T12:00:00Z",
  last_message_files: [],
  unread_count: 0,
  _muted: false,
  ...extra,
});

const BASE_PROPS = {
  loadingChats: false,
  visibleChats: [],
  user: ME,
  editMode: false,
  activeChatId: null,
  selectedChats: [],
  formatChatTimestamp: () => "12:00",
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

// two pinned chats (Ann, Ben) on top of two ordinary ones
const chats = () => [
  dm(1, "Ann", { pinned: true, pinPosition: 0 }),
  dm(2, "Ben", { pinned: true, pinPosition: 1 }),
  dm(3, "Cat", { pinned: true, pinPosition: 2 }),
  dm(4, "Dan"),
];

const rowEl = (n) => document.querySelector(`[data-pin-row="${id(n)}"]`);
const button = (name) => page.getByRole("button", { name: new RegExp(name) });

const pointer = (type, init = {}) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    ...init,
  });

// A drag from one row to another, with a mouse: down on `from`, move in a few
// steps by `dy`, up.
async function mouseDrag(from, dy, { release = true } = {}) {
  const rect = from.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  from.dispatchEvent(pointer("pointerdown", { clientX: x, clientY: y }));
  for (let step = 1; step <= 6; step += 1) {
    window.dispatchEvent(pointer("pointermove", { clientX: x, clientY: y + (dy * step) / 6 }));
  }
  if (release) window.dispatchEvent(pointer("pointerup", { clientX: x, clientY: y + dy }));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const rowHeight = () => rowEl(2).getBoundingClientRect().top - rowEl(1).getBoundingClientRect().top;

describe("ChatsListPanel - pinned chats", () => {
  test("a pinned chat has a pin icon and says so; the others do not", async () => {
    await render(<ChatsListPanel {...BASE_PROPS} visibleChats={chats()} />);
    expect(document.querySelectorAll("[data-pin-icon]")).toHaveLength(3);
    await expect.element(button("Ann")).toHaveAttribute("aria-label", expect.stringContaining("pinned"));
    expect(button("Dan").element().getAttribute("aria-label")).not.toContain("pinned");
    expect(rowEl(4)).toBeNull();
  });

  test("the pin icon sits next to the unread badge", async () => {
    const list = chats();
    list[0].unread_count = 3;
    await render(<ChatsListPanel {...BASE_PROPS} visibleChats={list} />);
    const ann = button("Ann").element();
    expect(ann.querySelector("[data-pin-icon]")).not.toBeNull();
    expect(ann.textContent).toContain("3");
  });

  test("while the list is searched there is no pinned section: no icons and no dragging", async () => {
    await render(
      <ChatsListPanel {...BASE_PROPS} visibleChats={chats()} chatsSearchQuery="a" onReorderPinnedChats={vi.fn()} />,
    );
    expect(document.querySelectorAll("[data-pin-icon]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-pin-row]")).toHaveLength(0);
    expect(button("Ann").element().getAttribute("aria-label")).not.toContain("pinned");
  });

  test("a list with nothing pinned looks as before", async () => {
    await render(<ChatsListPanel {...BASE_PROPS} visibleChats={[dm(1, "Ann"), dm(2, "Ben")]} />);
    expect(document.querySelectorAll("[data-pin-icon]")).toHaveLength(0);
  });
});

describe("ChatsListPanel - dragging a pinned chat (mouse)", () => {
  let onReorder;
  beforeEach(() => {
    onReorder = vi.fn();
  });
  afterEach(() => {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });

  const renderPanel = (props = {}) =>
    render(
      <ChatsListPanel
        {...BASE_PROPS}
        visibleChats={chats()}
        onReorderPinnedChats={onReorder}
        {...props}
      />,
    );

  test("dragging a row down past the next one saves the new order", async () => {
    await renderPanel();
    await mouseDrag(rowEl(1), rowHeight() * 1.2);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith([id(2), id(1), id(3)]);
  });

  test("dragging a row up to the top", async () => {
    await renderPanel();
    await mouseDrag(rowEl(3), -rowHeight() * 2.1);
    expect(onReorder).toHaveBeenCalledWith([id(3), id(1), id(2)]);
  });

  test("a row cannot be dragged out of the pinned block", async () => {
    await renderPanel();
    await mouseDrag(rowEl(1), rowHeight() * 10);
    expect(onReorder).toHaveBeenCalledWith([id(2), id(3), id(1)]);
    onReorder.mockClear();
    await mouseDrag(rowEl(1), -rowHeight() * 10);
    expect(onReorder).not.toHaveBeenCalled(); // already at the top: no change
  });

  test("while dragging, the row follows the pointer and the others make room", async () => {
    await renderPanel();
    const height = rowHeight(); // measured before anything moves
    await mouseDrag(rowEl(1), height * 1.2, { release: false });
    expect(rowEl(1).dataset.dragging).toBe("true");
    expect(rowEl(1).style.transform).toMatch(/translateY\(/);
    const shifted = Number(/translateY\((-?[\d.]+)px\)/.exec(rowEl(2).style.transform)?.[1]);
    expect(shifted).toBeCloseTo(-height, 0);
    expect(rowEl(3).style.transform).toBe("");
    expect(document.body.style.userSelect).toBe("none");
    window.dispatchEvent(pointer("pointerup"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.body.style.userSelect).toBe("");
    expect(rowEl(1).dataset.dragging).toBeUndefined();
  });

  test("the click that ends a drag does not open the chat", async () => {
    const setActiveChatId = vi.fn();
    await renderPanel({ setActiveChatId });
    await mouseDrag(rowEl(1), rowHeight() * 1.2);
    button("Ann").element().click();
    expect(setActiveChatId).not.toHaveBeenCalled();
    // ...and the next click does
    await new Promise((resolve) => setTimeout(resolve, 350));
    button("Ann").element().click();
    expect(setActiveChatId).toHaveBeenCalledWith(id(1));
  });

  test("a press that hardly moves is a click, not a drag", async () => {
    const setActiveChatId = vi.fn();
    await renderPanel({ setActiveChatId });
    await mouseDrag(rowEl(1), 2);
    expect(onReorder).not.toHaveBeenCalled();
    button("Ann").element().click();
    expect(setActiveChatId).toHaveBeenCalledWith(id(1));
  });

  test("dropping a row where it started saves nothing", async () => {
    await renderPanel();
    await mouseDrag(rowEl(2), rowHeight() * 0.3);
    expect(onReorder).not.toHaveBeenCalled();
  });

  test("the right mouse button does not drag", async () => {
    await renderPanel();
    const rect = rowEl(1).getBoundingClientRect();
    rowEl(1).dispatchEvent(pointer("pointerdown", { button: 2, clientX: rect.left + 5, clientY: rect.top + 5 }));
    window.dispatchEvent(pointer("pointermove", { clientX: rect.left + 5, clientY: rect.top + 400 }));
    window.dispatchEvent(pointer("pointerup"));
    expect(onReorder).not.toHaveBeenCalled();
    expect(rowEl(1).dataset.dragging).toBeUndefined();
  });

  test("Escape cancels a drag in progress", async () => {
    await renderPanel();
    await mouseDrag(rowEl(1), rowHeight() * 1.2, { release: false });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    window.dispatchEvent(pointer("pointerup"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onReorder).not.toHaveBeenCalled();
    expect(rowEl(1).dataset.dragging).toBeUndefined();
  });

  test("a pointer that is cancelled (the browser took over) drops the drag", async () => {
    await renderPanel();
    await mouseDrag(rowEl(1), rowHeight() * 1.2, { release: false });
    window.dispatchEvent(pointer("pointercancel"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onReorder).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("");
  });

  test("in edit mode (the wiggling list) nothing can be dragged", async () => {
    await renderPanel({ editMode: true });
    expect(document.querySelectorAll("[data-pin-row]")).toHaveLength(0);
  });

  test("a single pinned chat has nothing to reorder", async () => {
    await render(
      <ChatsListPanel
        {...BASE_PROPS}
        visibleChats={[dm(1, "Ann", { pinned: true, pinPosition: 0 }), dm(2, "Ben")]}
        onReorderPinnedChats={onReorder}
      />,
    );
    await mouseDrag(rowEl(1), 200);
    expect(onReorder).not.toHaveBeenCalled();
  });

  test("without a handler there is no drag at all", async () => {
    await render(<ChatsListPanel {...BASE_PROPS} visibleChats={chats()} />);
    expect(document.querySelectorAll("[data-pin-row]")).toHaveLength(0);
  });
});

describe("ChatsListPanel - dragging a pinned chat (finger)", () => {
  const touch = (type, init = {}) => pointer(type, { pointerType: "touch", ...init });

  async function fingerDrag(from, dy, { holdMs, release = true }) {
    const rect = from.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    from.dispatchEvent(touch("pointerdown", { clientX: x, clientY: y }));
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    for (let step = 1; step <= 6; step += 1) {
      window.dispatchEvent(touch("pointermove", { clientX: x, clientY: y + (dy * step) / 6 }));
    }
    if (release) window.dispatchEvent(touch("pointerup", { clientX: x, clientY: y + dy }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  test("hold, then move: closes the menu the hold opened and reorders", async () => {
    const onReorder = vi.fn();
    const onCloseContextMenu = vi.fn();
    await render(
      <ChatsListPanel
        {...BASE_PROPS}
        visibleChats={chats()}
        onReorderPinnedChats={onReorder}
        onCloseContextMenu={onCloseContextMenu}
      />,
    );
    await fingerDrag(rowEl(1), rowHeight() * 1.2, { holdMs: 380 });
    expect(onCloseContextMenu).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith([id(2), id(1), id(3)]);
  });

  test("a finger that moves before the hold is over is scrolling: no drag", async () => {
    const onReorder = vi.fn();
    const onCloseContextMenu = vi.fn();
    await render(
      <ChatsListPanel
        {...BASE_PROPS}
        visibleChats={chats()}
        onReorderPinnedChats={onReorder}
        onCloseContextMenu={onCloseContextMenu}
      />,
    );
    await fingerDrag(rowEl(1), rowHeight() * 1.2, { holdMs: 0 });
    expect(onReorder).not.toHaveBeenCalled();
    expect(onCloseContextMenu).not.toHaveBeenCalled();
    expect(rowEl(1).dataset.dragging).toBeUndefined();
  });

  test("a hold with only a little wobble (menu open, then lift) is not a drag", async () => {
    const onReorder = vi.fn();
    const onCloseContextMenu = vi.fn();
    await render(
      <ChatsListPanel
        {...BASE_PROPS}
        visibleChats={chats()}
        onReorderPinnedChats={onReorder}
        onCloseContextMenu={onCloseContextMenu}
      />,
    );
    await fingerDrag(rowEl(1), 3, { holdMs: 380 });
    expect(onReorder).not.toHaveBeenCalled();
    expect(onCloseContextMenu).not.toHaveBeenCalled();
  });

  test("once armed, the page's own scroll is stopped under the finger", async () => {
    await render(
      <ChatsListPanel {...BASE_PROPS} visibleChats={chats()} onReorderPinnedChats={vi.fn()} />,
    );
    const rect = rowEl(1).getBoundingClientRect();
    rowEl(1).dispatchEvent(touch("pointerdown", { clientX: rect.left + 20, clientY: rect.top + 20 }));
    const early = new TouchEvent("touchmove", { cancelable: true, bubbles: true });
    window.dispatchEvent(early);
    expect(early.defaultPrevented).toBe(false); // before the hold: scrolling is allowed
    await new Promise((resolve) => setTimeout(resolve, 380));
    const late = new TouchEvent("touchmove", { cancelable: true, bubbles: true });
    window.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(true);
    window.dispatchEvent(touch("pointerup"));
  });
});

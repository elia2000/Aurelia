import { describe, test, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { MessageItem } from "../../../src/components/chat/messages/MessageItem.jsx";

const ME = { id: 1, username: "alice", nickname: "Alice", color: "#10b981" };
const BOB = { id: 2, username: "bob", nickname: "Bob", color: "#3b82f6" };

const makeMsg = (overrides = {}) => ({
  id: 7,
  user_id: BOB.id,
  username: BOB.username,
  nickname: BOB.nickname,
  color: BOB.color,
  avatar_url: null,
  body: "Hello world from Bob",
  created_at: "2024-01-01T12:00:00.000Z",
  read_at: null,
  edited: 0,
  files: [],
  replyTo: null,
  ...overrides,
});

const BASE_PROPS = {
  user: ME,
  formatTime: () => "12:00",
  unreadMarkerId: null,
  messageFilesProps: {},
  getMessageDayLabel: null,
  isDesktop: true,
  isMobileTouchDevice: false,
  isGroupChat: false,
  isChannelChat: false,
  onReply: vi.fn(),
  onJumpToMessage: vi.fn(),
};

// Everything MessageFiles reads, so a bubble with files can render on its own.
const filesProps = (type) => ({
  getFileRenderType: () => type,
  loadedMediaThumbs: new Set(),
  setLoadedMediaThumbs: vi.fn(),
  mediaAspectByKey: {},
  setMediaAspectByKey: vi.fn(),
  videoPosterByUrl: {},
  setVideoPosterByUrl: vi.fn(),
  openFocusMedia: vi.fn(),
  handleVideoThumbLoadedMetadata: vi.fn(),
});

const rowEl = () => document.querySelector("[data-message-row]");
const bubbleEl = () => document.querySelector("[data-message-bubble]");
const avatarCount = () => rowEl().querySelectorAll("[data-message-avatar]").length;

const fire = (el, type, init = {}) => {
  const Ctor = type.startsWith("pointer") ? PointerEvent : type.startsWith("key") ? KeyboardEvent : MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
};

const selectText = (node, from, to) => {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};

afterEach(() => {
  window.getSelection().removeAllRanges();
});

describe("MessageItem - right click opens the menu from the whole row", () => {
  test("a right click on the empty row, outside the bubble, opens the message menu", async () => {
    const onOpenContextMenu = vi.fn();
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} onOpenContextMenu={onOpenContextMenu} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const row = rowEl();
    expect(row).not.toBeNull();
    expect(bubbleEl().contains(row)).toBe(false);
    const event = fire(row, "contextmenu", { clientX: 900, clientY: 40 });
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
    expect(onOpenContextMenu.mock.calls[0][0]).toMatchObject({
      kind: "message",
      data: { message: expect.objectContaining({ id: 7 }) },
    });
  });

  test("the row spans the full width and carries all of the row's padding", async () => {
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} onOpenContextMenu={vi.fn()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const root = document.getElementById("message-7");
    expect(rowEl().getBoundingClientRect().width).toBe(root.getBoundingClientRect().width);
  });

  test("a right click on the bubble text opens the menu once", async () => {
    const onOpenContextMenu = vi.fn();
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} onOpenContextMenu={onOpenContextMenu} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(bubbleEl().querySelector(".sb-markdown"), "contextmenu", { clientX: 30, clientY: 30 });
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
  });

  test("own messages open it from the empty space too", async () => {
    const onOpenContextMenu = vi.fn();
    render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg({ user_id: ME.id, username: ME.username, nickname: ME.nickname })}
        onOpenContextMenu={onOpenContextMenu}
      />,
    );
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(rowEl(), "contextmenu", { clientX: 5, clientY: 5 });
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
  });

  test("system lines and the date chips do not get a message menu", async () => {
    const onOpenContextMenu = vi.fn();
    render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg({ _systemEvent: { type: "join", name: "Zed", suffix: "joined" } })}
        onOpenContextMenu={onOpenContextMenu}
      />,
    );
    await expect.element(page.getByText("joined")).toBeInTheDocument();
    expect(rowEl()).toBeNull();
    fire(document.getElementById("message-7"), "contextmenu");
    expect(onOpenContextMenu).not.toHaveBeenCalled();
  });

  test("no menu handler means the browser menu stays", async () => {
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} onOpenContextMenu={null} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const event = fire(rowEl(), "contextmenu");
    expect(event.defaultPrevented).toBe(false);
  });

  test("the avatar keeps its own sender menu and does not get the message menu on top", async () => {
    const onOpenContextMenu = vi.fn();
    render(
      <MessageItem
        {...BASE_PROPS}
        isGroupChat
        msg={makeMsg()}
        onOpenSenderProfile={vi.fn()}
        onOpenContextMenu={onOpenContextMenu}
      />,
    );
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const avatar = document.querySelector("[data-own-context-menu]");
    expect(avatar).not.toBeNull();
    fire(avatar, "contextmenu", { clientX: 10, clientY: 10 });
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
    expect(onOpenContextMenu.mock.calls[0][0].kind).toBe("user");
  });

  test("the sender name keeps its own menu too, by mouse and by keyboard", async () => {
    const onOpenContextMenu = vi.fn();
    render(
      <MessageItem
        {...BASE_PROPS}
        isGroupChat
        msg={makeMsg()}
        onOpenSenderProfile={vi.fn()}
        onOpenContextMenu={onOpenContextMenu}
      />,
    );
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const name = bubbleEl().querySelector("[data-own-context-menu]");
    expect(name).not.toBeNull();
    // The name opens its menu; the row sees the same event and steps aside.
    fire(name, "contextmenu", { clientX: 10, clientY: 10 });
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
    expect(onOpenContextMenu.mock.calls[0][0].kind).toBe("user");
    onOpenContextMenu.mockClear();
    fire(name, "keydown", { key: "ContextMenu" });
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
    expect(onOpenContextMenu.mock.calls[0][0].kind).toBe("user");
  });

  test("a name that cannot open a profile gets the message menu", async () => {
    const onOpenContextMenu = vi.fn();
    render(
      <MessageItem
        {...BASE_PROPS}
        isGroupChat
        msg={makeMsg()}
        onOpenContextMenu={onOpenContextMenu}
      />,
    );
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    expect(document.querySelector("[data-own-context-menu]")).toBeNull();
    fire(page.getByText("Bob", { exact: true }).element(), "contextmenu", { clientX: 10, clientY: 10 });
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
    expect(onOpenContextMenu.mock.calls[0][0].kind).toBe("message");
  });
});

describe("MessageItem - touch layout", () => {
  const touchProps = { ...BASE_PROPS, isDesktop: false, isMobileTouchDevice: true };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a long press on the empty space beside the bubble opens the menu", async () => {
    const onOpenContextMenu = vi.fn();
    render(<MessageItem {...touchProps} canSwipeReply={false} msg={makeMsg()} onOpenContextMenu={onOpenContextMenu} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(rowEl(), "pointerdown", { pointerType: "touch", pointerId: 9, clientX: 12, clientY: 12 });
    await wait(450);
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
    expect(onOpenContextMenu.mock.calls[0][0]).toMatchObject({ kind: "message", isMobile: true });
  });

  test("a long press on the bubble text opens the menu", async () => {
    const onOpenContextMenu = vi.fn();
    render(<MessageItem {...touchProps} canSwipeReply={false} msg={makeMsg()} onOpenContextMenu={onOpenContextMenu} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(bubbleEl().querySelector(".sb-markdown"), "pointerdown", { pointerType: "touch", pointerId: 9, clientX: 40, clientY: 40 });
    await wait(450);
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
  });

  test("the mouse never opens a long-press menu or starts a swipe on a narrow touch layout", async () => {
    const onOpenContextMenu = vi.fn();
    const onReply = vi.fn();
    render(<MessageItem {...touchProps} onReply={onReply} msg={makeMsg()} onOpenContextMenu={onOpenContextMenu} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const down = fire(bubbleEl(), "pointerdown", { pointerType: "mouse", pointerId: 1, button: 0, clientX: 200, clientY: 40 });
    fire(bubbleEl(), "pointermove", { pointerType: "mouse", pointerId: 1, clientX: 60, clientY: 40 });
    fire(bubbleEl(), "pointerup", { pointerType: "mouse", pointerId: 1, clientX: 60, clientY: 40 });
    await wait(750);
    expect(down.defaultPrevented).toBe(false);
    expect(onOpenContextMenu).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalled();
  });
});

describe("MessageItem - menu and selected text", () => {
  test("passes the selected text of this message to the menu", async () => {
    const onOpenContextMenu = vi.fn();
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} onOpenContextMenu={onOpenContextMenu} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const text = bubbleEl().querySelector(".sb-markdown").firstChild;
    selectText(text, 6, 11);
    fire(rowEl(), "contextmenu", { clientX: 5, clientY: 5 });
    expect(onOpenContextMenu.mock.calls[0][0].data.selectedText).toBe("world");
  });

  test("passes nothing when no text is selected", async () => {
    const onOpenContextMenu = vi.fn();
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} onOpenContextMenu={onOpenContextMenu} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(rowEl(), "contextmenu", { clientX: 5, clientY: 5 });
    expect(onOpenContextMenu.mock.calls[0][0].data.selectedText).toBe("");
  });

  test("the time and status are never part of the selected text", async () => {
    const onOpenContextMenu = vi.fn();
    render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg({ user_id: ME.id, username: ME.username, nickname: ME.nickname })}
        onOpenContextMenu={onOpenContextMenu}
      />,
    );
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const bubble = bubbleEl();
    const range = document.createRange();
    range.selectNodeContents(bubble);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    fire(rowEl(), "contextmenu", { clientX: 5, clientY: 5 });
    const selected = onOpenContextMenu.mock.calls[0][0].data.selectedText;
    expect(selected).toBe("Hello world from Bob");
  });

  test("the ContextMenu key opens the menu next to the bubble", async () => {
    const onOpenContextMenu = vi.fn();
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} onOpenContextMenu={onOpenContextMenu} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    rowEl().focus();
    expect(document.activeElement).toBe(rowEl());
    fire(rowEl(), "keydown", { key: "ContextMenu" });
    expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
    const { event } = onOpenContextMenu.mock.calls[0][0];
    const bubble = bubbleEl().getBoundingClientRect();
    expect(event.clientX).toBeGreaterThanOrEqual(bubble.left);
    expect(event.clientX).toBeLessThanOrEqual(bubble.right);
    expect(event.clientY).toBeGreaterThan(bubble.top);
    expect(event.clientY).toBeLessThanOrEqual(bubble.bottom);
  });
});

describe("MessageItem - double click and drag selections", () => {
  test("double click on empty bubble space replies", async () => {
    const onReply = vi.fn();
    render(<MessageItem {...BASE_PROPS} onReply={onReply} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    fire(bubbleEl(), "dblclick");
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  test("double click that selected a word does not reply", async () => {
    const onReply = vi.fn();
    render(<MessageItem {...BASE_PROPS} onReply={onReply} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    selectText(bubbleEl().querySelector(".sb-markdown").firstChild, 0, 5);
    fire(bubbleEl(), "dblclick");
    expect(onReply).not.toHaveBeenCalled();
  });

  test("a double click on the time does not select hidden text around it", async () => {
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} />);
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    const box = bubbleEl().querySelector("[data-message-meta]").getBoundingClientRect();
    const press = (init) =>
      fire(bubbleEl().querySelector(".sb-markdown"), "mousedown", { button: 0, ...init });
    const onTime = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    expect(press({ ...onTime, detail: 2 }).defaultPrevented).toBe(true);
    // a single click, or a double click on the text itself, is left alone
    expect(press({ ...onTime, detail: 1 }).defaultPrevented).toBe(false);
    expect(press({ clientX: box.left - 200, clientY: box.top, detail: 2 }).defaultPrevented).toBe(false);
  });

  const quoted = makeMsg({
    replyTo: { id: 3, body: "the quoted words", displayName: "Alice", username: "alice", color: "#10b981" },
  });

  test("a plain click on the quote still jumps to the message", async () => {
    const onJumpToMessage = vi.fn();
    render(<MessageItem {...BASE_PROPS} onJumpToMessage={onJumpToMessage} msg={quoted} />);
    await expect.element(page.getByRole("button", { name: /reply to alice/i })).toBeInTheDocument();
    const quote = document.querySelector('[role="button"][aria-label^="Reply to"]');
    fire(quote, "mousedown", { button: 0, clientX: 100, clientY: 100 });
    fire(quote, "click", { button: 0, clientX: 101, clientY: 100 });
    expect(onJumpToMessage).toHaveBeenCalledWith(3);
  });

  test("a click that ends a drag selection does not jump", async () => {
    const onJumpToMessage = vi.fn();
    render(<MessageItem {...BASE_PROPS} onJumpToMessage={onJumpToMessage} msg={quoted} />);
    await expect.element(page.getByRole("button", { name: /reply to alice/i })).toBeInTheDocument();
    const quote = document.querySelector('[role="button"][aria-label^="Reply to"]');
    selectText(bubbleEl().querySelector(".sb-markdown").firstChild, 0, 5);
    fire(quote, "mousedown", { button: 0, clientX: 100, clientY: 100 });
    const click = fire(quote, "click", { button: 0, clientX: 180, clientY: 102 });
    expect(onJumpToMessage).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
  });

  test("the quote can be activated from the keyboard", async () => {
    const onJumpToMessage = vi.fn();
    render(<MessageItem {...BASE_PROPS} onJumpToMessage={onJumpToMessage} msg={quoted} />);
    await expect.element(page.getByRole("button", { name: /reply to alice/i })).toBeInTheDocument();
    const quote = document.querySelector('[role="button"][aria-label^="Reply to"]');
    fire(quote, "keydown", { key: "Enter" });
    expect(onJumpToMessage).toHaveBeenCalledWith(3);
  });
});

describe("MessageItem - runs of one sender", () => {
  const group = { ...BASE_PROPS, isGroupChat: true, onOpenSenderProfile: vi.fn() };
  const msg = () => makeMsg({ body: "Hello there" });
  const ready = () => expect.element(page.getByText("Hello there")).toBeInTheDocument();

  test("a message alone in its run shows the name and the avatar", async () => {
    render(<MessageItem {...group} msg={msg()} />);
    await ready();
    expect(avatarCount()).toBe(1);
    expect(bubbleEl().textContent).toContain("Bob");
  });

  test("a middle bubble has neither the name nor the avatar, but keeps the gutter", async () => {
    render(<MessageItem {...group} isRunStart={false} isRunEnd={false} msg={msg()} />);
    await ready();
    expect(avatarCount()).toBe(0);
    expect(bubbleEl().textContent).not.toContain("Bob");
    const gutter = rowEl().querySelector('[aria-hidden="true"].w-8');
    expect(gutter).not.toBeNull();
  });

  test("the first bubble has the name, the last one has the avatar", async () => {
    const first = await render(<MessageItem {...group} isRunStart isRunEnd={false} msg={msg()} />);
    await ready();
    expect(bubbleEl().textContent).toContain("Bob");
    expect(avatarCount()).toBe(0);
    await first.unmount();
    await render(<MessageItem {...group} isRunStart={false} isRunEnd msg={msg()} />);
    await ready();
    expect(bubbleEl().textContent).not.toContain("Bob");
    expect(avatarCount()).toBe(1);
  });

  test("direct chats never show an avatar or a name", async () => {
    render(<MessageItem {...BASE_PROPS} msg={msg()} />);
    await ready();
    expect(avatarCount()).toBe(0);
    expect(bubbleEl().textContent).not.toContain("Bob");
  });

  test("the tail corner is small on the last bubble only", async () => {
    const view = await render(<MessageItem {...BASE_PROPS} isRunEnd={false} msg={msg()} />);
    await ready();
    expect(bubbleEl().className).toContain("rounded-bl-[5px]");
    await view.unmount();
    await render(<MessageItem {...BASE_PROPS} isRunEnd msg={msg()} />);
    await ready();
    expect(bubbleEl().className).toContain("rounded-bl-[4px]");
  });
});

describe("MessageItem - time and status", () => {
  test("a text message keeps the time inline at the end of the bubble", async () => {
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const meta = bubbleEl().querySelector("[data-message-meta]");
    expect(meta.getAttribute("data-message-meta")).toBe("inline");
    expect(meta.textContent).toContain("12:00");
    expect(bubbleEl().style.getPropertyValue("--sb-meta-text")).toBe('"12:00"');
    expect(bubbleEl().querySelector(".sb-markdown").className).toContain("sb-meta-inline");
  });

  test("edited and status are part of the reserved width", async () => {
    render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg({ user_id: ME.id, username: ME.username, nickname: ME.nickname, edited: 1 })}
      />,
    );
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    expect(bubbleEl().style.getPropertyValue("--sb-meta-text")).toBe('"edited 12:00"');
    expect(parseInt(bubbleEl().style.getPropertyValue("--sb-meta-extra"), 10)).toBeGreaterThanOrEqual(18);
  });

  test("a picture without a caption gets the time as a chip over the picture", async () => {
    render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg({
          body: "Sent a photo",
          files: [{ id: "f1", name: "p.png", mimeType: "image/png", url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", width: 4, height: 3 }],
        })}
        messageFilesProps={filesProps("image")}
      />,
    );
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    expect(bubbleEl().querySelector("[data-message-meta]").getAttribute("data-message-meta")).toBe("overlay");
    expect(bubbleEl().querySelector(".sb-markdown")).toBeNull();
  });

  test("a tall picture gets a narrow bubble, a wide one the full media width, an album the full width", async () => {
    const photo = (id, width, height) => ({
      id,
      name: `${id}.png`,
      mimeType: "image/png",
      url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      width,
      height,
    });
    const view = await render(
      <MessageItem {...BASE_PROPS} msg={makeMsg({ body: "Sent a photo", files: [photo("tall", 300, 500)] })} messageFilesProps={filesProps("image")} />,
    );
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    const tall = bubbleEl().getBoundingClientRect();
    expect(tall.width).toBeLessThan(300);
    expect(tall.height).toBeLessThanOrEqual(430);
    await view.unmount();

    const wide = await render(
      <MessageItem {...BASE_PROPS} msg={makeMsg({ body: "Sent a photo", files: [photo("wide", 800, 400)] })} messageFilesProps={filesProps("image")} />,
    );
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    expect(bubbleEl().style.width).toBe("352px");
    await wide.unmount();

    await render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg({ body: "Sent 2 photos", files: [photo("a", 300, 500), photo("b", 300, 500)] })}
        messageFilesProps={filesProps("image")}
      />,
    );
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    expect(bubbleEl().style.width).toBe("352px");
  });

  test("a file without a caption gets the time on its own row", async () => {
    render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg({
          body: "Sent a file",
          files: [{ id: "f2", name: "doc.pdf", mimeType: "application/pdf", url: "/x/doc.pdf", sizeBytes: 1200 }],
        })}
        messageFilesProps={filesProps("document")}
      />,
    );
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    expect(bubbleEl().querySelector("[data-message-meta]").getAttribute("data-message-meta")).toBe("row");
  });

  test("a list ends the text, so the time gets its own row under it", async () => {
    render(<MessageItem {...BASE_PROPS} msg={makeMsg({ body: "- one\n- two" })} />);
    await expect.element(page.getByText("one")).toBeInTheDocument();
    expect(bubbleEl().querySelector(".sb-markdown").className).toContain("sb-meta-block");
  });

  test("Persian text puts the time on the left", async () => {
    render(<MessageItem {...BASE_PROPS} msg={makeMsg({ body: "سلام دوست من" })} />);
    await expect.element(page.getByText("سلام دوست من")).toBeInTheDocument();
    expect(bubbleEl().querySelector("[data-message-meta]").className).toContain("left-2.5");
  });
});

describe("MessageItem - round video container", () => {
  const videoNote = (extra = {}) =>
    makeMsg({ body: "", e2ee: { kind: "video_note" }, files: [{ id: "f1", url: "/x", mimeType: "video/mp4" }], ...extra });

  test("stands on the chat background without a bubble, the time is a chip over its corner", async () => {
    render(<MessageItem {...BASE_PROPS} msg={videoNote()} />);
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    const cls = bubbleEl().className;
    expect(cls).toContain("p-0");
    expect(cls).not.toContain("bg-white");
    expect(cls).not.toContain("shadow-xs");
    expect(bubbleEl().querySelector("[data-message-meta]").getAttribute("data-message-meta")).toBe("overlay");
  });

  test("a quote is a chip above the circle, not a bubble around it", async () => {
    const replyTo = { id: 3, username: "alice", displayName: "Alice", body: "earlier" };
    render(<MessageItem {...BASE_PROPS} msg={videoNote({ replyTo })} />);
    await expect.element(page.getByText("earlier")).toBeInTheDocument();
    expect(bubbleEl().className).toContain("p-0");
    expect(bubbleEl().className).not.toContain("bg-white");
    const header = bubbleEl().querySelector("[data-video-note-header]");
    expect(header).not.toBeNull();
    expect(header.textContent).toContain("earlier");
    // The chip sits above the circle inside the video block, not in a header of the bubble.
    expect(header.closest("[data-video-note]")).not.toBeNull();
  });

  test("the sender name in a group is a chip above the circle", async () => {
    render(<MessageItem {...BASE_PROPS} isGroupChat msg={videoNote()} />);
    await expect.element(page.getByText("Bob")).toBeInTheDocument();
    expect(bubbleEl().className).not.toContain("bg-white");
    expect(bubbleEl().querySelector("[data-video-note-header]").textContent).toContain("Bob");
  });

  test("a message without a header has no chip", async () => {
    render(<MessageItem {...BASE_PROPS} msg={videoNote()} />);
    await expect.element(page.getByText("12:00")).toBeInTheDocument();
    expect(bubbleEl().querySelector("[data-video-note-header]")).toBeNull();
  });
});

describe("MessageItem - room for batch selection and reactions", () => {
  test("has a leading gutter slot and a slot under the bubble", async () => {
    render(<MessageItem {...BASE_PROPS} msg={makeMsg()} />);
    await expect.element(page.getByText("Hello world from Bob")).toBeInTheDocument();
    const leading = rowEl().querySelector('[data-slot="leading"]');
    const reactions = rowEl().querySelector('[data-slot="reactions"]');
    expect(leading).not.toBeNull();
    expect(reactions).not.toBeNull();
    expect(reactions.previousElementSibling).toBe(bubbleEl());
    expect(leading.compareDocumentPosition(bubbleEl()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("renders what it is given in those slots", async () => {
    render(
      <MessageItem
        {...BASE_PROPS}
        msg={makeMsg()}
        leadingSlot={<input type="checkbox" aria-label="Select message" />}
        reactionsSlot={<span>reaction chips</span>}
      />,
    );
    await expect.element(page.getByRole("checkbox", { name: "Select message" })).toBeInTheDocument();
    await expect.element(page.getByText("reaction chips")).toBeInTheDocument();
  });
});

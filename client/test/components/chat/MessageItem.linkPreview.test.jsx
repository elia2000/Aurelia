import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { MessageItem } from "../../../src/components/chat/messages/MessageItem.jsx";
import { resetLinkPreviewStore } from "../../../src/utils/linkPreviewStore.js";
import { setLinkPreviewChoice, setLinkPreviewsServerEnabled } from "../../../src/utils/linkPreviewPrefs.js";

const ME = { id: 1, username: "alice", nickname: "Alice", color: "#10b981" };
const BOB = { id: 2, username: "bob", nickname: "Bob", color: "#3b82f6" };
const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const makeMsg = (overrides = {}) => ({
  id: 1,
  user_id: BOB.id,
  username: BOB.username,
  nickname: BOB.nickname,
  color: BOB.color,
  avatar_url: null,
  body: "look https://example.com/post",
  created_at: "2024-01-01T12:00:00.000Z",
  read_at: null,
  edited: 0,
  files: [],
  replyTo: null,
  ...overrides,
});

const PROPS = {
  user: ME,
  formatTime: () => "12:00",
  unreadMarkerId: null,
  messageFilesProps: {},
  getMessageDayLabel: null,
  isDesktop: true,
  isMobileTouchDevice: false,
};

const PREVIEW = {
  url: "https://example.com/post",
  title: "A very important headline",
  description: "About the article.",
  siteName: "Example News",
  image: null,
};

let fetchMock;
beforeEach(() => {
  resetLinkPreviewStore();
  setLinkPreviewsServerEnabled(true);
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => PREVIEW }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLinkPreviewChoice(null);
  setLinkPreviewsServerEnabled(false);
  resetLinkPreviewStore();
});

const card = () => document.querySelector("[data-link-preview]");
const previewCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/link-preview"));

describe("MessageItem - link preview card", () => {
  test("a card appears under the text of a message with a link", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    expect(previewCalls()).toHaveLength(1);
    const [url, options] = previewCalls()[0];
    expect(url).toBe("/api/link-preview");
    expect(JSON.parse(options.body)).toEqual({ url: "https://example.com/post" });

    const bubble = document.querySelector("[data-message-bubble]");
    const text = bubble.querySelector(".sb-markdown");
    expect(card()).not.toBeNull();
    // After the text, inside the same bubble.
    expect(bubble.contains(card())).toBe(true);
    expect(text.compareDocumentPosition(card()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The link in the text is untouched and the card opens the same address.
    expect(text.querySelector("a").getAttribute("href")).toBe("https://example.com/post");
    expect(card().getAttribute("href")).toBe("https://example.com/post");
    expect(card().getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("the time moves to its own row under the card", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    expect(document.querySelector("[data-message-meta]").getAttribute("data-message-meta")).toBe("inline");
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    expect(document.querySelector("[data-message-meta]").getAttribute("data-message-meta")).toBe("row");
    expect(document.querySelector(".sb-markdown").className).not.toMatch(/sb-meta-/);
    const bubble = document.querySelector("[data-message-bubble]");
    expect(card().compareDocumentPosition(document.querySelector("[data-message-meta]")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bubble).not.toBeNull();
  });

  test("works for my own messages too", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg({ user_id: ME.id, username: ME.username, nickname: ME.nickname })} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
  });

  test("the card is not part of the text that is selected or copied", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    expect(card().hasAttribute("data-no-select")).toBe(true);
    expect(document.querySelector(".sb-markdown").contains(card())).toBe(false);
  });

  test("a message without a link asks for nothing", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg({ body: "just words" })} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(previewCalls()).toHaveLength(0);
    expect(card()).toBeNull();
  });

  test("an address inside code is not a link, so nothing is asked for", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg({ body: "run `curl https://example.com/post` now" })} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(previewCalls()).toHaveLength(0);
    expect(card()).toBeNull();
  });

  test("a message shown as plain text (it has HTML-like tags) has no links, so no card", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg({ body: "<b>https://example.com/post</b>" })} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(previewCalls()).toHaveLength(0);
  });

  test("a link into this very app is not previewed", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg({ body: `${window.location.origin}/invite/abc123` })} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(previewCalls()).toHaveLength(0);
  });

  test("only the first link of a message gets a card", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg({ body: "https://example.com/post and https://other.example.org/x" })} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    expect(previewCalls()).toHaveLength(1);
    expect(document.querySelectorAll("[data-link-preview]")).toHaveLength(1);
  });

  test("a link edited away takes its card with it", async () => {
    const view = await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    await view.rerender(<MessageItem {...PROPS} msg={makeMsg({ body: "no link now", edited: 1 })} />);
    await expect.poll(() => card()).toBeNull();
    expect(document.querySelector("[data-message-meta]").getAttribute("data-message-meta")).toBe("inline");
  });

  test("a link added by an edit gets a card", async () => {
    const view = await render(<MessageItem {...PROPS} msg={makeMsg({ body: "no link" })} />);
    expect(card()).toBeNull();
    await view.rerender(<MessageItem {...PROPS} msg={makeMsg({ body: "now https://example.com/post", edited: 1 })} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
  });

  test("the same link in a second message is answered from memory", async () => {
    await render(
      <>
        <MessageItem {...PROPS} msg={makeMsg({ id: 1 })} />
        <MessageItem {...PROPS} msg={makeMsg({ id: 2, body: "again https://example.com/post" })} />
      </>,
    );
    await expect.poll(() => document.querySelectorAll("[data-link-preview]").length).toBe(2);
    expect(previewCalls()).toHaveLength(1);
  });

  test("a reply quote does not get a card (only the message itself)", async () => {
    const quoted = makeMsg({ id: 7, body: "quoted https://example.com/quoted" });
    await render(
      <MessageItem
        {...PROPS}
        msg={makeMsg({
          id: 8,
          body: "my answer without a link",
          replyTo: { id: quoted.id, body: quoted.body, username: BOB.username, nickname: BOB.nickname, color: BOB.color },
        })}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(previewCalls()).toHaveLength(0);
    expect(card()).toBeNull();
  });
});

describe("MessageItem - when there is no card", () => {
  test("link previews are off on the server", async () => {
    setLinkPreviewsServerEnabled(false);
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(previewCalls()).toHaveLength(0);
    expect(card()).toBeNull();
    expect(document.querySelector("[data-message-meta]").getAttribute("data-message-meta")).toBe("inline");
  });

  test("the person turned them off", async () => {
    setLinkPreviewChoice(false);
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(previewCalls()).toHaveLength(0);
    expect(card()).toBeNull();
  });

  test("turning them off removes the cards that are showing, and on brings them back", async () => {
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    setLinkPreviewChoice(false);
    await expect.poll(() => card()).toBeNull();
    setLinkPreviewChoice(true);
    await expect.poll(() => card()).not.toBeNull();
    expect(previewCalls()).toHaveLength(1); // the second time came from memory
  });

  test("the server says no: the message looks as it always did", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ code: "link_previews_disabled" }),
    }));
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await expect.poll(() => previewCalls().length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(card()).toBeNull();
    await expect.element(page.getByText(/look/)).toBeVisible();
  });

  test("the site could not be fetched (422): nothing shown", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 422, json: async () => ({ code: "preview_unavailable" }) }));
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await expect.poll(() => previewCalls().length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(card()).toBeNull();
  });

  test("a network error: nothing shown", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await expect.poll(() => previewCalls().length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(card()).toBeNull();
  });

  test.each([
    ["an encrypted message", { body: "sb-enc-v1:AAAA https://example.com/post" }],
    ["a message with an end-to-end envelope", { e2ee: { kind: "text", sig: "x" } }],
    ["a message still being sent", { _delivery: "sending" }],
    ["a message that failed to send", { _delivery: "failed" }],
    ["a call history entry", { messageType: "call", body: "[[call]] https://example.com/post" }],
    ["a line the chat added", { _systemEvent: { type: "joined", name: "Bob", suffix: "joined" } }],
  ])("%s", async (_name, overrides) => {
    await render(<MessageItem {...PROPS} msg={makeMsg(overrides)} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(previewCalls()).toHaveLength(0);
    expect(card()).toBeNull();
  });
});

describe("MessageItem - lazy loading", () => {
  test("nothing is asked for until the message is near the screen", async () => {
    await render(
      <div>
        <div style={{ height: "6000px" }} />
        <MessageItem {...PROPS} msg={makeMsg()} />
      </div>,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(previewCalls()).toHaveLength(0);
    expect(card()).toBeNull();

    document.querySelector("[data-message-bubble]").scrollIntoView();
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    expect(previewCalls()).toHaveLength(1);
  });
});

describe("MessageItem - a card that arrives late, in a chat that is scrolled to the bottom", () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const distanceFromBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight;
  let styleTag;

  beforeEach(() => {
    // Tailwind is not applied in these tests: give the card the size it has in the app.
    styleTag = document.createElement("style");
    // The time moves to its own row under the card (MessageItem's "row" meta): one more line of height.
    styleTag.textContent =
      "[data-link-preview]{display:flex;width:288px;margin-top:6px;min-height:60px}" +
      "[data-message-bubble]:has([data-link-preview])::after{content:'';display:block;height:18px}";
    document.head.append(styleTag);
  });
  afterEach(() => styleTag.remove());

  // The server needs a moment for a link it has not seen: answer after `ms`.
  const slowAnswer = (ms) =>
    fetchMock.mockImplementation(async () => {
      await wait(ms);
      return { ok: true, status: 200, json: async () => PREVIEW };
    });

  const renderInScroller = async (fillerHeight) => {
    await render(
      <div
        data-test-scroller
        style={{ overflowY: "auto", overflowAnchor: "none", height: "300px", width: "420px" }}
      >
        <div style={{ height: `${fillerHeight}px` }} />
        <MessageItem {...PROPS} msg={makeMsg()} />
      </div>,
    );
    return document.querySelector("[data-test-scroller]");
  };

  test("the chat stays at the bottom, so the new card is not pushed out of view", async () => {
    slowAnswer(250); // well after the message itself was put in place
    const scroller = await renderInScroller(500);
    scroller.scrollTop = scroller.scrollHeight;
    expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1);

    await expect.element(page.getByText("A very important headline")).toBeVisible();
    expect(card()).not.toBeNull();
    await wait(100);
    expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1);
    // The whole card is inside what the person sees.
    expect(card().getBoundingClientRect().bottom).toBeLessThanOrEqual(scroller.getBoundingClientRect().bottom + 1);
  });

  test("and so does the sender's own message", async () => {
    slowAnswer(250);
    await render(
      <div data-test-scroller style={{ overflowY: "auto", overflowAnchor: "none", height: "300px", width: "420px" }}>
        <div style={{ height: "500px" }} />
        <MessageItem {...PROPS} msg={makeMsg({ user_id: ME.id, username: ME.username, nickname: ME.nickname })} />
      </div>,
    );
    const scroller = document.querySelector("[data-test-scroller]");
    scroller.scrollTop = scroller.scrollHeight;
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    await wait(100);
    expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1);
  });

  test("someone who scrolled up to read is left where they are", async () => {
    slowAnswer(150);
    const scroller = await renderInScroller(300);
    scroller.scrollTop = 20; // not at the bottom
    const before = scroller.scrollTop;
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    await wait(100);
    expect(scroller.scrollTop).toBe(before);
  });
});

describe("MessageItem - the keyboard focus ring of the card", () => {
  // Tailwind is not applied in these tests, so the class is what is checked: the 400 shade it used to be
  // measures 1.7:1 on an own bubble and 2.3:1 on another person's in light mode; 700 (300 in dark mode)
  // is guarded by the "ring-on-bubble" pairs of themeContrast.js (>= 3:1 for every accent).
  test.each([
    ["another person's", ME.id, BOB.id],
    ["my own", ME.id, ME.id],
  ])("on %s bubble it is the dark shade, and the light one in dark mode", async (_name, _me, sender) => {
    await render(<MessageItem {...PROPS} msg={makeMsg({ user_id: sender })} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    const classes = card().className;
    expect(classes).toContain("focus-visible:outline-emerald-700");
    expect(classes).toContain("dark:focus-visible:outline-emerald-300");
    expect(classes).not.toContain("outline-emerald-400");
  });
});

describe("MessageItem - the picture", () => {
  test("is drawn from the address the server gave (its own), never from the linked site", async () => {
    const image = "/api/link-preview/image/0123456789abcdef0123456789abcdef";
    fetchMock.mockImplementation(async (url) =>
      String(url).startsWith("/api/link-preview/image/")
        ? { ok: true, status: 200 }
        : {
            ok: true,
            status: 200,
            json: async () => ({ ...PREVIEW, image: { url: image, width: 100, height: 100 } }),
          },
    );
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    expect(card().querySelector("img").getAttribute("src")).toBe(image);
  });

  test("an address of another site in the answer is never used", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...PREVIEW, image: { url: "https://tracker.example.net/pixel.png", width: 1, height: 1 } }),
    }));
    await render(<MessageItem {...PROPS} msg={makeMsg()} />);
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    expect(card().querySelector("img")).toBeNull();
    expect(document.querySelector(`img[src*="tracker.example.net"]`)).toBeNull();
    expect(PIXEL).toBeTruthy();
  });
});

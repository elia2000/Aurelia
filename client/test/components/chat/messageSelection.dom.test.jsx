import { describe, test, expect, afterEach } from "vitest";
import {
  getSelectedTextWithin,
  hasActiveTextSelection,
} from "../../../src/utils/messageSelection.js";

const mounted = [];
const mount = (html) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  mounted.push(host);
  return host;
};

const selectBetween = (startNode, startOffset, endNode, endOffset) => {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};

const bubbleHtml = (id, text, time = "12:31") =>
  `<div data-message-bubble id="${id}"><div class="sb-markdown">${text}</div>` +
  `<span data-message-meta="inline" data-no-select><span>${time}</span>` +
  `<span class="sr-only">Sent</span></span></div>`;

afterEach(() => {
  window.getSelection().removeAllRanges();
  mounted.splice(0).forEach((host) => host.remove());
});

describe("getSelectedTextWithin", () => {
  test("is empty when nothing is selected", () => {
    const host = mount(bubbleHtml("a", "hello world"));
    expect(getSelectedTextWithin(host.querySelector("#a"))).toBe("");
    expect(hasActiveTextSelection()).toBe(false);
  });

  test("returns the selected part of a message", () => {
    const host = mount(bubbleHtml("a", "hello brave new world"));
    const text = host.querySelector(".sb-markdown").firstChild;
    selectBetween(text, 6, text, 11);
    expect(getSelectedTextWithin(host.querySelector("#a"))).toBe("brave");
    expect(hasActiveTextSelection()).toBe(true);
  });

  test("leaves the time, status and buttons out of the copied text", () => {
    const host = mount(
      bubbleHtml("a", "first message") +
        bubbleHtml("b", "second message", "12:32") +
        `<div data-message-bubble id="c"><div class="sb-markdown">third</div><button>Open</button></div>`,
    );
    const first = host.querySelector("#a .sb-markdown").firstChild;
    const third = host.querySelector("#c .sb-markdown").firstChild;
    selectBetween(first, 0, third, 5);
    const text = getSelectedTextWithin(host.querySelector("#b"));
    expect(text).toContain("first message");
    expect(text).toContain("second message");
    expect(text).toContain("third");
    expect(text).not.toMatch(/12:3\d/);
    expect(text).not.toContain("Sent");
    expect(text).not.toContain("Open");
  });

  test("puts each message on its own line", () => {
    const host = mount(bubbleHtml("a", "one") + bubbleHtml("b", "two"));
    const one = host.querySelector("#a .sb-markdown").firstChild;
    const two = host.querySelector("#b .sb-markdown").firstChild;
    selectBetween(one, 0, two, 3);
    expect(getSelectedTextWithin(host.querySelector("#a"))).toBe("one\ntwo");
  });

  test("a selection spanning several messages belongs to each of them", () => {
    const host = mount(
      bubbleHtml("a", "alpha") + bubbleHtml("b", "bravo") + bubbleHtml("c", "charlie"),
    );
    const alpha = host.querySelector("#a .sb-markdown").firstChild;
    const charlie = host.querySelector("#c .sb-markdown").firstChild;
    selectBetween(alpha, 0, charlie, 7);
    for (const id of ["a", "b", "c"]) {
      expect(getSelectedTextWithin(host.querySelector(`#${id}`))).toContain("bravo");
    }
  });

  test("a selection in another message does not count", () => {
    const host = mount(bubbleHtml("a", "alpha") + bubbleHtml("b", "bravo"));
    const alpha = host.querySelector("#a .sb-markdown").firstChild;
    selectBetween(alpha, 0, alpha, 5);
    expect(getSelectedTextWithin(host.querySelector("#a"))).toBe("alpha");
    expect(getSelectedTextWithin(host.querySelector("#b"))).toBe("");
  });

  test("keeps emoji pictures as characters", () => {
    const host = mount(
      bubbleHtml("a", 'hi <img alt="😀" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" /> there'),
    );
    const body = host.querySelector("#a .sb-markdown");
    selectBetween(body, 0, body, body.childNodes.length);
    expect(getSelectedTextWithin(host.querySelector("#a"))).toBe("hi 😀 there");
  });

  test("leaves no helper element behind", () => {
    const host = mount(bubbleHtml("a", "hello"));
    const text = host.querySelector("#a .sb-markdown").firstChild;
    selectBetween(text, 0, text, 5);
    getSelectedTextWithin(host.querySelector("#a"));
    expect(document.querySelectorAll('div[aria-hidden="true"]').length).toBe(0);
  });
});

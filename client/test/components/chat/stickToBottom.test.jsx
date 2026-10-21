import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({ reactToMessage: vi.fn(), listMessageReactors: vi.fn() }));
vi.mock("../../../src/api/reactionsApi.js", () => api);

import ReactionChips from "../../../src/components/chat/reactions/ReactionChips.jsx";
import { findScrollParent, keepAtBottomAfterGrowth } from "../../../src/utils/stickToBottom.js";
import {
  applyRealtimeReaction,
  resetReactionStore,
} from "../../../src/utils/reactionStore.js";

const CHAT = "44444444-4444-4444-a444-444444444444";
const MSG = "33333333-3333-4333-a333-333333333331";
const UP = "\u{1F44D}";
const FIRE = "\u{1F525}";

const flush = () => new Promise((resolve) => setTimeout(resolve, 60));
const atBottom = (el) => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) <= 1;

beforeEach(() => {
  resetReactionStore();
  api.reactToMessage.mockReset();
});

const scroller = ({ above = 600 } = {}) => {
  const el = document.createElement("div");
  el.style.cssText = "overflow-y:auto;height:200px;width:300px;";
  const filler = document.createElement("div");
  filler.style.height = `${above}px`;
  el.append(filler);
  document.body.append(el);
  return { el, filler };
};

describe("findScrollParent", () => {
  test("finds the nearest ancestor that scrolls vertically", () => {
    const { el } = scroller();
    const inner = document.createElement("div");
    const leaf = document.createElement("span");
    inner.append(leaf);
    el.append(inner);
    expect(findScrollParent(leaf)).toBe(el);
    el.remove();
  });

  test("none when nothing scrolls", () => {
    const leaf = document.createElement("span");
    document.body.append(leaf);
    expect(findScrollParent(leaf)).toBeNull();
    leaf.remove();
  });
});

describe("keepAtBottomAfterGrowth", () => {
  test("goes back to the bottom when it was at the bottom before the growth", () => {
    const { el } = scroller();
    el.scrollTop = el.scrollHeight;
    const row = document.createElement("div");
    row.style.height = "26px";
    el.append(row);
    expect(atBottom(el)).toBe(false);
    expect(keepAtBottomAfterGrowth(row, 26)).toBe(true);
    expect(atBottom(el)).toBe(true);
    el.remove();
  });

  test("leaves a chat alone that was scrolled up", () => {
    const { el } = scroller();
    el.scrollTop = 100;
    const row = document.createElement("div");
    row.style.height = "26px";
    el.append(row);
    expect(keepAtBottomAfterGrowth(row, 26)).toBe(false);
    expect(el.scrollTop).toBe(100);
    el.remove();
  });

  test("nothing to do without growth or without a scroller", () => {
    const row = document.createElement("div");
    document.body.append(row);
    expect(keepAtBottomAfterGrowth(row, 26)).toBe(false);
    const { el } = scroller();
    el.append(row);
    expect(keepAtBottomAfterGrowth(row, 0)).toBe(false);
    el.remove();
  });
});

describe("chips under the last message", () => {
  test("a chat at the bottom stays at the bottom when the first chip appears under its last message", async () => {
    const { el } = scroller();
    const host = document.createElement("div");
    el.append(host);
    await render(<ReactionChips chatId={CHAT} messageId={MSG} />, { container: host });
    el.scrollTop = el.scrollHeight;
    expect(atBottom(el)).toBe(true);

    applyRealtimeReaction({ messageId: MSG, counts: [{ emoji: UP, count: 1 }], actorId: null }, null);
    await flush();
    expect(host.querySelector("[data-reaction-chip]")).not.toBeNull();
    expect(atBottom(el)).toBe(true);
    el.remove();
  });

  test("a chat that was scrolled up is not pulled down", async () => {
    const { el } = scroller();
    const host = document.createElement("div");
    el.append(host);
    await render(<ReactionChips chatId={CHAT} messageId={MSG} />, { container: host });
    el.scrollTop = 120;

    applyRealtimeReaction({ messageId: MSG, counts: [{ emoji: FIRE, count: 1 }], actorId: null }, null);
    await flush();
    expect(host.querySelector("[data-reaction-chip]")).not.toBeNull();
    expect(el.scrollTop).toBe(120);
    el.remove();
  });
});

import { useState } from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook } from "vitest-browser-react";

vi.mock("../../../src/api/pinsApi.js", () => ({
  setChatPinned: vi.fn(),
  reorderPinnedChats: vi.fn(),
}));
vi.mock("../../../src/utils/toast.js", () => ({ showToast: vi.fn() }));

import { reorderPinnedChats, setChatPinned } from "../../../src/api/pinsApi.js";
import { useChatPins } from "../../../src/hooks/chat/useChatPins.js";
import { getPinnedChatIds } from "../../../src/utils/chatPins.js";
import { setPinLimits } from "../../../src/utils/pinLimits.js";
import { showToast } from "../../../src/utils/toast.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const chat = (n, extra = {}) => ({ id: id(n), name: `chat ${n}`, ...extra });
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const list = (...ns) => ns.map((n, position) => ({ chatId: id(n), position }));

const harness = (initial, extra = {}) =>
  renderHook(() => {
    const [chats, setChats] = useState(initial);
    const pins = useChatPins({ chats, setChats, ...extra });
    return { chats, ...pins };
  });

const order = (hook) => getPinnedChatIds(hook.result.current.chats);
// React draws the state a moment after a promise settles: wait for it.
const expectOrder = (hook, ids) => vi.waitFor(() => expect(order(hook)).toEqual(ids));

beforeEach(() => {
  vi.mocked(setChatPinned).mockReset();
  vi.mocked(reorderPinnedChats).mockReset();
  vi.mocked(showToast).mockReset();
  setPinLimits({ messages: 20, chats: 5 });
});

describe("useChatPins - pin and unpin", () => {
  test("pinning shows at once, at the top, and takes the server's list", async () => {
    let release;
    vi.mocked(setChatPinned).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(reply(200, { pins: list(3, 1) })); }),
    );
    const hook = await harness([chat(1, { pinned: true, pinPosition: 0 }), chat(2), chat(3)]);
    const pending = hook.result.current.setPinned(id(3), true);
    await vi.waitFor(() => expect(order(hook)).toEqual([id(3), id(1)]));
    release();
    await pending;
    expect(setChatPinned).toHaveBeenCalledWith(id(3), true);
    await expectOrder(hook, [id(3), id(1)]);
    expect(hook.result.current.pinnedChatIds).toEqual([id(3), id(1)]);
  });

  test("unpinning removes it at once", async () => {
    vi.mocked(setChatPinned).mockResolvedValue(reply(200, { pins: list(1) }));
    const hook = await harness([
      chat(1, { pinned: true, pinPosition: 0 }),
      chat(2, { pinned: true, pinPosition: 1 }),
    ]);
    await hook.result.current.setPinned(id(2), false);
    expect(setChatPinned).toHaveBeenCalledWith(id(2), false);
    await expectOrder(hook, [id(1)]);
    expect(hook.result.current.chats[1]).toMatchObject({ pinned: false, pinPosition: null });
  });

  test("the limit: the chat is not pinned and the notice names the number", async () => {
    vi.mocked(setChatPinned).mockResolvedValue(reply(409, { code: "pin_limit", max: 3, error: "x" }));
    const hook = await harness([chat(1, { pinned: true, pinPosition: 0 }), chat(2)]);
    await hook.result.current.setPinned(id(2), true);
    await expectOrder(hook, [id(1)]);
    expect(showToast).toHaveBeenCalledWith("You can pin up to 3 chats");
  });

  test("a hidden chat cannot be pinned (409 chat_hidden)", async () => {
    vi.mocked(setChatPinned).mockResolvedValue(reply(409, { code: "chat_hidden", error: "x" }));
    const hook = await harness([chat(1)]);
    await hook.result.current.setPinned(id(1), true);
    await expectOrder(hook, []);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/hidden/i));
  });

  test("a lost connection puts everything back", async () => {
    vi.mocked(setChatPinned).mockRejectedValue(new TypeError("offline"));
    const hook = await harness([chat(1, { pinned: true, pinPosition: 0 }), chat(2)]);
    await hook.result.current.setPinned(id(2), true);
    await expectOrder(hook, [id(1)]);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/connection/i));
  });

  test("pinning what is already pinned (or unpinning what is not) asks nothing", async () => {
    const hook = await harness([chat(1, { pinned: true, pinPosition: 0 }), chat(2)]);
    await hook.result.current.setPinned(id(1), true);
    await hook.result.current.setPinned(id(2), false);
    await hook.result.current.setPinned("nope", true);
    expect(setChatPinned).not.toHaveBeenCalled();
  });

  test("offline: says so and changes nothing", async () => {
    const hook = await harness([chat(1)], { isOffline: true });
    await hook.result.current.setPinned(id(1), true);
    expect(setChatPinned).not.toHaveBeenCalled();
    await expectOrder(hook, []);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/offline/i));
  });
});

describe("useChatPins - order", () => {
  const three = () => [
    chat(1, { pinned: true, pinPosition: 0 }),
    chat(2, { pinned: true, pinPosition: 1 }),
    chat(3, { pinned: true, pinPosition: 2 }),
  ];

  test("reorder shows the new order at once and sends ALL the ids", async () => {
    vi.mocked(reorderPinnedChats).mockResolvedValue(reply(200, { pins: list(3, 1, 2) }));
    const hook = await harness(three());
    await hook.result.current.reorder([id(3), id(1), id(2)]);
    expect(reorderPinnedChats).toHaveBeenCalledWith([id(3), id(1), id(2)]);
    await expectOrder(hook, [id(3), id(1), id(2)]);
  });

  test("the same order, or a list that is not the whole pinned set, sends nothing", async () => {
    const hook = await harness(three());
    await hook.result.current.reorder([id(1), id(2), id(3)]);
    await hook.result.current.reorder([id(2), id(1)]);
    expect(reorderPinnedChats).not.toHaveBeenCalled();
  });

  test("a refused reorder puts the old order back", async () => {
    vi.mocked(reorderPinnedChats).mockResolvedValue(reply(500, { error: "boom" }));
    const hook = await harness(three());
    await hook.result.current.reorder([id(3), id(2), id(1)]);
    await expectOrder(hook, [id(1), id(2), id(3)]);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/couldn't update/i));
  });

  test("pin_set_mismatch (another device changed the set): the real list replaces ours", async () => {
    vi.mocked(reorderPinnedChats).mockResolvedValue(
      reply(409, { code: "pin_set_mismatch", error: "x", pins: list(2, 1) }),
    );
    const hook = await harness(three());
    await hook.result.current.reorder([id(3), id(2), id(1)]);
    await expectOrder(hook, [id(2), id(1)]);
    expect(hook.result.current.chats[2]).toMatchObject({ pinned: false });
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/another device/i));
  });

  test("move goes one place up or down, and stops at the ends", async () => {
    vi.mocked(reorderPinnedChats).mockImplementation(async (ids) => reply(200, { pins: ids.map((chatId, position) => ({ chatId, position })) }));
    const hook = await harness(three());
    await hook.result.current.move(id(2), -1);
    await expectOrder(hook, [id(2), id(1), id(3)]);
    await hook.result.current.move(id(2), -1); // already first
    await hook.result.current.move(id(3), 1); // already last
    expect(reorderPinnedChats).toHaveBeenCalledTimes(1);
    await hook.result.current.move(id(1), 1);
    await expectOrder(hook, [id(2), id(3), id(1)]);
  });

  test("quick moves run one after the other, each from the list as it is then", async () => {
    const releases = [];
    vi.mocked(reorderPinnedChats).mockImplementation(
      (ids) => new Promise((resolve) => releases.push(() => resolve(reply(200, { pins: ids.map((chatId, position) => ({ chatId, position })) })))),
    );
    const hook = await harness(three());
    const first = hook.result.current.move(id(3), -1); // 1,3,2
    const second = hook.result.current.move(id(3), -1); // 3,1,2
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(reorderPinnedChats).toHaveBeenCalledTimes(1); // the second waits for the first
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]();
    await Promise.all([first, second]);
    expect(reorderPinnedChats.mock.calls.map(([ids]) => ids)).toEqual([
      [id(1), id(3), id(2)],
      [id(3), id(1), id(2)],
    ]);
    await expectOrder(hook, [id(3), id(1), id(2)]);
  });
});

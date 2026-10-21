import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import PinnedMessageBar from "../../../src/components/chat/pins/PinnedMessageBar.jsx";
import { normalizePinList } from "../../../src/utils/messagePins.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const raw = (n, message = {}) => ({
  messageId: id(n),
  pinnedBy: id(900),
  pinnedAt: `2026-03-0${n}T10:00:00.000Z`,
  message: {
    id: id(n),
    senderId: id(900),
    senderName: "Ada",
    type: "text",
    text: `message ${n}`,
    hasFile: false,
    fileKind: null,
    ...message,
  },
});

const pinsOf = (...numbers) => normalizePinList(numbers.map((n) => raw(n)));

const bar = () => document.querySelector("[data-pinned-bar]");
const segments = () => [...document.querySelectorAll("[data-pinned-segments] > span")];

describe("PinnedMessageBar", () => {
  test("draws nothing when there are no pins", async () => {
    await render(<PinnedMessageBar pins={[]} onJump={vi.fn()} />);
    expect(bar()).toBeNull();
  });

  test("one pin: the title has no number, the line shows the sender and the text", async () => {
    await render(<PinnedMessageBar pins={pinsOf(1)} onJump={vi.fn()} />);
    await expect.element(page.getByText("Pinned message", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Ada:")).toBeVisible();
    await expect.element(page.getByText("message 1")).toBeVisible();
    // one solid accent line, not a row of segments
    expect(document.querySelector("[data-pinned-segments]")).toBeNull();
    expect(bar().getAttribute("role")).toBe("region");
  });

  test("keyboard focus on the bar and on the unpin button shows a ring, not only a tint", async () => {
    await render(<PinnedMessageBar pins={pinsOf(1)} canManage onUnpin={vi.fn()} onJump={vi.fn()} />);
    const main = page.getByRole("button", { name: /Go to the message/ }).element();
    const unpin = page.getByRole("button", { name: "Unpin message" }).element();
    expect(main.className).toContain("focus-visible:ring-2");
    expect(unpin.className).toContain("focus-visible:ring-2");
  });

  test("a click goes to the shown message", async () => {
    const onJump = vi.fn();
    await render(<PinnedMessageBar pins={pinsOf(1)} onJump={onJump} />);
    await page.getByRole("button", { name: /Go to the message/ }).click();
    expect(onJump).toHaveBeenCalledWith(id(1));
  });

  test("several pins: the newest shows first with its number and one segment per pin", async () => {
    await render(<PinnedMessageBar pins={pinsOf(1, 2, 3)} onJump={vi.fn()} />);
    await expect.element(page.getByText("Pinned message #3")).toBeVisible();
    await expect.element(page.getByText("message 3")).toBeVisible();
    expect(segments()).toHaveLength(3);
    // the oldest pin is on top, so the newest is the bottom segment
    expect(segments().map((s) => s.dataset.active === "true")).toEqual([false, false, true]);
  });

  test("each click goes to the shown pin and then shows the next older one, then wraps", async () => {
    const onJump = vi.fn();
    await render(<PinnedMessageBar pins={pinsOf(1, 2, 3)} onJump={onJump} />);
    const click = () => page.getByRole("button", { name: /Go to the message/ }).click();

    await click();
    expect(onJump).toHaveBeenLastCalledWith(id(3));
    await expect.element(page.getByText("Pinned message #2")).toBeVisible();
    expect(segments().map((s) => s.dataset.active === "true")).toEqual([false, true, false]);

    await click();
    expect(onJump).toHaveBeenLastCalledWith(id(2));
    await expect.element(page.getByText("Pinned message #1")).toBeVisible();

    await click();
    expect(onJump).toHaveBeenLastCalledWith(id(1));
    await expect.element(page.getByText("Pinned message #3")).toBeVisible();
  });

  test("a pin that arrives brings the bar to it", async () => {
    const view = await render(<PinnedMessageBar pins={pinsOf(1, 2)} onJump={vi.fn()} />);
    await page.getByRole("button", { name: /Go to the message/ }).click(); // now showing #1
    await expect.element(page.getByText("Pinned message #1")).toBeVisible();
    await view.rerender(<PinnedMessageBar pins={pinsOf(1, 2, 3)} onJump={vi.fn()} />);
    await expect.element(page.getByText("Pinned message #3")).toBeVisible();
  });

  test("the bar stays on its message when another pin goes away", async () => {
    const view = await render(<PinnedMessageBar pins={pinsOf(1, 2, 3)} onJump={vi.fn()} />);
    await page.getByRole("button", { name: /Go to the message/ }).click(); // now showing message 2
    await view.rerender(<PinnedMessageBar pins={pinsOf(1, 2)} onJump={vi.fn()} />);
    await expect.element(page.getByText("message 2")).toBeVisible();
  });

  test("the last pin going away hides the bar", async () => {
    const view = await render(<PinnedMessageBar pins={pinsOf(1)} onJump={vi.fn()} />);
    await view.rerender(<PinnedMessageBar pins={[]} onJump={vi.fn()} />);
    expect(bar()).toBeNull();
  });

  test("a pin without text names its kind of file", async () => {
    const pins = normalizePinList([raw(1, { fileKind: "image", hasFile: true, text: "" })]);
    await render(<PinnedMessageBar pins={pins} onJump={vi.fn()} />);
    await expect.element(page.getByText("Photo")).toBeVisible();
  });

  test("Persian text is drawn in the Persian font and keeps its direction", async () => {
    const pins = normalizePinList([raw(1, { text: "سلام دنیا", senderName: "علی" })]);
    await render(<PinnedMessageBar pins={pins} onJump={vi.fn()} />);
    const line = document.querySelector('[data-pinned-bar] span[dir="auto"]');
    expect(line.textContent).toContain("سلام دنیا");
    expect(line.className).toContain("font-fa");
  });

  describe("where the person may unpin", () => {
    test("no close button for someone who may not", async () => {
      await render(<PinnedMessageBar pins={pinsOf(1)} onJump={vi.fn()} />);
      expect(document.querySelector('button[aria-label="Unpin message"]')).toBeNull();
    });

    test("one pin: the close button unpins it at once", async () => {
      const onUnpin = vi.fn();
      await render(<PinnedMessageBar pins={pinsOf(1)} canManage onJump={vi.fn()} onUnpin={onUnpin} />);
      await page.getByRole("button", { name: "Unpin message" }).click();
      expect(onUnpin).toHaveBeenCalledWith(id(1));
    });

    test("several pins: the close button opens the menu with the shown pin and the count", async () => {
      const onUnpin = vi.fn();
      const onUnpinAll = vi.fn();
      const onOpenContextMenu = vi.fn();
      await render(
        <PinnedMessageBar
          pins={pinsOf(1, 2, 3)}
          canManage
          onJump={vi.fn()}
          onUnpin={onUnpin}
          onUnpinAll={onUnpinAll}
          onOpenContextMenu={onOpenContextMenu}
        />,
      );
      await page.getByRole("button", { name: "Unpin options" }).click();
      expect(onUnpin).not.toHaveBeenCalled();
      expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
      const request = onOpenContextMenu.mock.calls[0][0];
      expect(request.kind).toBe("pinbar");
      expect(request.data).toMatchObject({ count: 3, canManage: true });
      expect(request.data.pin.messageId).toBe(id(3));
      request.data.onUnpin();
      expect(onUnpin).toHaveBeenCalledWith(id(3));
      request.data.onUnpinAll();
      expect(onUnpinAll).toHaveBeenCalledTimes(1);
    });

    test("a right click on the bar opens the same menu", async () => {
      const onOpenContextMenu = vi.fn();
      await render(
        <PinnedMessageBar pins={pinsOf(1, 2)} onJump={vi.fn()} onOpenContextMenu={onOpenContextMenu} />,
      );
      const button = page.getByRole("button", { name: /Go to the message/ }).element();
      button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
      expect(onOpenContextMenu).toHaveBeenCalledTimes(1);
      expect(onOpenContextMenu.mock.calls[0][0].kind).toBe("pinbar");
    });

    test("offline, the close button is disabled", async () => {
      await render(<PinnedMessageBar pins={pinsOf(1)} canManage offline onJump={vi.fn()} onUnpin={vi.fn()} />);
      expect(document.querySelector('button[aria-label="Unpin message"]').disabled).toBe(true);
    });
  });
});

import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import AppContextMenu from "../../../src/components/context-menu/AppContextMenu.jsx";

const makeMenu = (overrides = {}) => ({
  kind: "message",
  point: { x: 120, y: 120 },
  targetEl: null,
  items: [
    { id: "reply", label: "Reply", onSelect: vi.fn() },
    { id: "copy", label: "Copy text", onSelect: vi.fn() },
  ],
  ...overrides,
});

describe("AppContextMenu - keyboard", () => {
  test("Escape closes the menu without reaching listeners further up (the page closes the open chat on Escape)", async () => {
    const onClose = vi.fn();
    const pageListener = vi.fn();
    document.addEventListener("keydown", pageListener);
    try {
      render(<AppContextMenu menu={makeMenu()} onClose={onClose} />);
      await expect.element(page.getByRole("menu")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(pageListener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", pageListener);
    }
  });

  test("other keys still reach the page", async () => {
    const pageListener = vi.fn();
    document.addEventListener("keydown", pageListener);
    try {
      render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
      await expect.element(page.getByRole("menu")).toBeInTheDocument();
      await userEvent.keyboard("a");
      expect(pageListener).toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", pageListener);
    }
  });

  test("arrow keys move through the items", async () => {
    render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
    const first = page.getByRole("menuitem", { name: "Reply" });
    const second = page.getByRole("menuitem", { name: "Copy text" });
    await expect.element(first).toHaveAttribute("tabindex", "0");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(second).toHaveAttribute("tabindex", "0");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(first).toHaveAttribute("tabindex", "0");
  });
});

describe("AppContextMenu - focus", () => {
  test("focus goes back to the row that had it when the menu closes", async () => {
    const row = document.createElement("div");
    row.tabIndex = -1;
    document.body.appendChild(row);
    try {
      row.focus();
      expect(document.activeElement).toBe(row);
      const view = await render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
      await expect.element(page.getByRole("menuitem", { name: "Reply" })).toHaveFocus();
      await view.rerender(<AppContextMenu menu={null} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(document.activeElement).toBe(row));
    } finally {
      row.remove();
    }
  });

  test("focus is not pulled back into a text field", async () => {
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    try {
      field.focus();
      const view = await render(<AppContextMenu menu={makeMenu()} onClose={vi.fn()} />);
      await expect.element(page.getByRole("menuitem", { name: "Reply" })).toHaveFocus();
      await view.rerender(<AppContextMenu menu={null} onClose={vi.fn()} />);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(document.activeElement).not.toBe(field);
    } finally {
      field.remove();
    }
  });
});

describe("AppContextMenu - mouse", () => {
  test("choosing an item runs it and closes the menu", async () => {
    const onClose = vi.fn();
    const menu = makeMenu();
    render(<AppContextMenu menu={menu} onClose={onClose} />);
    await page.getByRole("menuitem", { name: "Copy text" }).click();
    expect(menu.items[1].onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a right click outside the menu closes it and reopens the menu of what is underneath", async () => {
    const onClose = vi.fn();
    const underneath = vi.fn((event) => event.preventDefault());
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:100px;height:100px";
    host.addEventListener("contextmenu", underneath);
    document.body.appendChild(host);
    try {
      render(<AppContextMenu menu={makeMenu({ point: { x: 300, y: 300 } })} onClose={onClose} />);
      await expect.element(page.getByRole("menu")).toBeInTheDocument();
      const overlay = document.querySelector('button[aria-label="Close context menu"]').parentElement;
      overlay.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
      // The menu stays mounted here (the test owns `menu`), so the element under
      // the point is the overlay; the reopen goes to whatever is at that point.
      await vi.waitFor(() => expect(underneath).toHaveBeenCalled());
    } finally {
      host.remove();
    }
  });

  test("a click on the backdrop closes the menu, but not the click a lifting finger leaves behind", async () => {
    const onClose = vi.fn();
    render(<AppContextMenu menu={makeMenu()} onClose={onClose} />);
    await expect.element(page.getByRole("menu")).toBeInTheDocument();
    const backdrop = document.querySelector('button[aria-label="Close context menu"]');
    // the click of the finger that opened the menu: no press started on the backdrop
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(onClose).not.toHaveBeenCalled();
    // a real press and release on the backdrop
    backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the backdrop can be closed from the keyboard", async () => {
    const onClose = vi.fn();
    render(<AppContextMenu menu={makeMenu()} onClose={onClose} />);
    await expect.element(page.getByRole("menu")).toBeInTheDocument();
    document.querySelector('button[aria-label="Close context menu"]').click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a right click on the menu itself does nothing", async () => {
    const onClose = vi.fn();
    render(<AppContextMenu menu={makeMenu()} onClose={onClose} />);
    await expect.element(page.getByRole("menu")).toBeInTheDocument();
    const item = document.querySelector('[role="menuitem"]');
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});

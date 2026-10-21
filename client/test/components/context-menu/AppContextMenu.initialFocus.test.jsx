import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import AppContextMenu from "../../../src/components/context-menu/AppContextMenu.jsx";

const makeMenu = (labels) => ({
  kind: "chat",
  point: { x: 120, y: 120 },
  targetEl: null,
  items: labels.map((label) => ({ id: label, label, onSelect: vi.fn() })),
});

// A person who picked the third item of one menu (with the mouse) and then
// opens another menu with the keyboard must land on the FIRST item of the new
// one, not on whatever item had the number of the last choice.
describe("AppContextMenu - where the focus starts", () => {
  test("a new menu starts on its first item after the last one closed on another", async () => {
    const view = await render(<AppContextMenu menu={makeMenu(["Unpin", "Move up", "Move down"])} onClose={vi.fn()} />);
    await expect.element(page.getByRole("menu")).toBeInTheDocument();
    // the mouse moves focus to the third item
    page.getByRole("menuitem", { name: "Move down" }).element().focus();
    await expect.element(page.getByRole("menuitem", { name: "Move down" })).toHaveAttribute("tabindex", "0");

    await view.rerender(<AppContextMenu menu={null} onClose={vi.fn()} />);
    await view.rerender(
      <AppContextMenu menu={makeMenu(["Pin to top", "Mark as seen", "Mute", "Delete"])} onClose={vi.fn()} />,
    );
    await expect.element(page.getByRole("menu")).toBeInTheDocument();
    await expect.element(page.getByRole("menuitem", { name: "Pin to top" })).toHaveAttribute("tabindex", "0");
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Pin to top");
    });
  });

  test("an open menu replaced by another one (a right click elsewhere) starts on its first item", async () => {
    const view = await render(<AppContextMenu menu={makeMenu(["A", "B", "C"])} onClose={vi.fn()} />);
    page.getByRole("menuitem", { name: "C" }).element().focus();
    await view.rerender(<AppContextMenu menu={makeMenu(["One", "Two", "Three", "Four"])} onClose={vi.fn()} />);
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe("One");
    });
  });
});

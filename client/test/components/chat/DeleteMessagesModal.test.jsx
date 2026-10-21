import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import DeleteMessagesModal from "../../../src/components/chat/selection/DeleteMessagesModal.jsx";

beforeEach(() => {
  window.localStorage.removeItem("songbird-delete-message-for-everyone");
});

const open = (props = {}) =>
  render(
    <DeleteMessagesModal
      total={3}
      everyoneCount={3}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
      {...props}
    />,
  );

describe("DeleteMessagesModal", () => {
  test("asks 'Delete N messages?' in a modal dialog", async () => {
    await open({ total: 5, everyoneCount: 5 });
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeInTheDocument();
    expect(document.querySelector("[role=dialog]").getAttribute("aria-modal")).toBe("true");
    await expect.element(page.getByText("Delete 5 messages?")).toBeInTheDocument();
  });

  test("singular for one message", async () => {
    await open({ total: 1, everyoneCount: 1 });
    await expect.element(page.getByText("Delete 1 message?")).toBeInTheDocument();
  });

  test("the switch is offered when at least one message may be deleted for everyone", async () => {
    await open({ total: 3, everyoneCount: 1 });
    await expect.element(page.getByRole("switch")).toBeInTheDocument();
  });

  test("with none that may, there is no switch and the dialog says why it is only hiding", async () => {
    await open({ total: 3, everyoneCount: 0 });
    expect(page.getByRole("switch").elements()).toHaveLength(0);
    await expect
      .element(page.getByText("You can only remove them from your own view. Everyone else in the chat keeps them."))
      .toBeInTheDocument();
  });

  test("offline there is no switch either", async () => {
    await open({ total: 3, everyoneCount: 3, offline: true });
    expect(page.getByRole("switch").elements()).toHaveLength(0);
  });

  test("the explanation follows the switch", async () => {
    await open({ total: 4, everyoneCount: 2 });
    await expect.element(page.getByText(/removed from your view only\. Turn on/)).toBeInTheDocument();
    await page.getByRole("switch").click();
    await expect
      .element(page.getByText("2 of them are removed for everyone. The other 2 can only be removed from your view."))
      .toBeInTheDocument();
  });

  test("confirming without the switch hides for me", async () => {
    const onConfirm = vi.fn();
    await open({ onConfirm });
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  test("confirming with the switch on deletes for everyone, and the choice is remembered", async () => {
    const onConfirm = vi.fn();
    await open({ onConfirm });
    await page.getByRole("switch").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    expect(onConfirm).toHaveBeenCalledWith(true);
    expect(window.localStorage.getItem("songbird-delete-message-for-everyone")).toBe("1");
  });

  test("a remembered choice starts the switch on", async () => {
    window.localStorage.setItem("songbird-delete-message-for-everyone", "1");
    await open();
    expect(document.querySelector("[role=switch]").getAttribute("aria-checked")).toBe("true");
  });

  test("a remembered choice does not turn the switch on when nothing may go for everyone", async () => {
    window.localStorage.setItem("songbird-delete-message-for-everyone", "1");
    const onConfirm = vi.fn();
    await open({ everyoneCount: 0, onConfirm });
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  test("cancel closes it", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    await open({ onClose, onConfirm });
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("Escape closes it and is not passed on (the page's Escape closes the chat)", async () => {
    const onClose = vi.fn();
    const pageEscape = vi.fn();
    document.addEventListener("keydown", pageEscape);
    await open({ onClose });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    document.removeEventListener("keydown", pageEscape);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pageEscape).not.toHaveBeenCalled();
  });

  test("while it works the buttons are off and Cancel does nothing", async () => {
    let finish;
    const onConfirm = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const onClose = vi.fn();
    await open({ onConfirm, onClose });
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const cancel = document.querySelector("[role=dialog] button:not([role=switch])");
    expect(cancel.disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(cancel.disabled).toBe(false));
  });
});

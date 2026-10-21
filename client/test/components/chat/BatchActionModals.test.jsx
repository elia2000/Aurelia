import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import BatchActionModals from "../../../src/components/chat/selection/BatchActionModals.jsx";

const forwardProps = (extra = {}) => ({
  chats: [{ id: "chat-2", type: "dm", members: [{ id: "u2", username: "carol", nickname: "Carol" }] }],
  savedChat: null,
  currentUser: { id: "u1", username: "me" },
  sourceChatId: "chat-1",
  busy: false,
  onClose: vi.fn(),
  onSubmit: vi.fn(),
  ...extra,
});

const escape = () => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
};

describe("BatchActionModals", () => {
  test("shows nothing when neither question is asked", async () => {
    await render(<BatchActionModals />);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  test("shows the chat chooser for the forward props", async () => {
    await render(<BatchActionModals forward={forwardProps()} />);
    await expect.element(page.getByText("Send to...")).toBeInTheDocument();
  });

  test("sending from the chooser calls onSubmit with the chosen chats", async () => {
    const onSubmit = vi.fn();
    await render(<BatchActionModals forward={forwardProps({ onSubmit })} />);
    await page.getByRole("dialog").getByText("Carol").click();
    await page.getByRole("button", { name: "Send" }).click();
    expect(onSubmit).toHaveBeenCalledWith(["chat-2"]);
  });

  test("shows the delete question for the remove props", async () => {
    await render(
      <BatchActionModals
        remove={{ total: 4, everyoneCount: 4, offline: false, onClose: vi.fn(), onConfirm: vi.fn() }}
      />,
    );
    await expect.element(page.getByText("Delete 4 messages?")).toBeInTheDocument();
  });

  test("Escape closes the chooser, and is not passed on to the page", async () => {
    const onClose = vi.fn();
    const pageEscape = vi.fn();
    document.addEventListener("keydown", pageEscape);
    await render(<BatchActionModals forward={forwardProps({ onClose })} />);
    const event = escape();
    document.removeEventListener("keydown", pageEscape);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(pageEscape).not.toHaveBeenCalled();
  });

  test("Escape does not close the chooser while the messages are being sent", async () => {
    const onClose = vi.fn();
    await render(<BatchActionModals forward={forwardProps({ onClose, busy: true })} />);
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });
});

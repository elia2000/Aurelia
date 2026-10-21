import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import SelectionBar from "../../../src/components/chat/selection/SelectionBar.jsx";
import SelectionCheckbox from "../../../src/components/chat/selection/SelectionCheckbox.jsx";

const bar = () => document.querySelector("[data-selection-bar]");

describe("SelectionBar", () => {
  test("says how many messages are selected, in a live region", async () => {
    await render(<SelectionBar active count={3} />);
    const status = bar().querySelector("[role=status]");
    expect(status.textContent).toBe("3 selected");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(bar().getAttribute("data-selection-count")).toBe("3");
  });

  test("the live region stays in the page, empty, while nothing is selected", async () => {
    await render(<SelectionBar active={false} count={0} />);
    const status = bar().querySelector("[role=status]");
    expect(status).toBeTruthy();
    expect(status.textContent).toBe("");
    // hidden from the keyboard and from pointers
    expect(bar().hasAttribute("inert")).toBe(true);
    expect(bar().getAttribute("data-selection-count")).toBeNull();
  });

  test("the bar is live while selecting", async () => {
    await render(<SelectionBar active count={1} />);
    expect(bar().hasAttribute("inert")).toBe(false);
  });

  test("copy, forward, delete and cancel call their handlers", async () => {
    const onCopy = vi.fn();
    const onForward = vi.fn();
    const onDelete = vi.fn();
    const onClose = vi.fn();
    await render(
      <SelectionBar active count={2} onCopy={onCopy} onForward={onForward} onDelete={onDelete} onClose={onClose} />,
    );
    await page.getByRole("button", { name: "Copy selected messages" }).click();
    await page.getByRole("button", { name: "Forward 2 messages" }).click();
    await page.getByRole("button", { name: "Delete 2 messages" }).click();
    await page.getByRole("button", { name: "Cancel selection" }).click();
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the buttons name the count, in the singular too", async () => {
    await render(<SelectionBar active count={1} />);
    await expect.element(page.getByRole("button", { name: "Forward 1 message" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Delete 1 message" })).toBeInTheDocument();
  });

  test("forward is dimmed, but still answers a tap, when nothing selected can be forwarded", async () => {
    const onForward = vi.fn();
    await render(<SelectionBar active count={1} canForward={false} onForward={onForward} />);
    const forward = document.querySelector("button[aria-label^='Forward']");
    expect(forward.getAttribute("aria-disabled")).toBe("true");
    expect(forward.disabled).toBe(false);
    forward.click();
    expect(onForward).toHaveBeenCalledTimes(1);
  });

  test("offline: forward and delete are marked unavailable and say why", async () => {
    await render(<SelectionBar active count={2} offline />);
    const forward = document.querySelector("button[aria-label^='Forward']");
    const remove = document.querySelector("button[aria-label^='Delete']");
    expect(forward.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(forward.title).toBe("You're offline");
    // copying needs no connection
    expect(document.querySelector("button[aria-label^='Copy']").getAttribute("aria-disabled")).toBeNull();
  });
});

describe("SelectionCheckbox", () => {
  test("in selection mode it is a picture of the row's state", async () => {
    await render(<SelectionCheckbox messageKey="m1" active selected={false} onEnter={vi.fn()} />);
    const box = document.querySelector("[data-selection-box]");
    expect(box.tagName).toBe("SPAN");
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.getAttribute("data-selected")).toBe("false");
    expect(box.querySelector("svg")).toBeNull();
  });

  test("a ticked one shows the check", async () => {
    await render(<SelectionCheckbox messageKey="m1" active selected onEnter={vi.fn()} />);
    const box = document.querySelector("[data-selection-box]");
    expect(box.getAttribute("data-selected")).toBe("true");
    expect(box.querySelector("svg")).toBeTruthy();
  });

  test("outside selection mode it is a button that starts selection with its message", async () => {
    const onEnter = vi.fn();
    const onRowClick = vi.fn();
    await render(
      <div onClick={onRowClick}>
        <SelectionCheckbox messageKey="m7" active={false} selected={false} onEnter={onEnter} />
      </div>,
    );
    const button = document.querySelector("[data-selection-enter]");
    expect(button.tagName).toBe("BUTTON");
    // not in the tab order: the keyboard starts selection from the message menu
    expect(button.tabIndex).toBe(-1);
    button.click();
    expect(onEnter).toHaveBeenCalledWith("m7");
    // the click does not also reach the row
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import ContextMenuSurface from "../../../src/components/context-menu/ContextMenuSurface.jsx";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function Row({ onOpen, isMobile = false, disabled = false, holdDelayMs = 25, onChildClick }) {
  return (
    <ContextMenuSurface
      as="div"
      data-testid="row"
      tabIndex={-1}
      style={{ width: 400, height: 60, padding: 8 }}
      contextMenu={{ onOpen, isMobile, disabled, holdDelayMs }}
    >
      <button type="button" data-testid="child" onClick={onChildClick}>
        message
      </button>
      <span data-testid="text">some text</span>
    </ContextMenuSurface>
  );
}

const fire = (el, type, init = {}) => {
  const Ctor = type.startsWith("pointer") ? PointerEvent : type.startsWith("key") ? KeyboardEvent : MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
};

const getEl = (id) => document.querySelector(`[data-testid="${id}"]`);

describe("ContextMenuSurface - mouse", () => {
  test("right click on the surface itself (the empty gutter) opens the menu and cancels the browser menu", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    const event = fire(getEl("row"), "contextmenu", { clientX: 12, clientY: 34 });
    expect(event.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({ source: "desktop", isMobile: false });
  });

  test("right click on a child bubbles up to the surface", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} />);
    await expect.element(page.getByTestId("text")).toBeInTheDocument();
    fire(getEl("text"), "contextmenu", { clientX: 5, clientY: 5 });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("a disabled surface leaves the browser menu alone", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} disabled />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    const event = fire(getEl("row"), "contextmenu");
    expect(event.defaultPrevented).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("on a touch layout the native contextmenu event is not hijacked", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} isMobile />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    const event = fire(getEl("row"), "contextmenu");
    expect(event.defaultPrevented).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("the mouse never starts a long press, even on a touch layout", async () => {
    const onOpen = vi.fn();
    const onChildClick = vi.fn();
    render(<Row onOpen={onOpen} isMobile onChildClick={onChildClick} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    const down = fire(getEl("text"), "pointerdown", { pointerType: "mouse", pointerId: 1, button: 0, clientX: 5, clientY: 5 });
    expect(down.defaultPrevented).toBe(false);
    await wait(80);
    expect(onOpen).not.toHaveBeenCalled();
    fire(getEl("text"), "pointerup", { pointerType: "mouse", pointerId: 1 });
    // and the click that follows is not swallowed
    getEl("child").click();
    expect(onChildClick).toHaveBeenCalledTimes(1);
  });
});

describe("ContextMenuSurface - touch and pen long press", () => {
  test("a held finger opens the menu", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} isMobile />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("text"), "pointerdown", { pointerType: "touch", pointerId: 2, clientX: 5, clientY: 5 });
    await wait(80);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({ source: "mobile", isMobile: true });
  });

  test("a held pen opens the menu too", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} isMobile />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("text"), "pointerdown", { pointerType: "pen", pointerId: 3, clientX: 5, clientY: 5 });
    await wait(80);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("lifting the finger early cancels the long press", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} isMobile holdDelayMs={60} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("text"), "pointerdown", { pointerType: "touch", pointerId: 4, clientX: 5, clientY: 5 });
    fire(getEl("text"), "pointerup", { pointerType: "touch", pointerId: 4 });
    await wait(120);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("moving the finger past the tolerance cancels the long press", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} isMobile holdDelayMs={60} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("text"), "pointerdown", { pointerType: "touch", pointerId: 5, clientX: 5, clientY: 5 });
    fire(getEl("text"), "pointermove", { pointerType: "touch", pointerId: 5, clientX: 60, clientY: 5 });
    await wait(120);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("the click that follows a long press is swallowed", async () => {
    const onOpen = vi.fn();
    const onChildClick = vi.fn();
    render(<Row onOpen={onOpen} isMobile onChildClick={onChildClick} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("text"), "pointerdown", { pointerType: "touch", pointerId: 6, clientX: 5, clientY: 5 });
    await wait(80);
    expect(onOpen).toHaveBeenCalledTimes(1);
    getEl("child").click();
    expect(onChildClick).not.toHaveBeenCalled();
  });
});

describe("ContextMenuSurface - the lift after a long press", () => {
  function RowWithMenuUnderTheFinger({ onItemClick }) {
    return (
      <>
        <Row onOpen={() => {}} isMobile />
        <button type="button" data-testid="menu-item" onClick={onItemClick}>
          menu item
        </button>
      </>
    );
  }

  test("the click the browser sends to the menu when the finger lifts does not choose an item", async () => {
    const onItemClick = vi.fn();
    render(<RowWithMenuUnderTheFinger onItemClick={onItemClick} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("text"), "pointerdown", { pointerType: "touch", pointerId: 20, clientX: 5, clientY: 5 });
    await wait(80); // the menu is open, the finger is still down
    fire(getEl("menu-item"), "pointerup", { pointerType: "touch", pointerId: 20 });
    getEl("menu-item").click();
    expect(onItemClick).not.toHaveBeenCalled();
    // a later, deliberate tap works
    getEl("menu-item").click();
    expect(onItemClick).toHaveBeenCalledTimes(1);
  });

  test("a deliberate tap after the guard window is not swallowed", async () => {
    const onItemClick = vi.fn();
    render(<RowWithMenuUnderTheFinger onItemClick={onItemClick} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("text"), "pointerdown", { pointerType: "touch", pointerId: 21, clientX: 5, clientY: 5 });
    await wait(80);
    fire(getEl("menu-item"), "pointerup", { pointerType: "touch", pointerId: 21 });
    await wait(650); // the finger lifted long ago and no click came
    getEl("menu-item").click();
    expect(onItemClick).toHaveBeenCalledTimes(1);
  });

  test("a control marked data-menu-passthrough still lets a long press open the menu", async () => {
    const onOpen = vi.fn();
    render(
      <ContextMenuSurface
        as="div"
        data-testid="row"
        contextMenu={{ onOpen, isMobile: true, holdDelayMs: 25 }}
      >
        <button type="button" data-testid="plain">plain</button>
        <button type="button" data-testid="picture" data-menu-passthrough="">
          picture
        </button>
      </ContextMenuSurface>,
    );
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("plain"), "pointerdown", { pointerType: "touch", pointerId: 22, clientX: 5, clientY: 5 });
    await wait(80);
    expect(onOpen).not.toHaveBeenCalled();
    fire(getEl("picture"), "pointerdown", { pointerType: "touch", pointerId: 23, clientX: 5, clientY: 5 });
    await wait(80);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("ContextMenuSurface - keyboard", () => {
  test("the ContextMenu key opens the menu from a focused row", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    const event = fire(getEl("row"), "keydown", { key: "ContextMenu" });
    expect(event.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({ source: "keyboard", isMobile: false });
  });

  test("Shift+F10 opens the menu", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("row"), "keydown", { key: "F10", shiftKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("other keys and a bare F10 do nothing", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("row"), "keydown", { key: "F10" });
    fire(getEl("row"), "keydown", { key: "Enter" });
    fire(getEl("row"), "keydown", { key: "a", shiftKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("the browser contextmenu event that follows the key does not open it twice", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("row"), "keydown", { key: "ContextMenu" });
    fire(getEl("row"), "contextmenu", { clientX: 0, clientY: 0 });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("a disabled surface ignores the keyboard", async () => {
    const onOpen = vi.fn();
    render(<Row onOpen={onOpen} disabled />);
    await expect.element(page.getByTestId("row")).toBeInTheDocument();
    fire(getEl("row"), "keydown", { key: "ContextMenu" });
    expect(onOpen).not.toHaveBeenCalled();
  });
});

import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { MessageTimeline } from "../../../src/components/chat/messages/MessageTimeline.jsx";

const at = (minutes) =>
  new Date(Date.UTC(2024, 0, 1, 12, 0, 0) + minutes * 60 * 1000).toISOString();
const msg = (id, username, minutes, extra = {}) => ({
  id,
  username,
  created_at: at(minutes),
  body: `message ${id}`,
  ...extra,
});

// Shows which run flags the timeline handed to each row.
function Probe({ msg: message, isRunStart, isRunEnd, isFirstInGroup }) {
  const position = `${isRunStart ? "start" : "-"}/${isRunEnd ? "end" : "-"}`;
  return (
    <div data-testid={`row-${message.id}`} data-run={position} data-first={String(Boolean(isFirstInGroup))}>
      {message.body}
    </div>
  );
}

const baseProps = (groups, renderMessageItem) => ({
  activeChatId: "chat-1",
  loadingMessages: false,
  messages: groups.flatMap((g) => g.items),
  groupedMessages: groups,
  loadingOlderMessages: false,
  handleGroupChipClick: vi.fn(),
  renderMessageItem,
  chatScrollRef: { current: null },
  handlePanelScroll: vi.fn(),
  handleScrollIntent: vi.fn(),
  chatScrollStyle: undefined,
  timelineBottomSpacerPx: 4,
});

const run = (id) => document.querySelector(`[data-testid="row-${id}"]`).getAttribute("data-run");

describe("MessageTimeline - runs of one sender", () => {
  const groups = [
    {
      dayKey: "d1",
      dayLabel: "Today",
      items: [
        msg(1, "a", 0),
        msg(2, "a", 1),
        msg(3, "a", 2),
        msg(4, "b", 3),
        msg(5, "a", 4),
        msg(6, "a", 30),
      ],
    },
  ];

  test("tells each bubble where its run starts and ends", async () => {
    render(
      <MessageTimeline
        {...baseProps(groups, (m, options) => (
          <Probe key={m.id} msg={m} isFirstInGroup={options.isFirstInGroup} />
        ))}
      />,
    );
    await expect.element(page.getByText("message 1")).toBeInTheDocument();
    expect(run(1)).toBe("start/-");
    expect(run(2)).toBe("-/-");
    expect(run(3)).toBe("-/end");
    expect(run(4)).toBe("start/end");
    expect(run(5)).toBe("start/end");
    // thirty minutes later is a new run
    expect(run(6)).toBe("start/end");
  });

  test("keeps passing isFirstInGroup for the first message of the day", async () => {
    render(
      <MessageTimeline
        {...baseProps(groups, (m, options) => (
          <Probe key={m.id} msg={m} isFirstInGroup={options.isFirstInGroup} />
        ))}
      />,
    );
    await expect.element(page.getByText("message 1")).toBeInTheDocument();
    expect(document.querySelector('[data-testid="row-1"]').getAttribute("data-first")).toBe("true");
    expect(document.querySelector('[data-testid="row-2"]').getAttribute("data-first")).toBe("false");
  });

  test("a new day always starts a new run", async () => {
    const twoDays = [
      { dayKey: "d1", dayLabel: "Yesterday", items: [msg(1, "a", 0)] },
      { dayKey: "d2", dayLabel: "Today", items: [msg(2, "a", 1)] },
    ];
    render(
      <MessageTimeline
        {...baseProps(twoDays, (m) => <Probe key={m.id} msg={m} />)}
      />,
    );
    await expect.element(page.getByText("message 2")).toBeInTheDocument();
    expect(run(1)).toBe("start/end");
    expect(run(2)).toBe("start/end");
  });

  test("a caller that already passes the run flags is left alone", async () => {
    render(
      <MessageTimeline
        {...baseProps(groups, (m) => (
          <Probe key={m.id} msg={m} isRunStart={false} isRunEnd />
        ))}
      />,
    );
    await expect.element(page.getByText("message 1")).toBeInTheDocument();
    expect(run(1)).toBe("-/end");
    expect(run(2)).toBe("-/end");
  });

  test("renders a small date chip per day that jumps to the day", async () => {
    const handleGroupChipClick = vi.fn();
    render(
      <MessageTimeline
        {...baseProps(groups, (m) => <Probe key={m.id} msg={m} />)}
        handleGroupChipClick={handleGroupChipClick}
      />,
    );
    await page.getByRole("button", { name: /jump to messages from today/i }).click();
    expect(handleGroupChipClick).toHaveBeenCalledWith("d1");
  });

  test("rows reach the edges of the chat so a right click anywhere on a row works", async () => {
    render(
      <MessageTimeline {...baseProps(groups, (m) => <Probe key={m.id} msg={m} />)} />,
    );
    await expect.element(page.getByText("message 1")).toBeInTheDocument();
    const log = document.querySelector('[role="log"]');
    const row = document.querySelector('[data-testid="row-1"]');
    const logStyle = getComputedStyle(log);
    expect(parseFloat(logStyle.paddingLeft)).toBe(0);
    expect(parseFloat(logStyle.paddingRight)).toBe(0);
    expect(row.getBoundingClientRect().width).toBe(log.clientWidth);
  });

  test("a right click in the scrollbar strip beside the rows reaches the row at that height", async () => {
    const onRowMenu = vi.fn((event) => event.preventDefault());
    function MenuRow({ msg: message }) {
      return (
        <div data-message-row data-testid={`row-${message.id}`} onContextMenu={onRowMenu}>
          {message.body}
        </div>
      );
    }
    render(
      <MessageTimeline {...baseProps(groups, (m) => <MenuRow key={m.id} msg={m} />)} />,
    );
    await expect.element(page.getByText("message 2")).toBeInTheDocument();
    const log = document.querySelector('[role="log"]');
    const target = document.querySelector('[data-testid="row-2"]').getBoundingClientRect();
    const logRect = log.getBoundingClientRect();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: logRect.left + 2,
      clientY: target.top + target.height / 2,
    });
    log.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onRowMenu).toHaveBeenCalledTimes(1);
    expect(onRowMenu.mock.calls[0][0].target.getAttribute("data-testid")).toBe("row-2");
    expect(onRowMenu.mock.calls[0][0].clientX).toBe(logRect.left + 2);
  });

  test("a right click on a row is not handled twice", async () => {
    const onRowMenu = vi.fn((event) => event.preventDefault());
    function MenuRow({ msg: message }) {
      return (
        <div data-message-row data-testid={`row-${message.id}`} onContextMenu={onRowMenu}>
          {message.body}
        </div>
      );
    }
    render(
      <MessageTimeline {...baseProps(groups, (m) => <MenuRow key={m.id} msg={m} />)} />,
    );
    await expect.element(page.getByText("message 2")).toBeInTheDocument();
    document
      .querySelector('[data-testid="row-2"]')
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onRowMenu).toHaveBeenCalledTimes(1);
  });

  test("a click on empty chat space drops a text selection, a click in a bubble keeps it", async () => {
    function BubbleRow({ msg: message }) {
      return (
        <div data-message-row data-testid={`row-${message.id}`}>
          <div data-message-bubble data-testid={`bubble-${message.id}`}>
            <span>{message.body}</span>
          </div>
        </div>
      );
    }
    render(
      <MessageTimeline {...baseProps(groups, (m) => <BubbleRow key={m.id} msg={m} />)} />,
    );
    await expect.element(page.getByText("message 2")).toBeInTheDocument();
    const text = document.querySelector('[data-testid="bubble-2"] span').firstChild;
    const select = () => {
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 7);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const press = (el, init = {}) =>
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));

    select();
    press(document.querySelector('[data-testid="bubble-2"]'));
    expect(window.getSelection().toString()).toBe("message");

    select();
    press(document.querySelector('[data-testid="row-2"]'), { button: 2 });
    expect(window.getSelection().toString()).toBe("message");

    select();
    const log = document.querySelector('[role="log"]');
    const logRect = log.getBoundingClientRect();
    press(log, { clientX: logRect.left + log.clientLeft + log.clientWidth + 2 });
    expect(window.getSelection().toString()).toBe("message");

    select();
    press(document.querySelector('[data-testid="row-2"]'), { clientX: 5 });
    expect(window.getSelection().toString()).toBe("");

    // a double click on what cannot be selected does not select hidden text
    const dbl = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 2, clientX: 5 });
    document.querySelector('[data-testid="row-2"]').dispatchEvent(dbl);
    expect(dbl.defaultPrevented).toBe(true);
    const inBubble = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 2 });
    document.querySelector('[data-testid="bubble-2"] span').dispatchEvent(inBubble);
    expect(inBubble.defaultPrevented).toBe(false);

    // a selection outside the chat (the composer, say) is not touched
    const outside = document.createElement("p");
    outside.textContent = "outside text";
    document.body.appendChild(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    press(document.querySelector('[data-testid="row-2"]'), { clientX: 5 });
    expect(window.getSelection().toString()).toBe("outside text");
    outside.remove();
    window.getSelection().removeAllRanges();
  });

  test("a right click where there is no row leaves the browser menu alone", async () => {
    render(
      <MessageTimeline {...baseProps(groups, (m) => <Probe key={m.id} msg={m} />)} />,
    );
    await expect.element(page.getByText("message 2")).toBeInTheDocument();
    const log = document.querySelector('[role="log"]');
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 3,
      clientY: -500,
    });
    log.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

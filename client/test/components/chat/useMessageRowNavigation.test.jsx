import { useRef } from "react";
import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { useMessageRowNavigation } from "../../../src/hooks/chat/useMessageRowNavigation.js";

const msg = (n, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, body: `message ${n}`, ...extra });

// A chat window reduced to what the hook touches: a scroller with rows, one of
// which is the tab stop, and a button inside a row (taken out of the tab order
// here so that the tests follow the rows alone).
function Harness({ messages, enabled = true, chatId = "chat-1" }) {
  const scrollRef = useRef(null);
  const { tabStopKey } = useMessageRowNavigation({ chatId, scrollRef, messages, enabled });
  return (
    <div>
      <button type="button">before</button>
      <div ref={scrollRef}>
        {messages.map((m) =>
          m._systemEvent ? (
            <div key={m.id} data-testid={`chip-${m.id}`}>chip</div>
          ) : (
            <div
              key={m.id}
              data-message-row
              data-message-key={m.id}
              data-testid={`row-${m.body}`}
              tabIndex={tabStopKey === m.id ? 0 : -1}
            >
              {m.body}
              <button type="button" tabIndex={-1}>in {m.body}</button>
            </div>
          ),
        )}
      </div>
      <button type="button">after</button>
    </div>
  );
}

const rows = () => [...document.querySelectorAll("[data-message-row]")];
const stop = () => rows().filter((row) => row.tabIndex === 0).map((row) => row.textContent);

describe("useMessageRowNavigation", () => {
  test("the newest message is the one tab stop", async () => {
    await render(<Harness messages={[msg(1), msg(2), msg(3)]} />);
    expect(stop()).toEqual(["message 3in message 3"]);
  });

  test("a chip at the end of the chat is not a row: the newest message is", async () => {
    await render(<Harness messages={[msg(1), msg(2), msg(3, { _systemEvent: { type: "joined" } })]} />);
    expect(stop()).toEqual(["message 2in message 2"]);
  });

  test("Tab from the field before the list lands on a message", async () => {
    await render(<Harness messages={[msg(1), msg(2), msg(3)]} />);
    document.querySelector("button").focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(rows()[2]);
  });

  test("the arrow keys move between messages, Home and End go to the ends, and the tab stop follows", async () => {
    await render(<Harness messages={[msg(1), msg(2), msg(3), msg(4)]} />);
    document.querySelector("button").focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(rows()[3]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[2]);
    await vi.waitFor(() => expect(stop()).toEqual(["message 3in message 3"]));
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(rows()[0]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[0]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(rows()[3]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(rows()[0]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[1]);
    await vi.waitFor(() => expect(stop()).toEqual(["message 2in message 2"]));
  });

  test("Tab leaves the list from the row, and comes back to the row that was left", async () => {
    await render(<Harness messages={[msg(1), msg(2), msg(3)]} />);
    document.querySelector("button").focus();
    await userEvent.tab();
    await userEvent.keyboard("{ArrowUp}");
    await vi.waitFor(() => expect(stop()).toEqual(["message 2in message 2"]));
    document.querySelector("button").focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(rows()[1]);
  });

  test("keys typed in a control inside a row are left to it", async () => {
    await render(<Harness messages={[msg(1), msg(2)]} />);
    const inner = rows()[1].querySelector("button");
    inner.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(inner);
  });

  test("modifier keys are not taken", async () => {
    await render(<Harness messages={[msg(1), msg(2)]} />);
    rows()[1].focus();
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(document.activeElement).toBe(rows()[1]);
  });

  test("switched off (selection mode has its own keys): no tab stop and no arrows", async () => {
    await render(<Harness messages={[msg(1), msg(2)]} enabled={false} />);
    expect(stop()).toEqual([]);
    rows()[1].focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[1]);
  });

  test("if the row that was the tab stop is gone the newest one takes over", async () => {
    const view = await render(<Harness messages={[msg(1), msg(2), msg(3)]} />);
    document.querySelector("button").focus();
    await userEvent.tab();
    await userEvent.keyboard("{ArrowUp}");
    await vi.waitFor(() => expect(stop()).toEqual(["message 2in message 2"]));
    await view.rerender(<Harness messages={[msg(1), msg(3)]} />);
    expect(stop()).toEqual(["message 3in message 3"]);
  });

  test("another chat starts with its newest message again", async () => {
    const view = await render(<Harness messages={[msg(1), msg(2)]} chatId="a" />);
    rows()[0].focus();
    await userEvent.keyboard("{ArrowDown}{ArrowUp}");
    await vi.waitFor(() => expect(stop()).toEqual(["message 1in message 1"]));
    await view.rerender(<Harness messages={[msg(1), msg(2)]} chatId="b" />);
    expect(stop()).toEqual(["message 2in message 2"]);
  });
});


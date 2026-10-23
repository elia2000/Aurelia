import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

const state = vi.hoisted(() => ({ trust: { state: "unverified", mismatch: false, ready: true, refresh: () => {} } }));
vi.mock("../../../src/e2ee/useContactTrust.js", () => ({ useContactTrust: () => state.trust }));
vi.mock("../../../src/calls/callContext.js", () => ({
  useCalls: () => ({ inCall: false, startCall: () => {}, supported: false }),
}));
vi.mock("../../../src/components/calls/SafetyNumberModal.jsx", () => ({
  default: ({ open, chatId }) => (open ? <div role="dialog" aria-label="Verify security">safety number of {chatId}</div> : null),
}));

import CallButtons from "../../../src/components/calls/CallButtons.jsx";
import { requestSafetyNumber } from "../../../src/e2ee/safetyNumberRequests.js";

const peer = { id: "bob", username: "bob", nickname: "Bob" };
const user = { id: "me", username: "me" };

beforeEach(() => {
  state.trust = { state: "unverified", mismatch: false, ready: true, refresh: () => {} };
});

describe("the shield in the header of a direct chat", () => {
  test("says 'not verified' until the contact is verified", async () => {
    await render(<CallButtons chatId="chat-1" peer={peer} user={user} />);
    const shield = page.getByRole("button", { name: "Encryption and safety number: not verified" });
    await expect.element(shield).toBeVisible();
    expect(document.querySelector("[data-trust]").getAttribute("data-trust")).toBe("unverified");
    await expect.element(shield).toHaveAttribute("title", "Not verified yet. Open the safety number");
  });

  test("says 'verified' for a verified contact", async () => {
    state.trust = { ...state.trust, state: "verified" };
    await render(<CallButtons chatId="chat-1" peer={peer} user={user} />);
    await expect.element(page.getByRole("button", { name: "Encryption and safety number: verified" })).toBeVisible();
    expect(document.querySelector("[data-trust]").getAttribute("data-trust")).toBe("verified");
  });

  test("says 'changed' when devices or keys changed", async () => {
    state.trust = { ...state.trust, state: "changed" };
    await render(<CallButtons chatId="chat-1" peer={peer} user={user} />);
    await expect.element(page.getByRole("button", { name: "Encryption and safety number: changed, review it" })).toBeVisible();
    expect(document.querySelector("[data-trust]").getAttribute("data-trust")).toBe("changed");
  });

  test("opens the safety number", async () => {
    await render(<CallButtons chatId="chat-1" peer={peer} user={user} />);
    await page.getByRole("button", { name: /Encryption and safety number/ }).click();
    await expect.element(page.getByRole("dialog", { name: "Verify security" })).toBeVisible();
  });

  test("a notice's Verify opens this chat's safety number, and only this chat's", async () => {
    await render(<CallButtons chatId="chat-1" peer={peer} user={user} />);
    requestSafetyNumber("chat-2");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    requestSafetyNumber("chat-1");
    await expect.element(page.getByRole("dialog", { name: "Verify security" })).toBeVisible();
  });
});

import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

const services = vi.hoisted(() => ({
  api: { listMyDevices: vi.fn() },
  directory: { getUserDevices: vi.fn() },
  trust: { isVerified: vi.fn(), setVerified: vi.fn() },
}));
vi.mock("../../../src/e2ee/services.js", () => ({ getE2eeServices: () => services }));

import SafetyNumberModal from "../../../src/components/calls/SafetyNumberModal.jsx";

const key = (n) => btoa(String.fromCharCode(...new Uint8Array(65).fill(n))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const device = (n) => ({ id: `d${n}`, ecdhPublic: key(n), ecdsaPublic: key(n + 50) });
const self = { id: "u-alice", username: "alice" };
const peer = { userId: "u-bob", username: "bob", nickname: "Bob" };

beforeEach(() => {
  services.api.listMyDevices.mockReset().mockResolvedValue({ devices: [device(1)] });
  services.directory.getUserDevices.mockReset().mockResolvedValue({ devices: [device(2)] });
  services.trust.isVerified.mockReset().mockResolvedValue(false);
  services.trust.setVerified.mockReset().mockResolvedValue();
});

describe("SafetyNumberModal", () => {
  test("shows the 60-digit number in twelve groups", async () => {
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    const grid = page.getByLabelText("Safety number");
    await expect.element(grid).toBeInTheDocument();
    const groups = [...(await grid.element()).children].map((el) => el.textContent);
    expect(groups).toHaveLength(12);
    groups.forEach((group) => expect(group).toMatch(/^\d{5}$/));
    await expect.element(page.getByText("Not verified yet.")).toBeInTheDocument();
  });

  test("marking verified is stored against the exact number, and can be removed", async () => {
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await page.getByRole("button", { name: "Mark as verified" }).click();
    expect(services.trust.setVerified).toHaveBeenCalledTimes(1);
    const [userId, digits, flag] = services.trust.setVerified.mock.calls[0];
    expect(userId).toBe("u-bob");
    expect(digits).toMatch(/^\d{60}$/);
    expect(flag).toBe(true);
    await expect.element(page.getByText("You verified this number.")).toBeInTheDocument();
    await page.getByRole("button", { name: "Remove verification" }).click();
    expect(services.trust.setVerified.mock.calls[1][2]).toBe(false);
  });

  test("an already verified number is shown as verified", async () => {
    services.trust.isVerified.mockResolvedValue(true);
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await expect.element(page.getByText("You verified this number.")).toBeInTheDocument();
  });

  test("shows the call's emoji code when one is passed", async () => {
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} sas={["🌲", "🌴"]} />);
    await expect.element(page.getByText("🌲 🌴")).toBeInTheDocument();
  });

  test("a contact without secure messaging gets a clear message", async () => {
    services.directory.getUserDevices.mockResolvedValue({ devices: [] });
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await expect.element(page.getByText(/has not set up secure messaging yet/)).toBeInTheDocument();
  });

  test("unexpected key changes are called out", async () => {
    services.directory.getUserDevices.mockRejectedValue(Object.assign(new Error("x"), { name: "KeyMismatchError" }));
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await expect.element(page.getByText(/security keys changed unexpectedly/)).toBeInTheDocument();
  });

  test("closes with the button", async () => {
    const onClose = vi.fn();
    render(<SafetyNumberModal open onClose={onClose} selfUser={self} peer={peer} />);
    await page.getByRole("button", { name: "Close" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("closes with Escape", async () => {
    const onClose = vi.fn();
    render(<SafetyNumberModal open onClose={onClose} selfUser={self} peer={peer} />);
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("renders nothing when closed", async () => {
    render(<SafetyNumberModal open={false} onClose={() => {}} selfUser={self} peer={peer} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(services.api.listMyDevices).not.toHaveBeenCalled();
  });
});

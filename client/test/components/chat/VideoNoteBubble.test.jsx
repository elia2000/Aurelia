import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { makeIdentity } from "../../e2ee/helpers.js";
import { encryptVideoNote } from "../../../src/e2ee/videoNoteCrypto.js";
import { randomBytes } from "../../../src/e2ee/encoding.js";

const mocks = vi.hoisted(() => ({ services: null, fetchCiphertext: vi.fn() }));
vi.mock("../../../src/e2ee/services.js", () => ({ getE2eeServices: () => mocks.services }));
vi.mock("../../../src/api/e2eeApi.js", () => ({ fetchCiphertext: (...args) => mocks.fetchCiphertext(...args) }));

import VideoNoteBubble from "../../../src/components/chat/videoNote/VideoNoteBubble.jsx";
import { clearRememberedVideoNotes } from "../../../src/videoNote/localCache.js";

// A tiny valid JPEG-ish payload is enough: the poster is only handed to <img>.
const POSTER = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="), (c) => c.charCodeAt(0));

let alice;
let bob;
let sealed;

async function setup({ tamper = false } = {}) {
  clearRememberedVideoNotes();
  alice = await makeIdentity("alice");
  bob = await makeIdentity("bob");
  sealed = await encryptVideoNote({
    media: randomBytes(4000),
    mime: "video/webm",
    durationMs: 12_000,
    poster: POSTER,
    identity: alice.identity,
    recipients: [alice, bob].map((p) => ({ id: p.record.id, ecdhPublic: p.record.ecdhPublic })),
    context: { chatId: "chat-1", clientRequestId: "req-1", senderUserId: "alice" },
  });
  const cipher = new Uint8Array(sealed.ciphertext);
  if (tamper) cipher[5] ^= 1;
  mocks.fetchCiphertext.mockReset().mockResolvedValue(cipher);
  mocks.services = {
    getIdentity: async () => bob.identity,
    trust: { wasVerified: async () => false },
    directory: { findDevice: async (userId, deviceId) => (userId === "alice" && deviceId === alice.record.id ? alice.record : null) },
  };
  return {
    msg: { id: "m1", chat_id: "chat-1", client_request_id: "req-1", user_id: "alice", e2ee: sealed.envelope, files: [{ url: "/api/uploads/messages/x.bin" }] },
    user: { id: "bob", username: "bob" },
  };
}

beforeEach(() => {
  // The test media is random bytes: keep the element from really trying to load
  // it (a real load error is reported as "can't play", which has its own test).
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    configurable: true,
    get() {
      return this.getAttribute("data-test-src") || "";
    },
    set(value) {
      this.setAttribute("data-test-src", value);
    },
  });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue();
  HTMLMediaElement.prototype.pause = vi.fn();
});

describe("VideoNoteBubble", () => {
  test("shows the duration and a play button, and downloads nothing until it is pressed", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await expect.element(page.getByRole("button", { name: "Play video message, 0:12" })).toBeInTheDocument();
    await expect.element(page.getByText("0:12")).toBeInTheDocument();
    expect(mocks.fetchCiphertext).not.toHaveBeenCalled();
  });

  test("decrypts only the small poster in advance", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await vi.waitFor(() => {
      const img = document.querySelector("img");
      expect(img?.src.startsWith("blob:")).toBe(true);
    });
    expect(mocks.fetchCiphertext).not.toHaveBeenCalled();
  });

  test("pressing play downloads once, verifies, decrypts and starts the video", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await vi.waitFor(() => {
      const video = document.querySelector("video");
      expect(video?.src.startsWith("blob:")).toBe(true);
    });
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCiphertext.mock.calls[0][0]).toBe("/api/uploads/messages/x.bin");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
  });

  test("a second play reuses the decrypted copy", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    const button = page.getByRole("button", { name: /video message/ });
    await button.click();
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    await button.click(); // pause
    await button.click(); // play again
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(1);
  });

  test("a tampered file is refused with a clear explanation", async () => {
    const { msg, user } = await setup({ tamper: true });
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText(/could not be verified/)).toBeInTheDocument();
    expect(document.querySelector("video")?.src || "").not.toMatch(/^blob:/);
  });

  test("a message that was not encrypted for this device says so", async () => {
    const { msg, user } = await setup();
    const stranger = await makeIdentity("bob");
    mocks.services.getIdentity = async () => stranger.identity;
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText(/before this device was set up/)).toBeInTheDocument();
  });

  test("a missing file is reported", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={{ ...msg, files: [] }} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText("The video is no longer available.")).toBeInTheDocument();
  });

  test("when the browser blocks the first play (the tap was used up decrypting), one more tap plays and a hint says so", async () => {
    const { msg, user } = await setup();
    HTMLMediaElement.prototype.play = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("gesture"), { name: "NotAllowedError" }))
      .mockResolvedValue();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText("Ready. Tap again to play.")).toBeInTheDocument();
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(1);
    await page.getByRole("button", { name: /video message/ }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(1);
  });

  test("a video this device cannot play is reported instead of silently doing nothing", async () => {
    const { msg, user } = await setup();
    HTMLMediaElement.prototype.play = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("format"), { name: "NotSupportedError" }));
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText("This device can't play this video.")).toBeInTheDocument();
  });

  test("a message sent from a new device of the sender plays but points out the new device", async () => {
    const { msg, user } = await setup();
    mocks.services.directory.findDevice = async () => ({ ...alice.record, pending: true });
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText("Sent from a new device.")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Check" })).toBeInTheDocument();
  });

  test("a new device of a sender you verified blocks playback and explains how to continue", async () => {
    const { msg, user } = await setup();
    mocks.services.directory.findDevice = async () => ({ ...alice.record, pending: true });
    mocks.services.trust.wasVerified = async () => true;
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText(/security keys changed since you verified them/)).toBeInTheDocument();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
});

describe("VideoNoteBubble seek bullet", () => {
  // A bare <video> with a test source has no timeline: give it one.
  let positions;
  beforeEach(() => {
    positions = new WeakMap();
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get() {
        return positions.get(this) ?? 0;
      },
      set(value) {
        positions.set(this, Number(value));
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get: () => 12 });
  });

  async function loaded() {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await vi.waitFor(() => expect(document.querySelector("video")?.src.startsWith("blob:")).toBe(true));
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    const video = document.querySelector("video");
    const wrap = video.closest("div.relative");
    const rect = wrap.getBoundingClientRect();
    const scale = rect.width / 224;
    const R = (224 / 2 - 5 / 2) * scale; // ring radius on screen
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    // Where the ring is at a fraction of the way round, clockwise from the top.
    const at = (fraction) => ({
      clientX: center.x + R * Math.sin(2 * Math.PI * fraction),
      clientY: center.y - R * Math.cos(2 * Math.PI * fraction),
    });
    const fire = (target, type, point) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...point }));
    return { video, wrap, at, fire, center, R };
  }

  test("a bullet rides the ring and follows the playback position", async () => {
    const { video, wrap, R } = await loaded();
    positions.set(video, 3); // a quarter of 12 s
    video.dispatchEvent(new Event("timeupdate"));
    await vi.waitFor(() => expect(document.querySelector('[role="slider"]').getAttribute("aria-valuenow")).toBe("3"));
    await new Promise((r) => setTimeout(r, 400)); // (the bullet glides to its place)
    const bullet = document.querySelector('[data-testid="seek-bullet"]').getBoundingClientRect();
    const box = wrap.getBoundingClientRect(); // (measured now: the layout can shift while the poster loads)
    const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    // A quarter of the way round is the 3 o'clock position.
    expect(bullet.left + bullet.width / 2).toBeGreaterThan(center.x + R * 0.9);
    expect(Math.abs(bullet.top + bullet.height / 2 - center.y)).toBeLessThan(6);
    const slider = document.querySelector('[role="slider"]');
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    expect(slider.getAttribute("aria-valuemax")).toBe("12");
  });

  test("pressing the ring and dragging round seeks; the picture is not toggled", async () => {
    const { video, wrap, at, fire } = await loaded();
    const button = wrap.querySelector("button");
    HTMLMediaElement.prototype.pause.mockClear();
    fire(button, "pointerdown", at(0.25));
    expect(positions.get(video)).toBeCloseTo(3, 1);
    fire(wrap, "pointermove", at(0.5));
    expect(positions.get(video)).toBeCloseTo(6, 1);
    fire(wrap, "pointermove", at(0.75));
    expect(positions.get(video)).toBeCloseTo(9, 1);
    fire(wrap, "pointerup", at(0.75));
    button.click(); // the click that follows a drag is not a tap on the picture
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  });

  test("dragging past the top does not jump from the end back to the start", async () => {
    const { video, wrap, at, fire } = await loaded();
    fire(wrap, "pointerdown", at(0.9));
    expect(positions.get(video)).toBeCloseTo(10.8, 1);
    fire(wrap, "pointermove", at(0.02)); // carried on over the top
    expect(positions.get(video)).toBeCloseTo(12, 1); // stops at the end
    fire(wrap, "pointerup", at(0.02));
  });

  test("a tap on the picture (inside the ring) still plays and pauses", async () => {
    const { wrap, fire, center } = await loaded();
    const button = wrap.querySelector("button");
    HTMLMediaElement.prototype.pause.mockClear();
    fire(button, "pointerdown", { clientX: center.x, clientY: center.y });
    fire(wrap, "pointerup", { clientX: center.x, clientY: center.y });
    button.click();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  });

  test("the ring cannot be sought before the video has been loaded", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    const wrap = document.querySelector("video").closest("div.relative");
    const rect = wrap.getBoundingClientRect();
    wrap.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        clientX: rect.left + rect.width / 2 + rect.width / 2 - 3,
        clientY: rect.top + rect.height / 2,
      }),
    );
    expect(mocks.fetchCiphertext).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="seek-bullet"]')).toBeNull();
    expect(document.querySelector('[role="slider"]')?.getAttribute("tabindex") ?? "-1").toBe("-1");
  });

  test("the arrow keys move the position by five seconds", async () => {
    const { video } = await loaded();
    const slider = document.querySelector('[role="slider"]');
    slider.focus();
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(positions.get(video)).toBeCloseTo(5, 1);
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(positions.get(video)).toBeCloseTo(0, 1);
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(positions.get(video)).toBeCloseTo(12, 1);
  });
});

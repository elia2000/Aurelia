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

// Most tests are about what a tap does, so autoplay is off (as it is for someone who
// asked for less motion); the autoplay tests turn it on.
const setMotion = (reduce) => {
  window.matchMedia = (query) => ({
    matches: reduce && query.includes("reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
};

beforeEach(() => {
  setMotion(true);
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
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
    const scale = rect.width / 240;
    const R = (240 / 2 - 3 / 2 - 2) * scale; // ring radius on screen
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

// ── how it looks and behaves, like Telegram's round video message ──
const circle = () => document.querySelector("[data-video-note] [style*='aspect-ratio']");
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

describe("VideoNoteBubble layout", () => {
  test("it is the circle alone: 240 px wide on a computer, 70% of a narrow screen on a phone", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    const root = document.querySelector("[data-video-note]");
    expect(root.getBoundingClientRect().width).toBe(240);
    expect(circle().getBoundingClientRect().height).toBe(240);
    await page.viewport(300, 700);
    await expect.poll(() => root.getBoundingClientRect().width).toBe(210);
    expect(circle().getBoundingClientRect().height).toBe(210);
    await page.viewport(414, 896);
  });

  test("the length is on a pill over the circle, with a muted speaker while the sound is off, and a lock says it is encrypted", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    const pill = document.querySelector("[data-video-note-duration]");
    expect(pill.textContent).toBe("0:12");
    expect(circle().contains(pill)).toBe(true);
    await expect.element(page.getByRole("img", { name: "Sound off" })).toBeInTheDocument();
    await expect.element(page.getByRole("img", { name: "End-to-end encrypted" })).toBeInTheDocument();
  });

  test("playing counts the length down, takes the muted speaker away and shows the ring", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    const pill = document.querySelector("[data-video-note-duration]");
    expect(pill.textContent).toBe("0:12");
    expect(document.querySelector('[role="img"][aria-label="Sound off"]')).toBeNull();
    const video = document.querySelector("video");
    Object.defineProperty(video, "currentTime", { configurable: true, value: 3 });
    Object.defineProperty(video, "duration", { configurable: true, value: 12 });
    video.dispatchEvent(new Event("timeupdate"));
    await vi.waitFor(() => expect(pill.textContent).toBe("0:09"));
    expect(document.querySelector('[data-testid="seek-bullet"]')).not.toBeNull();
  });

  test("the name, a forwarded-from line or a quoted message go above the circle as a compact chip", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} header={<span>Carol</span>} />);
    await expect.element(page.getByText("Carol")).toBeInTheDocument();
    const chip = document.querySelector("[data-video-note-header]");
    expect(chip.textContent).toBe("Carol");
    expect(chip.getBoundingClientRect().bottom).toBeLessThanOrEqual(circle().getBoundingClientRect().top);
    // It never makes the message wider than the circle.
    expect(chip.getBoundingClientRect().width).toBeLessThanOrEqual(240);
  });

  test("a long quote does not widen the message beyond the circle", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} header={<p>{"a very long quoted line ".repeat(20)}</p>} />);
    await expect.element(page.getByText(/a very long quoted line/)).toBeInTheDocument();
    expect(document.querySelector("[data-video-note]").getBoundingClientRect().width).toBe(240);
  });

  test("nothing sits below the circle, so the message time can lie over its corner", async () => {
    const { msg, user } = await setup();
    mocks.services.directory.findDevice = async () => ({ ...alice.record, pending: true });
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText("Sent from a new device.")).toBeInTheDocument();
    const root = document.querySelector("[data-video-note]");
    expect(Math.round(circle().getBoundingClientRect().bottom)).toBe(Math.round(root.getBoundingClientRect().bottom));
  });

  test("the message time chip is brought in over the circle's lower right rim, not left in the empty corner", async () => {
    const { msg, user } = await setup();
    // (the message draws the chip itself: it is absolutely placed in the corner of its bubble)
    render(
      <div data-message-bubble style={{ position: "relative", width: "fit-content" }}>
        <VideoNoteBubble msg={msg} user={user} />
        <span data-message-meta="overlay" style={{ position: "absolute", display: "inline-block", width: 56, height: 18 }}>
          15:14
        </span>
      </div>,
    );
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    const ring = circle().getBoundingClientRect();
    const chip = document.querySelector("[data-message-meta]").getBoundingClientRect();
    const radius = ring.width / 2;
    const centre = { x: ring.left + radius, y: ring.top + radius };
    const dist = (x, y) => Math.hypot(x - centre.x, y - centre.y);
    // Its middle is on the circle and its right end is at the rim: it overlays the circle.
    expect(dist(chip.left + chip.width / 2, chip.top + chip.height / 2)).toBeLessThan(radius);
    expect(dist(chip.right, chip.bottom)).toBeGreaterThan(radius * 0.95);
    // It is at the bottom right, and still inside the message's box.
    expect(chip.left).toBeGreaterThan(centre.x);
    expect(chip.top).toBeGreaterThan(centre.y);
    expect(chip.right).toBeLessThanOrEqual(ring.right);
    expect(chip.bottom).toBeLessThanOrEqual(ring.bottom);
  });
});

describe("VideoNoteBubble loading and failing", () => {
  test("while the poster is being decrypted the circle is a neutral placeholder with a spinner", async () => {
    const { msg, user } = await setup();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const identity = mocks.services.getIdentity;
    mocks.services.getIdentity = async () => {
      await gate;
      return identity();
    };
    render(<VideoNoteBubble msg={msg} user={user} />);
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    expect(document.querySelector("svg.animate-spin")).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
    release();
    await vi.waitFor(() => expect(document.querySelector("img")?.src.startsWith("blob:")).toBe(true));
    expect(document.querySelector("svg.animate-spin")).toBeNull();
  });

  test("while the video downloads the circle shows a spinner and is busy", async () => {
    const { msg, user } = await setup();
    let release;
    const cipher = new Uint8Array(sealed.ciphertext);
    mocks.fetchCiphertext.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(cipher);
        }),
    );
    render(<VideoNoteBubble msg={msg} user={user} />);
    await vi.waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector("svg.animate-spin")).not.toBeNull();
    release();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    expect(document.querySelector("svg.animate-spin")).toBeNull();
  });

  test("a failure is explained on the circle, with a button that tries again", async () => {
    const { msg, user } = await setup({ tamper: true });
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText(/could not be verified/)).toBeInTheDocument();
    expect(circle().contains(document.querySelector('[role="alert"]'))).toBe(true);
    // The same file again, as it was sent.
    const good = new Uint8Array(sealed.ciphertext);
    mocks.fetchCiphertext.mockResolvedValue(good);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(2);
  });

  test("a failure shows the explanation, not a spinner, even while the little poster is still being decrypted", async () => {
    const { msg, user } = await setup();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const identity = mocks.services.getIdentity;
    let calls = 0;
    mocks.services.getIdentity = async () => {
      calls += 1;
      if (calls === 1) await gate; // the poster's decryption is slow
      return identity();
    };
    mocks.fetchCiphertext.mockRejectedValueOnce(new Error("network"));
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText("Could not load this video message.")).toBeInTheDocument();
    expect(document.querySelector("svg.animate-spin")).toBeNull();
    release();
  });

  test("a download that fails for lack of network says so and can be retried", async () => {
    const { msg, user } = await setup();
    mocks.fetchCiphertext.mockRejectedValueOnce(new Error("network"));
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByText("Could not load this video message.")).toBeInTheDocument();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
  });

  test("a copy the device has dropped from memory is fetched again instead of playing a dead address", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    const first = document.querySelector("video").src;
    await page.getByRole("button", { name: /Pause video message/ }).click();
    clearRememberedVideoNotes(); // (what making room for newer copies does)
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(2);
    expect(document.querySelector("video").src).not.toBe(first);
  });
});

describe("VideoNoteBubble playing by itself", () => {
  beforeEach(() => setMotion(false));

  test("on screen it downloads, then plays muted and looping, with no ring and the muted speaker showing", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    const video = document.querySelector("video");
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(document.querySelector('[data-testid="seek-bullet"]')).toBeNull();
    await expect.element(page.getByRole("img", { name: "Sound off" })).toBeInTheDocument();
    // Still the "play" button: a tap is what gives it sound.
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
  });

  test("a tap plays it from the start with sound and the ring, the next pauses it, the next carries on", async () => {
    const { msg, user } = await setup();
    let at = 0;
    render(<VideoNoteBubble msg={msg} user={user} />);
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    const video = document.querySelector("video");
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => at,
      set: (v) => {
        at = v;
      },
    });
    at = 7; // the loop is somewhere in the middle
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    expect(at).toBe(0);
    expect(video.muted).toBe(false);
    expect(video.loop).toBe(false);
    expect(document.querySelector('[role="img"][aria-label="Sound off"]')).toBeNull();
    expect(document.querySelector('[data-testid="seek-bullet"]')).not.toBeNull();

    at = 4;
    HTMLMediaElement.prototype.pause.mockClear();
    await page.getByRole("button", { name: /Pause video message/ }).click();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    expect(document.querySelector('[data-testid="seek-bullet"]')).not.toBeNull(); // the ring stays where it is

    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    expect(at).toBe(4); // carried on, not restarted
    expect(video.muted).toBe(false);
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(1);
  });

  test("a tap while the file is still coming in plays it with sound as soon as it is there", async () => {
    const { msg, user } = await setup();
    const cipher = new Uint8Array(sealed.ciphertext);
    let release;
    mocks.fetchCiphertext.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(cipher);
        }),
    );
    render(<VideoNoteBubble msg={msg} user={user} />);
    await vi.waitFor(() => expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(1));
    await page.getByRole("button", { name: /Play video message/ }).click();
    release();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    expect(document.querySelector("video").muted).toBe(false);
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(1);
  });

  test("when it ends it goes back to the quiet muted loop", async () => {
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
    const video = document.querySelector("video");
    HTMLMediaElement.prototype.play.mockClear();
    video.dispatchEvent(new Event("ended"));
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(document.querySelector('[data-testid="seek-bullet"]')).toBeNull();
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()); // looping again
  });

  test("only while it is on screen: below the fold nothing is downloaded, and it starts once scrolled into view", async () => {
    const { msg, user } = await setup();
    render(
      <div>
        <div style={{ height: 3000 }} />
        <VideoNoteBubble msg={msg} user={user} />
      </div>,
    );
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    await settle();
    expect(mocks.fetchCiphertext).not.toHaveBeenCalled();
    document.querySelector("[data-video-note]").scrollIntoView({ block: "center" });
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    HTMLMediaElement.prototype.pause.mockClear();
    Object.defineProperty(document.querySelector("video"), "paused", { configurable: true, get: () => false });
    window.scrollTo(0, 0);
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled());
  });

  test("a person who asked for less motion gets no autoplay, only the play button", async () => {
    setMotion(true);
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    await settle();
    expect(mocks.fetchCiphertext).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  test("data saver turns autoplay off, and a tap still plays it", async () => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true, effectiveType: "4g" } });
    const { msg, user } = await setup();
    render(<VideoNoteBubble msg={msg} user={user} />);
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
    await settle();
    expect(mocks.fetchCiphertext).not.toHaveBeenCalled();
    await page.getByRole("button", { name: /Play video message/ }).click();
    await expect.element(page.getByRole("button", { name: /Pause video message/ })).toBeInTheDocument();
  });

  test("a file that fails to arrive for autoplay is explained once and not tried again by itself", async () => {
    const { msg, user } = await setup({ tamper: true });
    render(<VideoNoteBubble msg={msg} user={user} />);
    await expect.element(page.getByText(/could not be verified/)).toBeInTheDocument();
    await settle(900);
    expect(mocks.fetchCiphertext).toHaveBeenCalledTimes(1);
  });

  test("a browser that refuses the muted start leaves the poster and the play button, with no error", async () => {
    const { msg, user } = await setup();
    HTMLMediaElement.prototype.play = vi.fn().mockRejectedValue(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    render(<VideoNoteBubble msg={msg} user={user} />);
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    await settle(300);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await expect.element(page.getByRole("button", { name: /Play video message/ })).toBeInTheDocument();
  });
});

describe("VideoNoteBubble: one with sound at a time", () => {
  test("playing a second one pauses the first, which keeps its place", async () => {
    const { msg, user } = await setup();
    const second = await sealed2(msg);
    render(
      <div>
        <VideoNoteBubble msg={msg} user={user} />
        <VideoNoteBubble msg={second} user={user} />
      </div>,
    );
    const buttons = () => [...document.querySelectorAll("[data-video-note] button[aria-label*='video message']")];
    await vi.waitFor(() => expect(buttons()).toHaveLength(2));
    buttons()[0].click();
    await vi.waitFor(() => expect(buttons()[0].getAttribute("aria-label")).toMatch(/^Pause/));
    buttons()[1].click();
    await vi.waitFor(() => expect(buttons()[1].getAttribute("aria-label")).toMatch(/^Pause/));
    expect(buttons()[0].getAttribute("aria-label")).toMatch(/^Play/);
    expect(document.querySelectorAll('[data-video-note] [data-testid="seek-bullet"]')).toHaveLength(2); // both are past their start
  });
});

// A second message from the same sender to the same people.
async function sealed2(first) {
  const again = await encryptVideoNote({
    media: randomBytes(3000),
    mime: "video/webm",
    durationMs: 8_000,
    poster: POSTER,
    identity: alice.identity,
    recipients: [alice, bob].map((p) => ({ id: p.record.id, ecdhPublic: p.record.ecdhPublic })),
    context: { chatId: "chat-1", clientRequestId: "req-2", senderUserId: "alice" },
  });
  const cipher = new Uint8Array(again.ciphertext);
  const firstCipher = new Uint8Array(sealed.ciphertext);
  mocks.fetchCiphertext.mockImplementation(async (url) => (url.endsWith("y.bin") ? cipher : firstCipher));
  return {
    ...first,
    id: "m2",
    client_request_id: "req-2",
    e2ee: again.envelope,
    files: [{ url: "/api/uploads/messages/y.bin" }],
  };
}

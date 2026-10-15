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
  });
  const cipher = new Uint8Array(sealed.ciphertext);
  if (tamper) cipher[5] ^= 1;
  mocks.fetchCiphertext.mockReset().mockResolvedValue(cipher);
  mocks.services = {
    getIdentity: async () => bob.identity,
    directory: { findDevice: async (userId, deviceId) => (userId === "alice" && deviceId === alice.record.id ? alice.record : null) },
  };
  return {
    msg: { id: "m1", clientRequestId: `c-${Math.random()}`, user_id: "alice", e2ee: sealed.envelope, files: [{ url: "/api/uploads/messages/x.bin" }] },
    user: { id: "bob", username: "bob" },
  };
}

beforeEach(() => {
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
});

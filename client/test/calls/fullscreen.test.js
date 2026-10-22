import { describe, test, expect, vi } from "vitest";
import { exitFullscreen, fullscreenSupported, isFullscreen, toggleFullscreen } from "../../src/calls/fullscreen.js";

const doc = (extra = {}) => ({ fullscreenEnabled: true, fullscreenElement: null, exitFullscreen: vi.fn(async () => {}), ...extra });
const card = (extra = {}) => ({ requestFullscreen: vi.fn(async () => {}), ...extra });

describe("fullscreenSupported", () => {
  test("follows what the browser says", () => {
    expect(fullscreenSupported(doc())).toBe(true);
    expect(fullscreenSupported(doc({ fullscreenEnabled: false }))).toBe(false); // an iPhone, a frame that may not
    expect(fullscreenSupported(doc({ fullscreenEnabled: undefined, webkitFullscreenEnabled: true }))).toBe(true);
    expect(fullscreenSupported(null)).toBe(false);
  });
});

describe("toggleFullscreen", () => {
  test("puts the card in full screen", async () => {
    const c = card();
    expect(await toggleFullscreen(c, doc())).toBe("entered");
    expect(c.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  test("takes it out again", async () => {
    const c = card();
    const d = doc({ fullscreenElement: c });
    expect(isFullscreen(c, d)).toBe(true);
    expect(await toggleFullscreen(c, d)).toBe("left");
    expect(d.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(c.requestFullscreen).not.toHaveBeenCalled();
  });

  test("uses the WebKit names where that is all there is", async () => {
    const c = { webkitRequestFullscreen: vi.fn(async () => {}) };
    expect(await toggleFullscreen(c, doc({ fullscreenEnabled: undefined, webkitFullscreenEnabled: true }))).toBe("entered");
    expect(c.webkitRequestFullscreen).toHaveBeenCalled();
    const d = doc({ fullscreenEnabled: undefined, webkitFullscreenEnabled: true, fullscreenElement: undefined, webkitFullscreenElement: c, exitFullscreen: undefined, webkitExitFullscreen: vi.fn(async () => {}) });
    expect(await toggleFullscreen(c, d)).toBe("left");
    expect(d.webkitExitFullscreen).toHaveBeenCalled();
  });

  test("a refusal, an unsupported browser or no card is 'failed', never an error", async () => {
    await expect(toggleFullscreen(card({ requestFullscreen: vi.fn(async () => { throw new Error("no"); }) }), doc())).resolves.toBe("failed");
    await expect(toggleFullscreen(card(), doc({ fullscreenEnabled: false }))).resolves.toBe("failed");
    await expect(toggleFullscreen(null, doc())).resolves.toBe("failed");
  });
});

describe("exitFullscreen", () => {
  test("only leaves when the card is the one in full screen", async () => {
    const c = card();
    const d = doc({ fullscreenElement: c });
    expect(await exitFullscreen(c, d)).toBe(true);
    expect(d.exitFullscreen).toHaveBeenCalledTimes(1);
    const other = doc({ fullscreenElement: {} });
    expect(await exitFullscreen(c, other)).toBe(false);
    expect(other.exitFullscreen).not.toHaveBeenCalled();
  });
});

import { useEffect } from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { FocusedMediaModal } from "../../../src/components/chat/media/FocusedMediaModal.jsx";
import { useFocusedMedia } from "../../../src/hooks/chat/useFocusedMedia.js";
import { TINY_VIDEO_URL } from "./tinyVideo.js";

// The viewer wired up the way ChatWindowPanel wires it.
function Viewer({ media, isDesktop = true, isMobileTouchDevice = false, chromeIdleMs, onClosed }) {
  const f = useFocusedMedia({ isDesktop, isMobileTouchDevice });
  const { openFocusMedia } = f;
  useEffect(() => {
    openFocusMedia(media);
  }, [media, openFocusMedia]);
  useEffect(() => {
    if (!f.focusedMedia && onClosed) onClosed();
  }, [f.focusedMedia, onClosed]);
  return (
    <FocusedMediaModal
      focusedMedia={f.focusedMedia}
      isDesktop={isDesktop}
      focusVisible={f.focusVisible}
      closeFocusMedia={f.closeFocusMedia}
      isMobileTouchDevice={isMobileTouchDevice}
      handleFocusTouchStart={f.handleFocusTouchStart}
      handleFocusTouchEnd={f.handleFocusTouchEnd}
      getFocusFrameStyle={f.getFocusFrameStyle}
      focusedVideoRef={f.focusedVideoRef}
      toggleFocusedVideoPlay={f.toggleFocusedVideoPlay}
      handleFocusedVideoLoadedMetadata={f.handleFocusedVideoLoadedMetadata}
      handleFocusedVideoLoadedData={f.handleFocusedVideoLoadedData}
      handleFocusedVideoCanPlay={f.handleFocusedVideoCanPlay}
      handleFocusedVideoError={f.handleFocusedVideoError}
      focusedMediaLoaded={f.focusedMediaLoaded}
      onFocusedImageLoad={() => f.setFocusedMediaLoaded(true)}
      focusedVideoHint={f.focusedVideoHint}
      focusedVideoDecodeIssue={f.focusedVideoDecodeIssue}
      focusedVideoPlaying={f.focusedVideoPlaying}
      focusedVideoMuted={f.focusedVideoMuted}
      toggleFocusedVideoMute={f.toggleFocusedVideoMute}
      focusedVideoDuration={f.focusedVideoDuration}
      focusedVideoTime={f.focusedVideoTime}
      seekFocusedVideo={f.seekFocusedVideo}
      formatSeconds={f.formatSeconds}
      focusExpiryWarning={f.focusExpiryWarning}
      getFocusAspectRatio={f.getFocusAspectRatio}
      chromeIdleMs={chromeIdleMs}
    />
  );
}

const video = (extra = {}) => ({
  url: TINY_VIDEO_URL,
  downloadUrl: TINY_VIDEO_URL,
  name: "clip.webm",
  type: "video",
  width: 64,
  height: 64,
  ...extra,
});

const IMAGE_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// Every part of the viewer that is not the picture.
const chromes = () => [...document.querySelectorAll("[data-viewer-chrome]")];
const chromeHidden = () => {
  const all = chromes();
  return all.length > 0 && all.every((el) => el.hasAttribute("inert"));
};
const chromeShown = () => {
  const all = chromes();
  return all.length > 0 && all.every((el) => !el.hasAttribute("inert"));
};
const picture = () => document.querySelector("video");

const ready = async () => {
  await vi.waitFor(() => expect(picture()).not.toBeNull());
  await expect.element(page.getByRole("button", { name: "Close" })).toBeInTheDocument();
  await expect.poll(chromeShown).toBe(true);
};

// The video may or may not have started by itself (the browser decides); make it play.
const startPlaying = async () => {
  await vi.waitFor(() => expect(picture().readyState).toBeGreaterThan(0));
  if (picture().paused) await userEvent.click(page.getByRole("button", { name: "Play" }));
  await expect.poll(() => picture().paused).toBe(false);
};

const dispatchPointer = (el, type, pointerType = "mouse") =>
  el.dispatchEvent(new PointerEvent(type, { pointerType, bubbles: true, cancelable: true, isPrimary: true }));

beforeEach(() => {
  window.history.replaceState({}, "");
});

describe("FocusedMediaModal chrome on a computer", () => {
  test("a click on the picture hides the close and save buttons and the play bar, and the next click brings them back", async () => {
    render(<Viewer media={video()} />);
    await ready();
    await expect.element(page.getByLabelText("Seek video")).toBeInTheDocument();
    await userEvent.click(picture());
    await expect.poll(chromeHidden).toBe(true);
    // Nothing of it can be reached while it is out of the way.
    expect(document.querySelector('a[download]').closest("[data-viewer-chrome]").hasAttribute("inert")).toBe(true);
    await userEvent.click(picture());
    await expect.poll(chromeShown).toBe(true);
  });

  test("what a click hid stays hidden when the mouse moves; a key press brings it back", async () => {
    render(<Viewer media={video()} />);
    await ready();
    await userEvent.click(picture());
    await expect.poll(chromeHidden).toBe(true);
    await userEvent.hover(document.body);
    dispatchPointer(picture(), "pointermove");
    dispatchPointer(picture(), "pointermove");
    await new Promise((r) => setTimeout(r, 120));
    expect(chromeHidden()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
    await expect.poll(chromeShown).toBe(true);
  });

  test("while the video plays the buttons hide when the mouse rests, and a mouse move brings them back", async () => {
    render(<Viewer media={video()} chromeIdleMs={150} />);
    await ready();
    await startPlaying();
    await expect.poll(chromeHidden, { timeout: 3000 }).toBe(true);
    dispatchPointer(picture(), "pointermove");
    await expect.poll(chromeShown).toBe(true);
    await expect.poll(chromeHidden, { timeout: 3000 }).toBe(true);
  });

  test("they hide after about three seconds of rest by default", async () => {
    render(<Viewer media={video()} />);
    await ready();
    await startPlaying();
    const started = Date.now();
    await expect.poll(chromeHidden, { timeout: 5000 }).toBe(true);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThan(2000);
    expect(waited).toBeLessThan(4500);
  });

  test("a paused video keeps its buttons", async () => {
    render(<Viewer media={video()} chromeIdleMs={100} />);
    await ready();
    picture().pause();
    await new Promise((r) => setTimeout(r, 450));
    expect(chromeShown()).toBe(true);
  });

  test("the play button and the seek bar keep working and keep the buttons on screen", async () => {
    render(<Viewer media={video()} chromeIdleMs={60_000} />);
    await ready();
    await startPlaying();
    await page.getByRole("button", { name: "Pause" }).click();
    await expect.poll(() => picture().paused).toBe(true);
    await page.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => picture().paused).toBe(false);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect.poll(() => picture().paused).toBe(true);
    const seek = document.querySelector('input[aria-label="Seek video"]');
    await expect.poll(() => seek.max).not.toBe("0");
    const before = picture().currentTime;
    seek.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => picture().currentTime).toBeGreaterThan(before);
    expect(chromeShown()).toBe(true);
  });

  test("the buttons stay while the mouse rests on them", async () => {
    render(<Viewer media={video()} chromeIdleMs={120} />);
    await ready();
    await startPlaying();
    const close = page.getByRole("button", { name: "Close" }).element();
    dispatchPointer(close, "pointermove");
    await new Promise((r) => setTimeout(r, 500));
    expect(chromeShown()).toBe(true);
    dispatchPointer(picture(), "pointermove");
    await expect.poll(chromeHidden, { timeout: 3000 }).toBe(true);
  });

  test("a button with keyboard focus keeps the buttons on screen", async () => {
    render(<Viewer media={video()} chromeIdleMs={120} />);
    await ready();
    await startPlaying();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.closest("[data-viewer-chrome]")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 500));
    expect(chromeShown()).toBe(true);
    document.activeElement.blur();
    await expect.poll(chromeHidden, { timeout: 3000 }).toBe(true);
  });

  test("Escape closes the viewer and nothing behind it", async () => {
    const closed = vi.fn();
    const behind = vi.fn();
    document.addEventListener("keydown", behind);
    try {
      render(<Viewer media={video()} onClosed={closed} />);
      await ready();
      closed.mockClear();
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => closed.mock.calls.length).toBeGreaterThan(0);
      await expect.poll(() => picture()).toBeNull();
      expect(behind).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", behind);
    }
  });

  test("Escape closes it even when the buttons are out of the way", async () => {
    const closed = vi.fn();
    render(<Viewer media={video()} onClosed={closed} />);
    await ready();
    await userEvent.click(picture());
    await expect.poll(chromeHidden).toBe(true);
    closed.mockClear();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => picture()).toBeNull();
  });

  test("Space plays and pauses, since a click on the picture no longer does", async () => {
    render(<Viewer media={video()} chromeIdleMs={60_000} />);
    await ready();
    await startPlaying();
    picture().pause();
    await expect.poll(() => picture().paused).toBe(true);
    await userEvent.click(picture());
    expect(picture().paused).toBe(true); // the click only toggled the buttons
    document.body.focus();
    await userEvent.keyboard(" ");
    await expect.poll(() => picture().paused).toBe(false);
    await userEvent.keyboard(" ");
    await expect.poll(() => picture().paused).toBe(true);
  });

  test("a click outside the picture still closes the viewer", async () => {
    const closed = vi.fn();
    render(<Viewer media={video()} onClosed={closed} />);
    await ready();
    closed.mockClear();
    const backdrop = picture().closest(".fixed");
    backdrop.click();
    await expect.poll(() => closed.mock.calls.length).toBeGreaterThan(0);
  });

  test("a video that cannot be played keeps its buttons, so there is a way out", async () => {
    render(<Viewer media={video({ url: "data:video/webm;base64,AAAA", downloadUrl: "data:video/webm;base64,AAAA" })} chromeIdleMs={100} />);
    await expect.element(page.getByText(/not supported by your browser|could not be decoded/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 450));
    expect(chromeShown()).toBe(true);
  });

  test("a picture is not affected: the buttons stay and clicking it does nothing", async () => {
    render(<Viewer media={{ url: IMAGE_URL, name: "x.gif", type: "image", width: 1, height: 1 }} chromeIdleMs={100} />);
    await expect.element(page.getByRole("button", { name: "Close" })).toBeInTheDocument();
    const img = document.querySelector("img");
    img.click();
    await new Promise((r) => setTimeout(r, 450));
    const close = page.getByRole("button", { name: "Close" }).element();
    expect(close.closest("[data-viewer-chrome]").hasAttribute("inert")).toBe(false);
  });

  test("the next video starts with the buttons showing", async () => {
    const first = video();
    const second = video({ name: "other.webm", url: `${TINY_VIDEO_URL}#2` });
    const screen = await render(<Viewer media={first} />);
    await ready();
    await userEvent.click(picture());
    await expect.poll(chromeHidden).toBe(true);
    await screen.rerender(<Viewer media={second} />);
    await expect.poll(chromeShown).toBe(true);
  });
});

describe("FocusedMediaModal chrome on a phone", () => {
  test("a tap on the picture hides the buttons and the next tap brings them back", async () => {
    render(<Viewer media={video()} isDesktop={false} isMobileTouchDevice />);
    await ready();
    picture().click();
    await expect.poll(chromeHidden).toBe(true);
    picture().click();
    await expect.poll(chromeShown).toBe(true);
  });

  test("a tap on a button does its job and hides nothing", async () => {
    render(<Viewer media={video()} isDesktop={false} isMobileTouchDevice chromeIdleMs={60_000} />);
    await ready();
    await expect.poll(() => picture().readyState).toBeGreaterThan(0);
    const before = picture().paused;
    await page.getByRole("button", { name: before ? "Play" : "Pause" }).click();
    await expect.poll(() => picture().paused).toBe(!before);
    expect(chromeShown()).toBe(true);
  });
});

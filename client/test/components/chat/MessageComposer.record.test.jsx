import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { MessageComposer } from "../../../src/components/chat/messages/MessageComposer.jsx";
import {
  installFakeMicrophone,
  pointer,
  restoreMicrophone,
  sleep,
  waitUntil,
} from "./recordTestUtils.js";

// The composer's one primary button: send when there is something to send,
// otherwise record (a tap switches voice / video, a hold records, a release
// sends), and the paperclip that gets out of the way while typing.

const BASE_PROPS = {
  activeChatId: 1,
  isDesktop: true,
  handleSend: vi.fn(),
  onComposerResize: vi.fn(),
  replyTarget: null,
  onClearReply: vi.fn(),
  editTarget: null,
  onClearEdit: vi.fn(),
  pendingUploadFiles: [],
  pendingUploadType: "media",
  pendingVoiceMessage: null,
  fileUploadEnabled: true,
  mediaInputRef: { current: null },
  documentInputRef: { current: null },
  onClearPendingUploads: vi.fn(),
  onRemovePendingUpload: vi.fn(),
  onUploadFilesSelected: vi.fn(),
  onVoiceRecorded: vi.fn(),
  onClearPendingVoiceMessage: vi.fn(),
  uploadError: null,
  activeUploadProgress: null,
  messageMaxChars: null,
  onMessageInput: vi.fn(),
  uploadBusy: false,
  showUploadMenu: false,
  setShowUploadMenu: vi.fn(),
  uploadMenuRef: { current: null },
  handleVideoThumbLoadedMetadata: vi.fn(),
  onComposerHeightChange: vi.fn(),
  onComposerFocusChange: vi.fn(),
  composerInputRef: null,
  microphonePermissionStatus: "granted",
  onRequestMicrophonePermission: vi.fn(),
  onSendVideoNote: vi.fn(),
};

// What the chat page does with a recorded voice message: it keeps it as the
// pending one, and the composer then submits the form.
function Harness({ onVoiceRecorded, handleSend, ...props }) {
  const [voice, setVoice] = useState(null);
  return (
    <MessageComposer
      {...BASE_PROPS}
      {...props}
      pendingVoiceMessage={voice}
      onVoiceRecorded={(payload) => {
        onVoiceRecorded?.(payload);
        setVoice({ id: "voice-1", ...payload });
      }}
      handleSend={(event) => {
        event.preventDefault();
        handleSend?.(event);
        setVoice(null);
      }}
    />
  );
}

const primary = () => document.querySelector("button[data-variant]");
const recordingBar = () => document.querySelector("[data-recording]");
const textbox = () => page.getByRole("textbox", { name: /type a message/i });
const attachButton = () => page.getByRole("button", { name: "Attach file" });
const inlineHint = () => document.querySelector("p[role='status'], p[role='alert']");

let mic;
beforeEach(() => {
  try {
    localStorage.removeItem("aurelle-record-mode");
  } catch (_) {
    // not available
  }
  mic = installFakeMicrophone();
});
afterEach(() => {
  restoreMicrophone();
  vi.clearAllMocks();
});

describe("the one primary button", () => {
  test("is the record button when the field is empty, and there is no separate camera button", async () => {
    await render(<Harness />);
    await expect
      .element(page.getByRole("button", { name: "Record voice message. Tap to switch to video message" }))
      .toBeInTheDocument();
    expect(primary().dataset.variant).toBe("record");
    expect(primary().dataset.recordMode).toBe("voice");
    expect(document.querySelectorAll("[data-record-mode]")).toHaveLength(1);
    expect(page.getByRole("button", { name: /^Record video message/ }).elements()).toHaveLength(0);
  });

  test("a browser that cannot record video messages only offers voice", async () => {
    await render(<Harness onSendVideoNote={null} />);
    await expect
      .element(page.getByRole("button", { name: "Record voice message", exact: true }))
      .toBeInTheDocument();
  });

  test("is the send button when there is text, pending files, a pending voice message, or an edit", async () => {
    const { rerender } = await render(<Harness />);
    await textbox().fill("hi");
    expect(primary().dataset.variant).toBe("send");
    await expect.element(page.getByRole("button", { name: "Send message" })).toBeEnabled();

    await textbox().fill("");
    expect(primary().dataset.variant).toBe("record");

    await rerender(
      <Harness
        pendingUploadFiles={[{ id: "f1", name: "a.png", mimeType: "image/png", previewUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }]}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Send message" })).toBeEnabled();

    await rerender(<Harness editTarget={{ id: 5, body: "old text" }} />);
    await expect.element(page.getByRole("button", { name: "Save edit" })).toBeEnabled();
  });

  test("a message of only spaces swaps in Send but still cannot be sent", async () => {
    await render(<Harness />);
    await textbox().fill(" ");
    expect(primary().dataset.variant).toBe("send");
    await expect.element(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await textbox().fill("a");
    await expect.element(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  test("sits at the end of the row, after the text field and the paperclip", async () => {
    await render(<Harness />);
    const field = textbox().element();
    const clip = attachButton().element();
    const emoji = page.getByRole("button", { name: "Emoji" }).element();
    const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(emoji, field)).toBe(true);
    expect(follows(field, clip)).toBe(true);
    expect(follows(clip, primary())).toBe(true);
  });
});

describe("the paperclip", () => {
  test("goes away with the first character, even a space, and comes back when the field is emptied", async () => {
    await render(<Harness />);
    await expect.element(attachButton()).toBeInTheDocument();

    await textbox().fill(" ");
    await expect.element(attachButton()).not.toBeInTheDocument();
    // It collapses instead of being removed, so nothing around it jumps.
    const wrapper = document.querySelector("[data-visible]");
    expect(wrapper.dataset.visible).toBe("false");
    expect(wrapper.inert).toBe(true);

    await textbox().fill("");
    await expect.element(attachButton()).toBeInTheDocument();
    expect(document.querySelector("[data-visible]").inert).toBe(false);

    await textbox().fill("x");
    await expect.element(attachButton()).not.toBeInTheDocument();
  });

  test("pending files do not hide it, so more can be added", async () => {
    await render(
      <Harness
        pendingUploadFiles={[{ id: "f1", name: "a.png", mimeType: "image/png", previewUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }]}
      />,
    );
    await expect.element(attachButton()).toBeInTheDocument();
  });

  test("cannot take focus while it is collapsed", async () => {
    await render(<Harness />);
    await textbox().fill("a");
    await userEvent.tab();
    expect(document.activeElement?.getAttribute("aria-label")).not.toBe("Attach file");
  });
});

describe("a tap on the record button", () => {
  test("switches between voice and video, remembers it, and says how to record", async () => {
    await render(<Harness />);
    await userEvent.click(page.getByRole("button", { name: /^Record voice message/ }));
    await expect
      .element(page.getByRole("button", { name: "Record video message. Tap to switch to voice message" }))
      .toBeInTheDocument();
    expect(localStorage.getItem("aurelle-record-mode")).toBe("video");
    expect(inlineHint()?.textContent).toMatch(/Hold to record a video message/);
    expect(mic.getUserMedia).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: /^Record video message/ }));
    await expect
      .element(page.getByRole("button", { name: /^Record voice message/ }))
      .toBeInTheDocument();
    expect(localStorage.getItem("aurelle-record-mode")).toBe("voice");
  });

  test("its how-to-record hint is dropped as soon as typing swaps the button for Send", async () => {
    await render(<Harness />);
    await userEvent.click(page.getByRole("button", { name: /^Record voice message/ }));
    expect(inlineHint()?.textContent).toMatch(/Hold to record a video message/);
    await textbox().fill("a");
    expect(primary().dataset.variant).toBe("send");
    expect(inlineHint()).toBeNull();
  });

  test("starts in the mode that was left last time", async () => {
    localStorage.setItem("aurelle-record-mode", "video");
    await render(<Harness />);
    await expect
      .element(page.getByRole("button", { name: /^Record video message/ }))
      .toBeInTheDocument();
  });

  test("the keyboard switches the mode with Space or Enter", async () => {
    await render(<Harness />);
    primary().focus();
    await userEvent.keyboard(" ");
    await expect.element(page.getByRole("button", { name: /^Record video message/ })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("button", { name: /^Record voice message/ })).toBeInTheDocument();
  });

  test("announces the new mode to screen readers", async () => {
    await render(<Harness />);
    await userEvent.click(page.getByRole("button", { name: /^Record voice message/ }));
    const live = document.querySelector("form [aria-live='polite']");
    expect(live.textContent).toBe("Video message mode");
  });
});

describe("the record button is made for holding", () => {
  test("it never scrolls, selects text or opens the long-press menu", async () => {
    await render(<Harness />);
    const button = primary();
    const style = getComputedStyle(button);
    expect(style.touchAction).toBe("none");
    expect(style.userSelect).toBe("none");
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    button.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });
});

describe("the lock handle and the back-to-latest button", () => {
  test("the button steps aside while the record button is held, so the two never stack up", async () => {
    await render(
      <>
        <Harness />
        <button type="button" data-jump-latest>
          Back to latest message
        </button>
      </>,
    );
    const jump = document.querySelector("[data-jump-latest]");
    expect(getComputedStyle(jump).opacity).toBe("1");
    const finger = pointer(primary());
    finger.down();
    await waitUntil(() => recordingBar(), "recording bar");
    expect(getComputedStyle(jump).opacity).toBe("0");
    expect(getComputedStyle(jump).pointerEvents).toBe("none");
    finger.cancel();
    await waitUntil(() => getComputedStyle(jump).opacity === "1", "the button is back");
  });
});

describe("holding records a voice message", () => {
  test("releasing sends it right away", async () => {
    const onVoiceRecorded = vi.fn();
    const handleSend = vi.fn();
    await render(<Harness onVoiceRecorded={onVoiceRecorded} handleSend={handleSend} />);
    // The old "voice message waiting" bar must never flash up on the way,
    // or the composer would jump taller and shorter again.
    let pendingBarSeen = false;
    const watcher = new MutationObserver(() => {
      if ([...document.querySelectorAll("form span")].some((node) => node.textContent === "Voice message")) {
        pendingBarSeen = true;
      }
    });
    watcher.observe(document.body, { childList: true, subtree: true, characterData: true });
    const finger = pointer(primary());
    finger.down();
    await waitUntil(() => recordingBar(), "recording bar");
    expect(recordingBar().dataset.recording).toBe("voice");
    await expect.element(page.getByText("Slide to cancel")).toBeInTheDocument();
    // No text field while recording; the paperclip is gone with it.
    expect(page.getByRole("textbox").elements()).toHaveLength(0);
    expect(document.querySelector("form [aria-live='polite']").textContent).toBe("Recording voice message");
    await sleep(1300);
    finger.up();
    await vi.waitFor(() => expect(handleSend).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onVoiceRecorded).toHaveBeenCalledTimes(1);
    const payload = onVoiceRecorded.mock.calls[0][0];
    expect(payload.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(payload.file.name).toMatch(/^voice-message-/);
    await waitUntil(() => !recordingBar(), "back to the text field");
    await sleep(100);
    watcher.disconnect();
    expect(pendingBarSeen).toBe(false);
    expect(mic.allStopped()).toBe(true);
    await expect.element(textbox()).toBeInTheDocument();
  });

  test("a hold shorter than a second is not sent; a hint says to hold", async () => {
    const onVoiceRecorded = vi.fn();
    await render(<Harness onVoiceRecorded={onVoiceRecorded} />);
    const finger = pointer(primary());
    finger.down();
    await waitUntil(() => recordingBar(), "recording bar");
    await sleep(100);
    finger.up();
    await waitUntil(() => !recordingBar(), "recording to end");
    await vi.waitFor(() => expect(inlineHint()?.textContent).toMatch(/Hold to record a voice message/));
    expect(onVoiceRecorded).not.toHaveBeenCalled();
    expect(mic.allStopped()).toBe(true);
  });

  test("sliding left cancels: nothing is sent and the microphone is released", async () => {
    const onVoiceRecorded = vi.fn();
    await render(<Harness onVoiceRecorded={onVoiceRecorded} />);
    const finger = pointer(primary(), { pointerType: "touch" });
    finger.down();
    await waitUntil(() => recordingBar(), "recording bar");
    finger.moveBy(-40, 0);
    expect(recordingBar()).not.toBeNull(); // not far enough yet
    finger.moveBy(-110, 0);
    await waitUntil(() => !recordingBar(), "cancel");
    finger.up();
    await sleep(200);
    expect(onVoiceRecorded).not.toHaveBeenCalled();
    expect(mic.allStopped()).toBe(true);
    await expect.element(page.getByRole("button", { name: /^Record voice message/ })).toBeInTheDocument();
  });

  test("sliding up locks it: lifting the finger keeps recording, with delete, stop and send", async () => {
    const onVoiceRecorded = vi.fn();
    const handleSend = vi.fn();
    await render(<Harness onVoiceRecorded={onVoiceRecorded} handleSend={handleSend} />);
    const finger = pointer(primary(), { pointerType: "touch" });
    finger.down();
    await waitUntil(() => recordingBar(), "recording bar");
    finger.moveBy(0, -90);
    await waitUntil(() => recordingBar()?.dataset.locked === "true", "lock");
    finger.up();
    await sleep(500); // the lift must not count as a press on the Send button
    expect(handleSend).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Delete recording" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Send voice message" })).toBeInTheDocument();

    // Stop leads to a preview with play, delete and send.
    await sleep(600);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await expect.element(page.getByRole("button", { name: "Play preview" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Delete recording" })).toBeInTheDocument();
    expect(mic.allStopped()).toBe(true);
    await page.getByRole("button", { name: "Send voice message" }).click();
    await vi.waitFor(() => expect(handleSend).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  test("a locked recording can be deleted", async () => {
    const onVoiceRecorded = vi.fn();
    await render(<Harness onVoiceRecorded={onVoiceRecorded} />);
    const finger = pointer(primary(), { pointerType: "touch" });
    finger.down();
    await waitUntil(() => recordingBar(), "recording bar");
    finger.moveBy(0, -90);
    await waitUntil(() => recordingBar()?.dataset.locked === "true", "lock");
    finger.up();
    await page.getByRole("button", { name: "Delete recording" }).click();
    await waitUntil(() => !recordingBar(), "delete");
    expect(onVoiceRecorded).not.toHaveBeenCalled();
    expect(mic.allStopped()).toBe(true);
    await expect.element(page.getByRole("button", { name: /^Record voice message/ })).toBeInTheDocument();
  });

  test("Escape cancels", async () => {
    const onVoiceRecorded = vi.fn();
    await render(<Harness onVoiceRecorded={onVoiceRecorded} />);
    const finger = pointer(primary());
    finger.down();
    await waitUntil(() => recordingBar(), "recording bar");
    await userEvent.keyboard("{Escape}");
    await waitUntil(() => !recordingBar(), "cancel");
    finger.up();
    await sleep(200);
    expect(onVoiceRecorded).not.toHaveBeenCalled();
    expect(mic.allStopped()).toBe(true);
  });

  test("holding the Space key records and letting go sends", async () => {
    const handleSend = vi.fn();
    await render(<Harness handleSend={handleSend} />);
    const button = primary();
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await waitUntil(() => recordingBar(), "recording bar");
    await sleep(1300);
    button.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(handleSend).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });
});

describe("a recording never gets stuck", () => {
  const holdFor = async (ms, options) => {
    const finger = pointer(primary(), options);
    finger.down();
    await waitUntil(() => recordingBar(), "recording bar");
    await sleep(ms);
    return finger;
  };

  test("the browser taking the touch away (pointercancel) keeps the recording for review", async () => {
    const handleSend = vi.fn();
    await render(<Harness handleSend={handleSend} />);
    const finger = await holdFor(1300, { pointerType: "touch" });
    finger.cancel();
    await expect.element(page.getByRole("button", { name: "Play preview" })).toBeInTheDocument();
    expect(handleSend).not.toHaveBeenCalled();
    expect(mic.allStopped()).toBe(true);
    await page.getByRole("button", { name: "Delete recording" }).click();
    await expect.element(page.getByRole("button", { name: /^Record voice message/ })).toBeInTheDocument();
  });

  test("the window losing focus does too", async () => {
    await render(<Harness />);
    await holdFor(1300);
    window.dispatchEvent(new Event("blur"));
    await expect.element(page.getByRole("button", { name: "Play preview" })).toBeInTheDocument();
    expect(mic.allStopped()).toBe(true);
  });

  test("so does the page going to the background", async () => {
    await render(<Harness />);
    await holdFor(1300);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    hidden.mockRestore();
    await expect.element(page.getByRole("button", { name: "Play preview" })).toBeInTheDocument();
    expect(mic.allStopped()).toBe(true);
  });

  test("losing pointer capture while holding is handled the same way", async () => {
    await render(<Harness />);
    const finger = await holdFor(300);
    // (before the first second, so it ends as a too-short hold instead of a preview)
    window.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 7, bubbles: true }));
    await waitUntil(() => !recordingBar(), "recording to end");
    finger.up();
    expect(mic.allStopped()).toBe(true);
    await expect.element(page.getByRole("button", { name: /^Record voice message/ })).toBeInTheDocument();
  });

  test("a second press while a recording is active does not open another microphone", async () => {
    await render(<Harness />);
    const first = await holdFor(200);
    const button = primary();
    button.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 8, isPrimary: false, pointerType: "touch" }),
    );
    button.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 9, isPrimary: true, pointerType: "mouse", button: 0 }),
    );
    await sleep(400);
    expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
    first.up();
    await waitUntil(() => !recordingBar(), "recording to end");
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9 }));
  });

  test("leaving the chat or closing the composer during a recording releases the microphone", async () => {
    const view = await render(<Harness />);
    await holdFor(300);
    expect(mic.tracks).toHaveLength(1);
    await view.unmount();
    expect(mic.allStopped()).toBe(true);
  });

  test("switching to another chat clears the recording", async () => {
    const onVoiceRecorded = vi.fn();
    const view = await render(<Harness onVoiceRecorded={onVoiceRecorded} />);
    await holdFor(1200);
    await view.rerender(<Harness onVoiceRecorded={onVoiceRecorded} activeChatId={2} />);
    await waitUntil(() => !recordingBar(), "recording to be cleared");
    expect(mic.allStopped()).toBe(true);
    expect(onVoiceRecorded).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: /^Record voice message/ })).toBeInTheDocument();
  });

  test("a recording cannot start while the composer is disabled", async () => {
    await render(<Harness uploadBusy />);
    expect(primary().disabled).toBe(true);
    pointer(primary()).down();
    await sleep(400);
    expect(recordingBar()).toBeNull();
    expect(mic.getUserMedia).not.toHaveBeenCalled();
  });
});

describe("when the microphone cannot be used", () => {
  afterEach(() => restoreMicrophone());

  test("a blocked microphone is explained and the button works again", async () => {
    restoreMicrophone();
    mic = installFakeMicrophone({ reject: "NotAllowedError" });
    await render(<Harness />);
    const finger = pointer(primary());
    finger.down();
    await vi.waitFor(() => expect(inlineHint()?.textContent).toMatch(/Microphone access was blocked/));
    expect(inlineHint().getAttribute("role")).toBe("alert");
    finger.up();
    await waitUntil(() => !recordingBar(), "back to idle");
    expect(primary().disabled).toBe(false);
  });

  test("the explanation still reaches the person who let go while the browser was asking", async () => {
    restoreMicrophone();
    mic = installFakeMicrophone({ reject: "NotAllowedError" });
    mic.getUserMedia.mockImplementationOnce(async () => {
      await sleep(400); // the permission prompt
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    });
    await render(<Harness />);
    const finger = pointer(primary());
    finger.down();
    await waitUntil(() => recordingBar(), "recording bar");
    finger.up(); // let go while the prompt is open
    await vi.waitFor(() => expect(inlineHint()?.textContent).toMatch(/Microphone access was blocked/), {
      timeout: 3000,
    });
    expect(recordingBar()).toBeNull();
  });

  test("no microphone", async () => {
    restoreMicrophone();
    mic = installFakeMicrophone({ reject: "NotFoundError" });
    await render(<Harness />);
    pointer(primary()).down();
    await vi.waitFor(() => expect(inlineHint()?.textContent).toMatch(/No microphone was found/));
  });

  test("the first use asks for the microphone instead of recording", async () => {
    const onRequestMicrophonePermission = vi.fn().mockResolvedValue("granted");
    await render(<Harness microphonePermissionStatus="prompt" onRequestMicrophonePermission={onRequestMicrophonePermission} />);
    const finger = pointer(primary());
    finger.down();
    await vi.waitFor(() => expect(onRequestMicrophonePermission).toHaveBeenCalledTimes(1));
    finger.up();
    expect(recordingBar()).toBeNull();
    expect(mic.getUserMedia).not.toHaveBeenCalled();
  });
});

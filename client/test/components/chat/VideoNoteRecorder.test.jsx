import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { createStore } from "../../../src/components/chat/messages/composer/miniStore.js";

const e2ee = vi.hoisted(() => ({
  services: {
    api: { listMyDevices: async () => ({ devices: [] }) },
    directory: { getUserDevices: async () => ({ devices: [], assessment: { status: "ok", added: [] } }) },
    trust: { isVerified: async () => false },
  },
}));
vi.mock("../../../src/e2ee/services.js", () => ({ getE2eeServices: () => e2ee.services }));

import VideoNoteRecorder from "../../../src/components/chat/videoNote/VideoNoteRecorder.jsx";

// The round camera above the composer only shows what the recording session
// tells it; the session itself is covered by VideoNoteRecorderSend.test.jsx.

const clip = { blob: new Blob([new Uint8Array(2048)]), mime: "video/webm", durationMs: 5000, previewUrl: "blob:clip" };
const self = { id: "u-alice", username: "alice" };

function makeSession({ ui = {}, video = {}, ...rest } = {}) {
  return {
    ui: { phase: "recording", kind: "video", locked: false, ...ui },
    videoClip: null,
    notice: null,
    progress: createStore({ dx: 0, dy: 0, cancel: 0, lock: 0 }),
    videoElementRef: { current: null },
    video: { phase: "recording", stream: null, elapsedMs: 4200, facing: "user", cameraCount: 2, ...video },
    actions: { flipCamera: vi.fn(), sendAnyway: vi.fn(), dismissNotice: vi.fn() },
    ...rest,
  };
}

const circle = () => document.querySelector("[data-video-note-recorder] .aurelle-pop-in").parentElement;
const ring = () => document.querySelectorAll("[data-video-note-recorder] svg circle")[1];

describe("VideoNoteRecorder while a message is being recorded", () => {
  test("shows the camera in a circle with the time, and says the message is end-to-end encrypted", async () => {
    await render(<VideoNoteRecorder session={makeSession()} isDesktop chatId="chat" selfUser={self} />);
    await expect.element(page.getByText("0:04")).toBeInTheDocument();
    await expect.element(page.getByText("End-to-end encrypted")).toBeInTheDocument();
    expect(document.querySelector("[data-video-note-recorder]").dataset.videoNoteRecorder).toBe("recording");
    expect(document.querySelector("video").muted).toBe(true);
  });

  test("the circle is about 240 px on a desktop and 220 px on a phone", async () => {
    const view = await render(<VideoNoteRecorder session={makeSession()} isDesktop chatId="chat" selfUser={self} />);
    expect(circle().style.width).toBe("240px");
    await view.rerender(<VideoNoteRecorder session={makeSession()} isDesktop={false} chatId="chat" selfUser={self} />);
    expect(circle().style.width).toBe("220px");
  });

  test("the front camera is mirrored, the back camera is not", async () => {
    const view = await render(<VideoNoteRecorder session={makeSession()} chatId="chat" selfUser={self} />);
    expect(document.querySelector("video").className).toContain("-scale-x-100");
    await view.rerender(
      <VideoNoteRecorder session={makeSession({ video: { facing: "environment" } })} chatId="chat" selfUser={self} />,
    );
    expect(document.querySelector("video").className).not.toContain("-scale-x-100");
  });

  test("the red ring fills up towards the 60 second limit", async () => {
    const view = await render(
      <VideoNoteRecorder session={makeSession({ video: { elapsedMs: 0 } })} chatId="chat" selfUser={self} />,
    );
    const length = Number(ring().getAttribute("stroke-dasharray"));
    expect(Number(ring().getAttribute("stroke-dashoffset"))).toBeCloseTo(length, 1);
    await view.rerender(
      <VideoNoteRecorder session={makeSession({ video: { elapsedMs: 30_000 } })} chatId="chat" selfUser={self} />,
    );
    expect(Number(ring().getAttribute("stroke-dashoffset"))).toBeCloseTo(length / 2, 1);
    await view.rerender(
      <VideoNoteRecorder session={makeSession({ video: { elapsedMs: 60_000 } })} chatId="chat" selfUser={self} />,
    );
    expect(Number(ring().getAttribute("stroke-dashoffset"))).toBeCloseTo(0, 1);
  });

  test("shows a spinner while the camera is still opening", async () => {
    await render(
      <VideoNoteRecorder session={makeSession({ video: { phase: "starting" } })} chatId="chat" selfUser={self} />,
    );
    await expect.element(page.getByLabelText("Starting camera")).toBeInTheDocument();
  });

  test("fades as the finger slides towards cancel", async () => {
    const session = makeSession();
    await render(<VideoNoteRecorder session={session} chatId="chat" selfUser={self} />);
    expect(circle().style.opacity).toBe("1");
    session.progress.set({ dx: -90, dy: 0, cancel: 1, lock: 0 });
    await vi.waitFor(() => expect(Number(circle().style.opacity)).toBeLessThan(0.6));
  });
});

describe("VideoNoteRecorder: flipping the camera", () => {
  test("is offered once the recording is locked and there is more than one camera", async () => {
    const session = makeSession({ ui: { locked: true } });
    await render(<VideoNoteRecorder session={session} chatId="chat" selfUser={self} />);
    await page.getByRole("button", { name: "Switch camera" }).click();
    expect(session.actions.flipCamera).toHaveBeenCalledTimes(1);
  });

  test("is not offered while the button is still held, or with a single camera", async () => {
    const view = await render(
      <VideoNoteRecorder session={makeSession()} chatId="chat" selfUser={self} />,
    );
    expect(page.getByRole("button", { name: "Switch camera" }).elements()).toHaveLength(0);
    await view.rerender(
      <VideoNoteRecorder
        session={makeSession({ ui: { locked: true }, video: { cameraCount: 1 } })}
        chatId="chat"
        selfUser={self}
      />,
    );
    expect(page.getByRole("button", { name: "Switch camera" }).elements()).toHaveLength(0);
  });
});

describe("VideoNoteRecorder: reviewing a stopped recording", () => {
  const review = (extra) =>
    makeSession({ ui: { phase: "preview", locked: true }, videoClip: clip, video: { phase: "review" }, ...extra });

  test("plays the recorded clip, not the live camera, with a full ring", async () => {
    await render(<VideoNoteRecorder session={review()} chatId="chat" selfUser={self} />);
    expect(document.querySelector("[data-video-note-recorder]").dataset.videoNoteRecorder).toBe("review");
    expect(document.querySelector("video").getAttribute("src")).toBe("blob:clip");
    await expect.element(page.getByRole("button", { name: "Play preview" })).toBeInTheDocument();
    await expect.element(page.getByText("0:05")).toBeInTheDocument();
    expect(Number(ring().getAttribute("stroke-dashoffset"))).toBeCloseTo(0, 1);
    expect(page.getByRole("button", { name: "Switch camera" }).elements()).toHaveLength(0);
  });

  test("shows a spinner and no play button while the clip is being sent", async () => {
    await render(
      <VideoNoteRecorder
        session={review({ ui: { phase: "sending", kind: "video", locked: true } })}
        chatId="chat"
        selfUser={self}
      />,
    );
    await expect.element(page.getByLabelText("Sending")).toBeInTheDocument();
    expect(page.getByRole("button", { name: "Play preview" }).elements()).toHaveLength(0);
  });
});

describe("VideoNoteRecorder: a send that was refused", () => {
  const refused = (notice) => makeSession({ ui: { phase: "preview", locked: true }, videoClip: clip, notice });

  test("says why, in an alert above the camera", async () => {
    await render(
      <VideoNoteRecorder
        session={refused({ error: "You appear to be offline.", changes: [], requiresVerification: false })}
        chatId="chat"
        selfUser={self}
      />,
    );
    await expect.element(page.getByRole("alert")).toHaveTextContent("You appear to be offline.");
    expect(page.getByRole("button", { name: "Send anyway" }).elements()).toHaveLength(0);
  });

  test("a contact with a new device can be reviewed or, if never verified, sent to anyway", async () => {
    const session = refused({
      error: "A contact has a new device. Review it before sending.",
      changes: [{ userId: "u-bob", username: "bob", added: ["d2"], verified: false }],
      requiresVerification: false,
    });
    await render(<VideoNoteRecorder session={session} chatId="chat" selfUser={self} />);
    await expect.element(page.getByText(/has a new device/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Review", exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Send anyway" }).click();
    expect(session.actions.sendAnyway).toHaveBeenCalledTimes(1);
  });

  test("for a verified contact there is no 'send anyway', only a review of the safety number", async () => {
    const session = refused({
      error: "A verified contact has a new device. Check their safety number before sending.",
      changes: [{ userId: "u-bob", username: "bob", added: ["d2"], verified: true }],
      requiresVerification: true,
    });
    await render(<VideoNoteRecorder session={session} chatId="chat" selfUser={self} />);
    await expect.element(page.getByText(/verified contact has a new device/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Send anyway");
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect.element(page.getByText("Verify security")).toBeInTheDocument();
  });
});

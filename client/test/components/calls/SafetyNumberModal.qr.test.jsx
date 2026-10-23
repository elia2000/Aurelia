import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

const services = vi.hoisted(() => ({
  api: { listMyDevices: vi.fn() },
  directory: { getUserDevices: vi.fn(), invalidate: vi.fn(), acknowledge: vi.fn() },
  trust: { isVerified: vi.fn(), setVerified: vi.fn() },
}));
vi.mock("../../../src/e2ee/services.js", () => ({ getE2eeServices: () => services }));

import SafetyNumberModal from "../../../src/components/calls/SafetyNumberModal.jsx";
import { buildSafetyPayload } from "../../../src/e2ee/safetyQr.js";
import { encodeQr } from "../../../src/utils/qr/qrEncoder.js";

const key = (n) => btoa(String.fromCharCode(...new Uint8Array(65).fill(n))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const device = (n) => ({ id: `d${n}`, ecdhPublic: key(n), ecdsaPublic: key(n + 50) });
const self = { id: "u-alice", username: "alice" };
const peer = { userId: "u-bob", username: "bob", nickname: "Bob" };

beforeEach(() => {
  services.api.listMyDevices.mockReset().mockResolvedValue({ devices: [device(1)] });
  services.directory.getUserDevices.mockReset().mockResolvedValue({ devices: [device(2)], assessment: { status: "ok", added: [], verified: false } });
  services.directory.invalidate.mockReset();
  services.directory.acknowledge.mockReset().mockResolvedValue();
  services.trust.isVerified.mockReset().mockResolvedValue(false);
  services.trust.setVerified.mockReset().mockResolvedValue();
});

/** The 60 digits on the screen. */
async function shownDigits() {
  const grid = page.getByLabelText("Safety number", { exact: true });
  await expect.element(grid).toBeInTheDocument();
  return [...(await grid.element()).children].map((el) => el.textContent).join("");
}

/** Reads the dark modules back out of the SVG path. */
function matrixOf(svg) {
  const [, , size] = svg.getAttribute("viewBox").split(" ").map(Number);
  const n = size - 8;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(false));
  for (const [, x, y, run] of svg.querySelector("path").getAttribute("d").matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(run); i += 1) matrix[Number(y) - 4][Number(x) - 4 + i] = true;
  }
  return matrix;
}

describe("SafetyNumberModal - QR code", () => {
  test("shows a QR code that encodes this pair's versioned payload", async () => {
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    const digits = await shownDigits();
    const svg = (await page.getByRole("img", { name: /Verification code/ }).element());
    const expected = encodeQr(buildSafetyPayload({ selfUserId: "u-alice", peerUserId: "u-bob", digits }), { ecc: "M" });
    expect(matrixOf(svg)).toEqual(expected.modules);
    expect(svg.getAttribute("data-qr-version")).toBe(String(expected.version));
  });

  test("is dark on a fixed white square with a quiet zone, whatever the theme", async () => {
    document.documentElement.classList.add("dark");
    try {
      render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
      await shownDigits();
      const svg = await page.getByRole("img", { name: /Verification code/ }).element();
      expect(svg.querySelector("rect").getAttribute("fill")).toBe("#ffffff");
      expect(svg.querySelector("path").getAttribute("fill")).toBe("#000000");
      expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
      // Four light modules all around: the first dark module of a finder pattern starts at 4.
      const quiet = svg.querySelector("path").getAttribute("d").match(/M(\d+) (\d+)/);
      expect(Number(quiet[1])).toBeGreaterThanOrEqual(4);
      expect(Number(quiet[2])).toBeGreaterThanOrEqual(4);
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  test("has an accessible name and the number as text next to it", async () => {
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    const digits = await shownDigits();
    await expect.element(page.getByRole("img", { name: "Verification code (QR) for Bob" })).toBeInTheDocument();
    const svg = await page.getByRole("img", { name: /Verification code/ }).element();
    expect(svg.querySelector("desc").textContent).toContain(digits.slice(0, 5));
    await expect.element(page.getByText(/Let Bob scan this code/)).toBeInTheDocument();
  });

  test("is not drawn when there is no number (error state)", async () => {
    services.directory.getUserDevices.mockResolvedValue({ devices: [] });
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await expect.element(page.getByText(/has not set up secure messaging yet/)).toBeInTheDocument();
    expect(document.querySelector('svg[aria-label^="Verification code"]')).toBeNull();
  });

  test("a verified contact whose number no longer holds is told so", async () => {
    services.directory.getUserDevices.mockResolvedValue({ devices: [device(2)], assessment: { status: "ok", added: [], verified: true } });
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await expect.element(page.getByText(/changed since you verified it/)).toBeInTheDocument();
  });
});

// ── Scanning, with a stubbed detector and camera ────────────────────────────

let tracks;
let detections;
let originalDetector;
let originalGetUserMedia;
let drawTimer;

function installCamera({ supported = true, formats = ["qr_code"], denyWith = null } = {}) {
  originalDetector = window.BarcodeDetector;
  originalGetUserMedia = navigator.mediaDevices.getUserMedia;
  tracks = [];
  detections = [];
  if (supported) {
    window.BarcodeDetector = class {
      static getSupportedFormats() {
        return Promise.resolve(formats);
      }
      async detect() {
        return detections.length ? [{ rawValue: detections.shift(), format: "qr_code" }] : [];
      }
    };
  } else {
    delete window.BarcodeDetector;
  }
  navigator.mediaDevices.getUserMedia = vi.fn(async () => {
    if (denyWith) throw Object.assign(new Error("denied"), { name: denyWith });
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    let shade = 0;
    drawTimer = window.setInterval(() => {
      shade = (shade + 40) % 255;
      context.fillStyle = `rgb(${shade},${shade},${shade})`;
      context.fillRect(0, 0, 64, 48);
    }, 30);
    const stream = canvas.captureStream(30);
    stream.getTracks().forEach((track) => {
      const stop = track.stop.bind(track);
      track.stop = vi.fn(() => stop());
      tracks.push(track);
    });
    return stream;
  });
}

afterEach(() => {
  window.clearInterval(drawTimer);
  if (originalDetector === undefined) delete window.BarcodeDetector;
  else window.BarcodeDetector = originalDetector;
  if (originalGetUserMedia) navigator.mediaDevices.getUserMedia = originalGetUserMedia;
  originalDetector = undefined;
  originalGetUserMedia = undefined;
});

const code = (over = {}) =>
  buildSafetyPayload({ selfUserId: "u-bob", peerUserId: "u-alice", digits: over.digits, ...over.ids });

describe("SafetyNumberModal - scanning their code", () => {
  test("without BarcodeDetector there is no scan button and the person is told what to do instead", async () => {
    installCamera({ supported: false });
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await shownDigits();
    await expect
      .element(page.getByText("Scanning is not supported in this browser - compare the number or the emoji instead."))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Scan their code" })).not.toBeInTheDocument();
  });

  test("a detector that reads no QR codes counts as unsupported", async () => {
    installCamera({ formats: ["ean_13"] });
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await shownDigits();
    await expect.element(page.getByText(/Scanning is not supported in this browser/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Scan their code" })).not.toBeInTheDocument();
  });

  test("scanning the matching code says so, and verifies only when the person confirms", async () => {
    installCamera();
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    const digits = await shownDigits();
    await page.getByRole("button", { name: "Scan their code" }).click();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: "environment" } }, audio: false });
    await expect.element(page.getByText("Point the camera at their code")).toBeInTheDocument();

    detections.push(code({ digits }));
    await expect.element(page.getByText("Safety number matches")).toBeInTheDocument();
    // Nothing was verified by the scan itself.
    expect(services.trust.setVerified).not.toHaveBeenCalled();
    // The camera is released as soon as a code was read.
    await vi.waitFor(() => expect(tracks.length).toBeGreaterThan(0) && tracks.every((t) => expect(t.stop).toHaveBeenCalled()));

    // Exactly one place asks for the confirmation.
    await expect.element(page.getByRole("button", { name: "Mark as verified" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Mark as verified" }).click();
    expect(services.trust.setVerified).toHaveBeenCalledTimes(1);
    const [userId, number, flag, accepted] = services.trust.setVerified.mock.calls[0];
    expect([userId, number, flag]).toEqual(["u-bob", digits, true]);
    expect(accepted.map((d) => d.id)).toEqual(["d2"]);
    await expect.element(page.getByText("You verified this number.")).toBeInTheDocument();
  });

  test("a code made for somebody else is refused with the right words", async () => {
    installCamera();
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    const digits = await shownDigits();
    await page.getByRole("button", { name: "Scan their code" }).click();
    detections.push(buildSafetyPayload({ selfUserId: "u-carol", peerUserId: "u-alice", digits }));
    await expect.element(page.getByText("This code is for a different person.")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Mark as verified" })).toBeInTheDocument(); // the usual button, not a match
    expect(services.trust.setVerified).not.toHaveBeenCalled();
  });

  test("a different number is a warning, not a verification", async () => {
    installCamera();
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    const digits = await shownDigits();
    const other = `${digits.slice(0, 59)}${(Number(digits[59]) + 1) % 10}`;
    await page.getByRole("button", { name: "Scan their code" }).click();
    detections.push(code({ digits: other }));
    await expect.element(page.getByRole("alert").filter({ hasText: "The numbers do not match - do not trust this contact" })).toBeInTheDocument();
    expect(services.trust.setVerified).not.toHaveBeenCalled();
  });

  test("random text, old versions and your own code are refused", async () => {
    installCamera();
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    const digits = await shownDigits();
    for (const [scanned, message] of [
      ["https://example.com/", "This is not an Aurelle safety number code."],
      [`aurelle-sn:0:u-bob:u-alice:${digits}`, "This code was made by a different version of Aurelle and cannot be checked."],
      [buildSafetyPayload({ selfUserId: "u-alice", peerUserId: "u-bob", digits }), "This is your own code."],
    ]) {
      await page.getByRole("button", { name: "Scan their code" }).click();
      detections.push(scanned);
      await expect.element(page.getByText(message, { exact: false })).toBeInTheDocument();
    }
    expect(services.trust.setVerified).not.toHaveBeenCalled();
  });

  test("a blocked camera says how to go on", async () => {
    installCamera({ denyWith: "NotAllowedError" });
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await shownDigits();
    await page.getByRole("button", { name: "Scan their code" }).click();
    await expect.element(page.getByText(/Camera access was blocked/)).toBeInTheDocument();
    await page.getByRole("button", { name: "Stop scanning" }).click();
    await expect.element(page.getByRole("button", { name: "Scan their code" })).toBeInTheDocument();
  });

  test("stopping, and closing the dialog, release the camera", async () => {
    installCamera();
    const screen = await render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    await shownDigits();
    await page.getByRole("button", { name: "Scan their code" }).click();
    await expect.element(page.getByText("Point the camera at their code")).toBeInTheDocument();
    const first = tracks.slice();
    await page.getByRole("button", { name: "Stop scanning" }).click();
    first.forEach((track) => expect(track.stop).toHaveBeenCalled());
    await page.getByRole("button", { name: "Scan their code" }).click();
    await expect.element(page.getByText("Point the camera at their code")).toBeInTheDocument();
    const second = tracks.slice(first.length);
    expect(second.length).toBeGreaterThan(0);
    await screen.rerender(<SafetyNumberModal open={false} onClose={() => {}} selfUser={self} peer={peer} />);
    await vi.waitFor(() => second.forEach((track) => expect(track.stop).toHaveBeenCalled()));
    window.clearInterval(drawTimer);
  });
});

describe("SafetyNumberModal - typing or pasting their number", () => {
  async function openTyping() {
    render(<SafetyNumberModal open onClose={() => {}} selfUser={self} peer={peer} />);
    const digits = await shownDigits();
    await page.getByRole("button", { name: "Type their number" }).click();
    return { digits, input: page.getByLabelText("Number from your contact") };
  }

  test("counts the digits, and a matching number can be confirmed", async () => {
    const { digits, input } = await openTyping();
    await input.fill(digits.slice(0, 10));
    await expect.element(page.getByText("10 of 60 digits")).toBeInTheDocument();
    await input.fill(digits.match(/.{5}/g).join(" "));
    await expect.element(page.getByText("Safety number matches")).toBeInTheDocument();
    expect(services.trust.setVerified).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Mark as verified" }).click();
    expect(services.trust.setVerified).toHaveBeenCalledTimes(1);
  });

  test("another number is a warning", async () => {
    const { digits, input } = await openTyping();
    await input.fill(`${digits.slice(0, 59)}${(Number(digits[59]) + 1) % 10}`);
    await expect.element(page.getByText("The numbers do not match - do not trust this contact", { exact: false })).toBeInTheDocument();
  });

  test("a pasted code is judged like a scanned one", async () => {
    const { digits, input } = await openTyping();
    await input.fill(buildSafetyPayload({ selfUserId: "u-carol", peerUserId: "u-alice", digits }));
    await expect.element(page.getByText("This code is for a different person.")).toBeInTheDocument();
    await input.fill(buildSafetyPayload({ selfUserId: "u-bob", peerUserId: "u-alice", digits }));
    await expect.element(page.getByText("Safety number matches")).toBeInTheDocument();
  });

  test("letters are not a number, too many digits are called out", async () => {
    const { digits, input } = await openTyping();
    await input.fill("hello there");
    await expect.element(page.getByText(/Only digits can be compared/)).toBeInTheDocument();
    await input.fill(`${digits}1`);
    await expect.element(page.getByText("That is more than 60 digits.")).toBeInTheDocument();
  });

  test("pressing Escape still closes the dialog from the text field", async () => {
    const onClose = vi.fn();
    render(<SafetyNumberModal open onClose={onClose} selfUser={self} peer={peer} />);
    await shownDigits();
    await page.getByRole("button", { name: "Type their number" }).click();
    await page.getByLabelText("Number from your contact").click();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

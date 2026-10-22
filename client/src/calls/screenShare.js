// Screen sharing for a 1:1 call, without renegotiating anything.
//
// Every call is offered a second video line for the screen (right after the
// camera's; in a voice call it is the only video line) in its very first
// offer/answer. It is two-way and has no picture on it, so nothing flows while
// nobody shares. Sharing is then a track swap on that line plus a message on
// the call's in-band data channel; stopping is a swap back to nothing:
//
//   {t:"state", ..., screen:true}         this app can show a shared screen
//   {t:"screen", on:true, w, h}           I am sharing (w x h: size of the capture)
//   {t:"screen", on:false}                I stopped
//
// The line sits in the same BUNDLE as audio and camera, so it uses the same
// DTLS transport and the fingerprint the handshake already authenticated. The
// verification code does not depend on the SDP at all.
//
// The screen line is found by its position among the video lines, never by a
// track label: the camera is the first video line of a video call, the screen
// the next one (in a voice call it is the first). An app that does not know
// about screen sharing answers that line receive-only or rejects it, and never
// announces `screen:true`, which is how the other side knows not to share.

import {
  SCREEN_CONTENT_HINT,
  DEFAULT_SCREEN_PROFILE,
  encodingForScreen,
  initialScreenAdaptation,
  nextScreenProfile,
  screenCaptureRequest,
} from "./mediaTuning.js";

/** How long a hint such as "Screen sharing was cancelled" stays on screen. */
export const SCREEN_ERROR_SHOWN_MS = 8_000;
/** The largest side of a shared screen that is believed when the other side announces it. */
export const MAX_ANNOUNCED_SIZE = 16_384;

/** True when this browser can capture the screen (not on phones and tablets). */
export function canShareScreen(nav = typeof navigator === "undefined" ? undefined : navigator) {
  return typeof nav?.mediaDevices?.getDisplayMedia === "function";
}

/** Media sections of an SDP, in order: `[{kind, mid, direction, rejected}]`. */
export function describeMediaSections(sdp) {
  const sections = [];
  for (const line of String(sdp || "").split(/\r?\n/)) {
    const media = /^m=(\w+) (\d+) /.exec(line);
    if (media) {
      sections.push({ kind: media[1], mid: null, direction: "sendrecv", rejected: media[2] === "0" });
      continue;
    }
    const current = sections.at(-1);
    if (!current) continue;
    const mid = /^a=mid:(\S+)/.exec(line);
    if (mid) current.mid = mid[1];
    const direction = /^a=(sendrecv|sendonly|recvonly|inactive)\s*$/.exec(line);
    if (direction) current.direction = direction[1];
  }
  return sections;
}

/**
 * Which video lines of an offer are the camera's and the screen's, by position:
 * in a video call the first video line is the camera and the second the screen,
 * in a voice call the first (and only) one is the screen. A line that does not
 * exist (an older app) or was rejected is `null`.
 */
export function locateVideoLines(sdp, callKind) {
  const video = describeMediaSections(sdp).filter((section) => section.kind === "video");
  const live = (section) => (section && !section.rejected && section.mid != null ? section : null);
  if (callKind === "video") return { camera: live(video[0]), screen: live(video[1]) };
  return { camera: null, screen: live(video[0]) };
}

/** Why `getDisplayMedia` did not give a picture, as a word the screen can explain. */
export function screenErrorReason(error) {
  const name = String(error?.name || "");
  // Closing the picker and refusing are the same error to a page.
  if (name === "NotAllowedError" || name === "SecurityError" || name === "AbortError") return "cancelled";
  if (name === "TypeError" || name === "NotSupportedError") return "unsupported";
  return "failed";
}

/** A size announced by the other side: a whole number of pixels in range, or null. */
export function clampScreenSize(value) {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(MAX_ANNOUNCED_SIZE, Math.round(n));
}

const SURFACES = new Set(["monitor", "window", "browser"]);
/** What the browser says is being captured: the whole screen, a window or a browser tab. */
export function surfaceOf(track) {
  let surface = null;
  try {
    surface = track?.getSettings?.().displaySurface;
  } catch (_) {
    surface = null;
  }
  return SURFACES.has(surface) ? surface : null;
}

const stopStream = (stream) => {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch (_) {
      // already gone
    }
  });
};

/**
 * The screen-sharing half of one call: the local share (picker, track swap,
 * announcements, encoder tuning) and the remote one (what the other person
 * announced, and the track that carries it). It talks to the call through a few
 * callbacks, so it can be tested without a browser.
 */
export class ScreenShare {
  #getDisplayMedia;
  #send;
  #emit;
  #isLive;
  #createMediaStream;

  #transceiver = null;
  #mid = null;
  #peerCapable = false;

  // local
  #wanted = false;
  #chain = Promise.resolve();
  #stream = null;
  #track = null;
  #profile = DEFAULT_SCREEN_PROFILE;
  #adaptation = initialScreenAdaptation();
  #appliedKey = "";
  #errorTimer = null;
  #disposed = false;

  // remote
  #remoteStream = null;
  #announced = false;
  #remoteSize = null;
  #shown = { on: false, size: null };

  /**
   * @param {object} deps
   * @param {Function|null} deps.getDisplayMedia  (request) => Promise<MediaStream>, or null when the browser cannot
   * @param {Function} deps.send                  (message) => void, on the in-band data channel
   * @param {Function} deps.emit                  (statePatch) => void
   * @param {Function} deps.isLive                () => boolean, false once the call is over
   * @param {Function} deps.createMediaStream     () => MediaStream
   */
  constructor({ getDisplayMedia, send, emit, isLive, createMediaStream }) {
    this.#getDisplayMedia = getDisplayMedia || null;
    this.#send = send;
    this.#emit = emit;
    this.#isLive = isLive;
    this.#createMediaStream = createMediaStream;
  }

  // ── the line ───────────────────────────────────────────────────────────────
  /** The negotiated screen line (the transceiver the first offer/answer created). */
  attachLine(transceiver) {
    if (!transceiver || this.#transceiver === transceiver) return;
    this.#transceiver = transceiver;
    if (transceiver.mid != null) this.#mid = transceiver.mid;
    this.#publishAvailable();
  }

  /** The mid of the screen line, known from the offer before the browser has applied it. */
  expectMid(mid) {
    if (mid != null) this.#mid = String(mid);
  }

  get hasLine() {
    return this.#transceiver !== null;
  }

  get mid() {
    return this.#mid ?? this.#transceiver?.mid ?? null;
  }

  /** The receiver's track id on the screen line, for matching it in the stats. */
  get receiverTrackId() {
    return this.#transceiver?.receiver?.track?.id ?? null;
  }

  get sender() {
    return this.#transceiver?.sender ?? null;
  }

  /** True when `transceiver` (from a `track` event) is the screen line. */
  isLine(transceiver) {
    if (!transceiver) return false;
    if (transceiver === this.#transceiver) return true;
    const mid = this.mid;
    return mid != null && transceiver.mid != null && transceiver.mid === mid;
  }

  /** The other app said (in its state message) whether it can show a shared screen. */
  setPeerCapable(capable) {
    const next = capable === true;
    if (next === this.#peerCapable) return;
    this.#peerCapable = next;
    this.#publishAvailable();
    if (next && this.#track) this.announce(); // they can see it now: make sure they know
  }

  /** Sharing can begin: the line exists and the other app can show it. */
  get available() {
    return this.#transceiver !== null && this.#peerCapable;
  }

  get sharing() {
    return this.#track !== null;
  }

  /** Whether this app tells the other side that it can show a shared screen. */
  get capabilityToAnnounce() {
    return this.#transceiver !== null;
  }

  #publishAvailable() {
    this.#emit({ screenAvailable: this.available });
  }

  // ── sharing ────────────────────────────────────────────────────────────────
  /**
   * Starts or stops sharing. Changes run one at a time and each re-reads what is
   * wanted after every await, so two quick toggles end in what the last one
   * asked for. `replace` picks another source while already sharing.
   * @returns {Promise<void>}
   */
  want(on, { replace = false } = {}) {
    this.#wanted = Boolean(on);
    this.#chain = this.#chain.then(() => this.#reconcile(replace)).catch(() => {});
    return this.#chain;
  }

  get wanted() {
    return this.#wanted;
  }

  async #reconcile(replace) {
    if (!this.#isLive()) return;
    if (this.#wanted) {
      if (!this.#track || replace) await this.#acquire();
    } else if (this.#track) {
      await this.#release();
    }
  }

  async #acquire() {
    if (!this.available) {
      this.#wanted = this.#track !== null;
      this.#fail("unavailable");
      return;
    }
    if (!this.#getDisplayMedia) {
      this.#wanted = this.#track !== null;
      this.#fail("unsupported");
      return;
    }
    this.#clearError();
    this.#emit({ screenBusy: true, screenError: null });
    let stream;
    try {
      stream = await this.#getDisplayMedia(screenCaptureRequest());
    } catch (error) {
      this.#emit({ screenBusy: false });
      this.#wanted = this.#track !== null;
      if (this.#isLive()) this.#fail(screenErrorReason(error));
      return;
    }
    // The call may be over, or the person may have changed their mind, while
    // the picker was open: whatever arrives now is let go of at once.
    if (!this.#isLive() || !this.#wanted) {
      stopStream(stream);
      if (this.#isLive()) this.#emit({ screenBusy: false });
      return;
    }
    // The sound of a shared screen is not sent.
    stream.getAudioTracks?.().forEach((audio) => {
      try {
        audio.stop();
      } catch (_) {}
      stream.removeTrack?.(audio);
    });
    const track = stream.getVideoTracks?.()[0];
    const sender = this.sender;
    if (!track || !sender) {
      stopStream(stream);
      this.#emit({ screenBusy: false });
      this.#wanted = this.#track !== null;
      this.#fail("failed");
      return;
    }
    try {
      track.contentHint = SCREEN_CONTENT_HINT;
    } catch (_) {}
    try {
      await sender.replaceTrack(track);
    } catch (_) {
      stopStream(stream);
      this.#emit({ screenBusy: false });
      this.#wanted = this.#track !== null;
      if (this.#isLive()) this.#fail("failed");
      return;
    }
    if (!this.#isLive()) {
      // The call ended while the picture was being put on the line.
      stopStream(stream);
      return;
    }
    const previous = { stream: this.#stream, track: this.#track };
    this.#stream = stream;
    this.#track = track;
    if (previous.track) previous.track.onended = null;
    stopStream(previous.stream); // a new share replaces the old one
    track.onended = () => this.#ended(track);
    this.#profile = DEFAULT_SCREEN_PROFILE;
    this.#adaptation = initialScreenAdaptation();
    this.#appliedKey = "";
    await this.#applyEncoding();
    if (this.#track !== track) return; // stopped while the encoder was being set
    this.#emit({
      screenSharing: true,
      screenBusy: false,
      screenSurface: surfaceOf(track),
      screenStream: stream,
      screenError: null,
    });
    this.announce();
  }

  /** The browser's own "Stop sharing" bar (or the source closing) ended the picture. */
  #ended(track) {
    if (track !== this.#track) return;
    this.#wanted = false;
    void this.#release();
  }

  async #release() {
    const track = this.#track;
    if (!track) return;
    const stream = this.#stream;
    this.#track = null;
    this.#stream = null;
    track.onended = null;
    this.#appliedKey = "";
    this.#emit({ screenSharing: false, screenSurface: null, screenStream: null, screenBusy: false });
    this.#send({ t: "screen", on: false });
    stopStream(stream); // the capture light goes off now
    try {
      await this.sender?.replaceTrack(null);
    } catch (_) {
      // the line may already be closed
    }
  }

  /** Tells the other side what is being shared (or that nothing is). */
  announce() {
    const track = this.#track;
    if (!track) {
      this.#send({ t: "screen", on: false });
      return;
    }
    const settings = track.getSettings?.() || {};
    const message = { t: "screen", on: true };
    const w = clampScreenSize(settings.width);
    const h = clampScreenSize(settings.height);
    if (w && h) {
      message.w = w;
      message.h = h;
    }
    this.#send(message);
  }

  #fail(reason) {
    if (!this.#isLive()) return;
    this.#emit({ screenError: reason });
    this.#clearError();
    this.#errorTimer = setTimeout(() => {
      this.#errorTimer = null;
      if (this.#isLive()) this.#emit({ screenError: null });
    }, SCREEN_ERROR_SHOWN_MS);
  }

  #clearError() {
    clearTimeout(this.#errorTimer);
    this.#errorTimer = null;
  }

  // ── encoder ────────────────────────────────────────────────────────────────
  async #applyEncoding() {
    const sender = this.sender;
    const track = this.#track;
    if (!sender || !track || typeof sender.getParameters !== "function") return;
    const settings = track.getSettings?.() || {};
    const key = `${this.#profile}:${settings.width || 0}x${settings.height || 0}`;
    if (key === this.#appliedKey) return;
    const encoding = encodingForScreen(this.#profile, { width: settings.width, height: settings.height });
    const build = (withPreference) => {
      const params = sender.getParameters();
      params.encodings = [{ ...(params.encodings?.[0] || {}), ...encoding }];
      // Keep the sharpness and drop frames when the network is short of bits.
      if (withPreference) params.degradationPreference = "maintain-resolution";
      return params;
    };
    try {
      try {
        await sender.setParameters(build(true));
      } catch (_) {
        // not every browser knows degradationPreference: the content hint does the same
        await sender.setParameters(build(false));
      }
      this.#appliedKey = key;
    } catch (_) {
      // the defaults are still sane
    }
  }

  /**
   * One stats sample while sharing: a poor network lowers the frame rate, then
   * the bitrate, and a window that was resized is scaled to fit again. The voice
   * is never touched.
   */
  async adapt(sample) {
    if (!this.#track || !this.#isLive()) return;
    const { profile, state } = nextScreenProfile(this.#profile, sample, this.#adaptation);
    this.#adaptation = state;
    this.#profile = profile;
    await this.#applyEncoding();
  }

  get profile() {
    return this.#profile;
  }

  // ── what the other person shares ──────────────────────────────────────────
  /** A track arrived on the screen line. It is only shown once they announce a share. */
  attachRemoteTrack(track) {
    if (!track) return;
    this.#remoteStream ||= this.#createMediaStream();
    if (!this.#remoteStream.getTracks().includes(track)) this.#remoteStream.addTrack(track);
    this.#syncRemote();
  }

  /** A `screen` message from the other side. Anything odd is ignored. */
  onRemoteMessage(message) {
    // Without a negotiated screen line there is nothing that could carry a picture.
    if (!this.#transceiver) return;
    this.#announced = message?.on === true;
    this.#remoteSize = this.#announced ? sizeOf(message) : null;
    this.#syncRemote();
  }

  #syncRemote() {
    const stream = this.#remoteStream;
    const hasPicture = Boolean(stream?.getVideoTracks().some((track) => track.readyState !== "ended"));
    const on = this.#announced && hasPicture;
    const size = on ? this.#remoteSize : null;
    if (on === this.#shown.on && size?.w === this.#shown.size?.w && size?.h === this.#shown.size?.h) return;
    this.#shown = { on, size };
    this.#emit({ remoteScreenOn: on, remoteScreenStream: on ? stream : null, remoteScreenSize: size });
  }

  // ── end of the call ────────────────────────────────────────────────────────
  /** Lets go of everything, with no messages: the call is over. */
  dispose() {
    this.#disposed = true;
    this.#clearError();
    if (this.#track) this.#track.onended = null;
    stopStream(this.#stream);
    this.#stream = null;
    this.#track = null;
    stopStream(this.#remoteStream);
    this.#remoteStream = null;
  }

  get disposed() {
    return this.#disposed;
  }
}

function sizeOf(message) {
  const w = clampScreenSize(message?.w);
  const h = clampScreenSize(message?.h);
  return w && h ? { w, h } : null;
}

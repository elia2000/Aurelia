import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Close,
  Lock,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Phone,
  PhoneOff,
  PictureInPicture2,
  ScreenShare,
  ScreenShareOff,
  ShieldOff,
  SlidersHorizontal,
  Video,
  VideoOff,
  Volume2,
  WifiOff,
} from "../../icons/lucide.js";
import Avatar from "../common/Avatar.jsx";
import SafetyNumberModal from "./SafetyNumberModal.jsx";
import CallSettingsMenu from "./CallSettingsMenu.jsx";
import { ScreenPreviewTile, ScreenSharingBanner, SharingTheirScreenLabel } from "./ScreenShareParts.jsx";
import { QualityIndicator } from "./QualityParts.jsx";
import { SCREEN_ERROR_TEXT, shareScreenHint } from "../../calls/screenShareText.js";
import { guessDefaultRoute, nextQuickRoute } from "../../calls/audioDevices.js";
import { useAudioDevices } from "../../calls/useAudioDevices.js";
import { usePictureInPicture } from "../../calls/usePictureInPicture.js";
import { useFullscreen } from "../../calls/useFullscreen.js";
import { exitFullscreen } from "../../calls/fullscreen.js";
import { useCallShortcuts } from "../../calls/useCallShortcuts.js";
import { useAnnouncer } from "../../calls/useAnnouncer.js";
import { loadFit, objectFitFor, saveFit } from "../../calls/pictureFit.js";
import { CALL_PHASE, isFailureReason } from "../../calls/callManager.js";
import { useCalls } from "../../calls/callContext.js";
import { TRUST } from "../../e2ee/trust.js";
import { hasPersian } from "../../utils/fontUtils.js";
import { CLIENT_BUILD_ID } from "../../buildInfo.js";
import { buildCallReport, copyText } from "../../calls/report.js";

const END_MESSAGES = {
  hangup: "Call ended",
  local_hangup: "Call ended",
  declined: "Call declined",
  declined_local: "Call declined",
  cancelled: "Missed call",
  cancelled_local: "Call cancelled",
  missed: "Missed call",
  no_answer: "No answer",
  busy: "User is busy",
  busy_self: "You are already in a call",
  failed: "Call failed",
  connect_failed: "Couldn't connect. Check your network and try again.",
  connect_failed_no_relay:
    "Couldn't connect. This server has no relay (TURN) set up, which calls between different networks need.",
  connect_failed_relay_unreachable:
    "Couldn't reach this server's relay. If you use a VPN or proxy, it must allow connections to the server.",
  connect_failed_relay_refused:
    "This server's relay refused this device. Ask whoever runs the server to check the relay settings.",
  connect_failed_relay_proxied:
    "This server's relay is behind Cloudflare's proxy, which cannot carry calls. Ask whoever runs the server to set its DNS record to “DNS only”.",
  connection_lost: "Connection lost",
  clock_skew: "This device's clock looks wrong. Check the date and time.",
  relay_unavailable: "This server only allows relayed calls, but no relay is set up.",
  permission_denied: "Microphone or camera access was blocked",
  no_device: "No microphone found",
  handshake_failed: "Security check failed. The call was blocked.",
  key_mismatch: "This contact's security keys changed (a new device). The call was blocked.",
  e2ee_unavailable: "Secure calling is not available in this browser",
};

function useElapsed(since, active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !since) return undefined;
    setNow(Date.now());
    // One timer tick per second, and none while the page is in the background.
    const id = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [active, since]);
  if (!since) return "";
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return total >= 3600 ? `${Math.floor(total / 3600)}:${m}:${s}` : `${m}:${s}`;
}

// The two pictures of a video call: one fills the screen, the other is a small
// tile in the corner. Tapping the tile swaps them.
const MAIN_PICTURE = "absolute inset-0 z-0 h-full w-full";
// How long a video call keeps its name, buttons and notes on screen without a touch.
const AUTO_HIDE_MS = 5_000;
// How long "picture in picture is not available" stays up.
const PIP_NOTE_MS = 4_000;
// Fades the details of a video call in and out of the way of the picture.
const chromeClass = (hidden) =>
  `transition-opacity duration-200 motion-reduce:transition-none ${hidden ? "pointer-events-none opacity-0" : "opacity-100"}`;
const TILE_PICTURE =
  "absolute right-4 z-20 h-32 w-24 rounded-2xl border border-white/20 object-cover shadow-lg md:h-28 md:w-20";
// A shared screen is never cropped, in a tile as well as on the whole screen.
const TILE_SCREEN = TILE_PICTURE.replace("object-cover", "bg-black object-contain");
const TILE_TOP = { top: "calc(max(1rem, env(safe-area-inset-top)) + 3.5rem)" };
// The tiles stack down the right edge, 0.5rem apart (a tile is 8rem tall, 7rem on a computer).
// Every class is written out so that Tailwind finds it.
const TILE_BELOW = [
  "",
  "top-[calc(max(1rem,env(safe-area-inset-top))_+_12rem)] md:top-[calc(max(1rem,env(safe-area-inset-top))_+_11rem)]",
  "top-[calc(max(1rem,env(safe-area-inset-top))_+_20.5rem)] md:top-[calc(max(1rem,env(safe-area-inset-top))_+_18.5rem)]",
  "top-[calc(max(1rem,env(safe-area-inset-top))_+_29rem)] md:top-[calc(max(1rem,env(safe-area-inset-top))_+_26rem)]",
];

function useStream(ref, stream) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== (stream || null)) el.srcObject = stream || null;
    if (stream) el.play?.().catch(() => {});
  }, [ref, stream]);
}

function RoundButton({ label, onClick, active = false, danger = false, accept = false, children, size = "h-14 w-14", buttonRef, expanded, disabled = false, hint, shortcut }) {
  const tone = danger
    ? "bg-rose-600 text-white hover:bg-rose-500 shadow-[0_0_14px_rgba(244,63,94,0.35)]"
    : accept
      ? "bg-emerald-500 text-white hover:bg-emerald-400 shadow-[0_0_14px_color-mix(in_srgb,var(--color-emerald-500)_35%,transparent)]"
      : active
        ? "bg-white text-slate-900 hover:bg-slate-100"
        : "bg-white/10 text-white hover:bg-white/20";
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={expanded === undefined && active && !danger && !accept ? true : undefined}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "true"}
      title={hint || (shortcut ? `${label} (${shortcut})` : label)}
      className={`inline-flex ${size} items-center justify-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
    >
      {children}
    </button>
  );
}

export default function CallOverlay({ user, autoHideMs = AUTO_HIDE_MS }) {
  const { state, minimized, setMinimized, accept, decline, hangup, dismiss, setMuted, setCameraEnabled, setQuality, setMicrophone, screenSupported, toggleScreenShare, stopScreenShare } = useCalls();
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [copyState, setCopyState] = useState("idle"); // idle | copied | failed
  const [swapped, setSwapped] = useState(false); // your own picture fills the screen
  const [screenSwapped, setScreenSwapped] = useState(false); // their camera fills the screen, the shared screen is a tile
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(false); // the details are out of the way of the picture
  const [fit, setFit] = useState(() => loadFit());
  const [pictureSize, setPictureSize] = useState({ remote: null, local: null, screen: null });
  const [box, setBox] = useState(null);
  const hideTimer = useRef(null);
  // A click or tap that hid the details: moving the mouse does not bring them back.
  const pinnedHidden = useRef(false);
  const [audioElement, setAudioElement] = useState(null);
  const settingsButtonRef = useRef(null);
  // One stable callback, so the element is only reported when it appears or goes.
  const attachAudio = useCallback((el) => {
    remoteAudioRef.current = el;
    setAudioElement(el);
  }, []);
  const remoteVideoRef = useRef(null);
  const screenVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const localVideoRef = useRef(null);
  const dialogRef = useRef(null);

  const { phase, peer, kind, muted, cameraOn, remoteCameraOn, remoteMuted, sas, trust, relayed, networkPaused, cameraBlocked, connectingSlow, relayCheck, connectionDetails, reconnecting, connectionQuality, connectionStats, connectionLimit } = state;
  // A new report starts with a fresh button.
  useEffect(() => setCopyState("idle"), [connectionDetails]);
  const active = phase && phase !== CALL_PHASE.IDLE;
  const connected = phase === CALL_PHASE.CONNECTED;
  const elapsed = useElapsed(state.connectedAt, connected);

  // The picture elements only exist while they are shown, so the stream is
  // handed over at the same moment they mount (a stream that never changes
  // would otherwise never be attached to an element that appears later).
  const showRemoteVideo =
    kind === "video" && remoteCameraOn && connected && !minimized;
  const showLocalVideo =
    kind === "video" && cameraOn && phase !== CALL_PHASE.ENDED && !minimized;
  // Your own picture can fill the screen once the call is on and your camera is
  // sending. The choice is kept while the call is minimised, and given up when
  // there is no picture of yours any more.
  const canSwap = kind === "video" && cameraOn && connected;
  // The other person shares their screen: it fills the screen (all of it, never
  // cropped) and their camera becomes a tile. Tapping the tile swaps the two.
  // This works in a voice call too, where there is no camera to swap.
  const { screenSharing, screenSurface, screenStream, screenError, screenAvailable, remoteScreenOn, remoteScreenStream } = state;
  const screenOn = connected && Boolean(remoteScreenOn && remoteScreenStream);
  const viewingScreen = screenOn && !minimized;
  const canSwapScreen = screenOn && kind === "video" && remoteCameraOn;
  const screenSwappedView = screenSwapped && canSwapScreen && viewingScreen;
  // Your own picture can only fill the screen while a shared screen does not.
  const swappedView = swapped && canSwap && showLocalVideo && !viewingScreen;
  useEffect(() => {
    if (!canSwap) setSwapped(false);
  }, [canSwap]);
  useEffect(() => {
    if (!canSwapScreen) setScreenSwapped(false);
  }, [canSwapScreen]);
  // Why the Share screen button is off, if it is.
  const shareHint = shareScreenHint({ connected, available: screenAvailable });
  useStream(remoteAudioRef, active ? state.remoteStream : null);
  useStream(remoteVideoRef, showRemoteVideo ? state.remoteStream : null);
  useStream(localVideoRef, showLocalVideo ? state.localStream : null);
  useStream(screenVideoRef, viewingScreen ? remoteScreenStream : null);

  // Where the sound goes and which microphone is used.
  const audioDevices = useAudioDevices({
    active: Boolean(active) && phase !== CALL_PHASE.INCOMING && phase !== CALL_PHASE.ENDED,
    microphoneId: state.microphoneId,
    audioElement,
  });
  const { routes } = audioDevices.model;
  const currentRoute =
    routes.find((route) => route.id === state.microphoneId) ||
    (!state.microphoneId || state.microphoneId === "default" ? guessDefaultRoute(routes) : null);
  const quickRoute = routes.length >= 2 ? nextQuickRoute(routes, currentRoute?.kind) : null;
  const hasAudioChoices = routes.length > 0 || audioDevices.model.canPickInput || audioDevices.model.canPickOutput;
  const inCallScreen = phase === CALL_PHASE.CONNECTING || connected;
  // Once connected the settings always have something to show: the connection and the shortcuts.
  const showSettingsButton = inCallScreen && (hasAudioChoices || kind === "video" || connected);
  useEffect(() => {
    if (!inCallScreen || minimized) setSettingsOpen(false);
  }, [inCallScreen, minimized]);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  }, []);

  // ── the picture: how it sits on the screen ──
  useEffect(() => {
    const el = dialogRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const read = () => {
      const rect = el.getBoundingClientRect();
      const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
      setBox((prev) => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, minimized]);
  useEffect(() => {
    const watch = (el, key) => {
      const read = () => {
        const next = el.videoWidth ? { w: el.videoWidth, h: el.videoHeight } : null;
        setPictureSize((prev) =>
          prev[key]?.w === next?.w && prev[key]?.h === next?.h ? prev : { ...prev, [key]: next },
        );
      };
      read();
      el.addEventListener("loadedmetadata", read);
      el.addEventListener("resize", read);
      return () => {
        el.removeEventListener("loadedmetadata", read);
        el.removeEventListener("resize", read);
      };
    };
    const stops = [];
    if (showRemoteVideo && remoteVideoRef.current) stops.push(watch(remoteVideoRef.current, "remote"));
    if (showLocalVideo && localVideoRef.current) stops.push(watch(localVideoRef.current, "local"));
    if (viewingScreen && screenVideoRef.current) stops.push(watch(screenVideoRef.current, "screen"));
    return () => stops.forEach((stop) => stop());
  }, [showRemoteVideo, showLocalVideo, viewingScreen]);
  const chooseFit = useCallback((choice) => {
    setFit(choice);
    saveFit(choice);
  }, []);
  // Whichever picture fills the screen: all of it, or filling the screen with the edges cut off.
  const mainFit = objectFitFor(fit, swappedView ? pictureSize.local : pictureSize.remote, box);
  const mainPicture = `${MAIN_PICTURE} ${mainFit === "contain" ? "object-contain" : "object-cover"}`;

  // ── the details of a video call get out of the way of the picture: a tap or
  // a mouse click hides them (and brings them back), and they hide by
  // themselves after a few seconds. A mouse showing them by moving is the
  // exception to a click: what a click hid stays hidden until the next click or
  // a key press. They stay while something needs reading or choosing, and
  // while there is no picture to look at instead.
  const videoOnScreen = connected && !minimized && (viewingScreen || (kind === "video" && (showRemoteVideo || swappedView)));
  const mustStay = settingsOpen || safetyOpen || trust?.status === TRUST.DEVICES_ADDED || Boolean(networkPaused) || Boolean(reconnecting);
  const hideChrome = chromeHidden && videoOnScreen && !settingsOpen && !safetyOpen;
  const armHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    const tick = () => {
      // Someone moving through the buttons with the keyboard is still using them.
      const focused = document.activeElement;
      let usingKeyboard = false;
      try {
        usingKeyboard = Boolean(
          focused && focused !== dialogRef.current && dialogRef.current?.contains(focused) && focused.matches(":focus-visible"),
        );
      } catch (_) {
        // a browser without :focus-visible: the details simply hide on time
      }
      if (usingKeyboard) hideTimer.current = setTimeout(tick, autoHideMs);
      else setChromeHidden(true);
    };
    hideTimer.current = setTimeout(tick, autoHideMs);
  }, [autoHideMs]);
  useEffect(() => {
    if (videoOnScreen && !mustStay && !chromeHidden) armHide();
    else clearTimeout(hideTimer.current);
    return () => clearTimeout(hideTimer.current);
  }, [videoOnScreen, mustStay, chromeHidden, armHide]);
  // A call that is not a video picture (or is over) always shows everything.
  useEffect(() => {
    if (videoOnScreen) return;
    pinnedHidden.current = false;
    setChromeHidden(false);
  }, [videoOnScreen]);
  const wake = useCallback(() => {
    pinnedHidden.current = false;
    setChromeHidden(false);
    if (videoOnScreen && !mustStay) armHide();
  }, [videoOnScreen, mustStay, armHide]);
  // The hidden buttons cannot be focused, so whatever had focus loses it and
  // key presses would go to the page behind. Keep them on the call: the dialog
  // takes the focus, and any key brings the details back.
  useEffect(() => {
    if (!hideChrome) return undefined;
    const dialog = dialogRef.current;
    if (dialog && dialog.contains(document.activeElement) && document.activeElement !== dialog) dialog.focus({ preventScroll: true });
    const onKey = () => {
      if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
      wake();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hideChrome, wake]);
  // ── picture in picture, full screen and the keyboard (see pip.js, shortcuts.js) ──
  const [announcement, say] = useAnnouncer();
  const [pipNote, setPipNote] = useState(false); // the browser would not open the window: said for a few seconds
  const [shortcutsHelp, setShortcutsHelp] = useState(false); // the ? key opened the settings on the shortcuts
  const pipNoteTimer = useRef(null);
  useEffect(() => () => clearTimeout(pipNoteTimer.current), []);
  useEffect(() => {
    if (!settingsOpen) setShortcutsHelp(false);
  }, [settingsOpen]);
  // The picture that would float: their screen while it fills the screen, otherwise their camera.
  const pipTargetKey = viewingScreen && !(screenSwappedView && showRemoteVideo) ? "screen" : showRemoteVideo ? "remote" : null;
  const pip = usePictureInPicture({
    targetKey: pipTargetKey,
    getTarget: () => (pipTargetKey === "screen" ? screenVideoRef.current : pipTargetKey === "remote" ? remoteVideoRef.current : null),
    kind,
    muted,
    cameraOn,
    onToggleMicrophone: () => setMuted(!muted),
    onToggleCamera: () => setCameraEnabled(!cameraOn),
    onHangup: hangup,
  });
  const { toggle: togglePipWindow } = pip;
  const togglePip = useCallback(async () => {
    const result = await togglePipWindow();
    if (result === "failed") {
      clearTimeout(pipNoteTimer.current);
      setPipNote(true);
      pipNoteTimer.current = setTimeout(() => setPipNote(false), PIP_NOTE_MS);
    } else {
      say(result === "entered" ? "Picture in picture on" : "Picture in picture off");
    }
  }, [togglePipWindow, say]);
  const fullscreen = useFullscreen(dialogRef);
  // The safety number opens in its own window, which a card in full screen would hide.
  useEffect(() => {
    if (safetyOpen) void exitFullscreen(dialogRef.current);
  }, [safetyOpen]);

  // Keys: only while the card is on screen (a minimised call leaves them to the chat). An action
  // that returns false is not available right now, and its key goes on to whoever else wants it.
  const callOn = Boolean(active) && phase !== CALL_PHASE.INCOMING && phase !== CALL_PHASE.ENDED;
  const canShare = screenSupported && inCallScreen && (screenSharing || Boolean(state.screenBusy) || !shareHint);
  useCallShortcuts({
    enabled: Boolean(active) && !minimized,
    getCard: () => dialogRef.current,
    actions: {
      mute: () => {
        if (!callOn) return false;
        wake();
        say(muted ? "Microphone on" : "Microphone muted");
        setMuted(!muted);
      },
      camera: () => {
        if (!callOn || kind !== "video") return false;
        wake();
        say(cameraOn ? "Camera off" : "Camera on");
        setCameraEnabled(!cameraOn);
      },
      screen: () => {
        if (!canShare) return false;
        wake();
        if (screenSharing) say("Stopped sharing your screen");
        toggleScreenShare();
      },
      pip: () => {
        if (!pip.available) return false;
        wake();
        void togglePip();
      },
      fullscreen: () => {
        if (!fullscreen.supported) return false;
        wake();
        void fullscreen.toggle().then((result) => {
          if (result !== "failed") say(result === "entered" ? "Full screen on" : "Full screen off");
        });
      },
      // Escape closes the settings (and the safety number) first: only then the call.
      minimise: () => {
        if (!callOn || settingsOpen || safetyOpen) return false;
        setMinimized(true);
      },
      hangup: () => {
        if (!callOn) return false;
        hangup();
      },
      help: () => {
        if (!showSettingsButton) return false;
        wake();
        if (settingsOpen) {
          closeSettings();
        } else {
          setShortcutsHelp(true);
          setSettingsOpen(true);
        }
      },
    },
  });
  // A dropped connection says so even if the details were out of the way.
  useEffect(() => {
    if (reconnecting) wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnecting]);

  const onStageClick = (event) => {
    // While the settings or the safety number are open, a tap belongs to them.
    if (!videoOnScreen || settingsOpen || safetyOpen) return;
    const target = event.target;
    // The small picture swaps and the buttons do their job: neither hides anything.
    if (target?.closest?.("[data-keep-chrome]")) return;
    if (target?.closest?.("button, a, input, summary, [role='radio'], [role='switch']")) {
      wake();
      return;
    }
    // A click on the picture hides what is showing and shows what is hidden.
    // What it hid stays hidden: the mouse moving over the picture does not undo it.
    const hide = !chromeHidden;
    pinnedHidden.current = hide;
    setChromeHidden(hide);
  };

  useEffect(() => {
    if (!active) setSafetyOpen(false);
  }, [active]);

  // A call that fails explains why on its card, which a minimised pill is too
  // small to show: open the card so the reason can be read.
  const failedEnd = phase === CALL_PHASE.ENDED && isFailureReason(state.endReason);
  const copyReport = async () => {
    const copied = await copyText(
      buildCallReport({
        reason: state.endReason,
        lines: connectionDetails || [],
        buildId: CLIENT_BUILD_ID,
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      }),
    );
    setCopyState(copied ? "copied" : "failed");
  };
  useEffect(() => {
    if (failedEnd && minimized) setMinimized(false);
  }, [failedEnd, minimized, setMinimized]);

  // An incoming call must not steal focus from what the person is typing:
  // pressing Space or Enter in the message box would otherwise answer it (and
  // turn the microphone on). Take focus only when nothing editable has it.
  const ringing = phase === CALL_PHASE.INCOMING;
  useEffect(() => {
    if (!ringing) return;
    const el = document.activeElement;
    const editing =
      el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
    if (!editing) dialogRef.current?.focus();
  }, [ringing]);

  if (!active || typeof document === "undefined") return null;

  const peerName = peer?.nickname || peer?.username || "Unknown";
  const fa = hasPersian(peerName) ? "font-fa" : "";
  const incoming = phase === CALL_PHASE.INCOMING;
  const ended = phase === CALL_PHASE.ENDED;
  // In a connected video call there is no avatar stage: when the other camera
  // is off the screen is simply black.
  const videoStage = kind === "video" && connected;

  // ── where each picture sits: "main", or the number of its tile down the right edge ──
  const ownTile = showLocalVideo || (videoStage && !cameraOn && !minimized); // your picture, or the black tile that stands in for it
  const slots = {};
  let tiles = 0;
  if (viewingScreen) {
    slots.screen = screenSwappedView ? tiles++ : "main";
    slots.remote = screenSwappedView ? "main" : showRemoteVideo ? tiles++ : undefined;
    if (showLocalVideo) slots.local = tiles++;
  } else if (swappedView) {
    slots.local = "main";
    slots.remote = tiles++;
  } else {
    slots.remote = "main";
    if (ownTile) slots.local = tiles++;
  }
  if (screenSharing && !minimized) slots.preview = tiles++;
  const place = (slot, tile = TILE_PICTURE, main = mainPicture) =>
    slot === "main"
      ? { className: main, style: undefined }
      : { className: `${tile} ${TILE_BELOW[slot] || ""}`, style: slot === 0 ? TILE_TOP : undefined };
  const placed = {
    remote: place(slots.remote),
    local: place(slots.local),
    // Whatever the other person shares is never cropped, on the whole screen or in a tile.
    screen: place(slots.screen, TILE_SCREEN, `${MAIN_PICTURE} object-contain`),
  };

  let statusText = "";
  if (ended) statusText = END_MESSAGES[state.endReason] || "Call ended";
  else if (incoming) statusText = kind === "video" ? "Incoming video call" : "Incoming voice call";
  else if (phase === CALL_PHASE.OUTGOING) {
    // "Ringing" only once the other person's app says it is ringing. Until then
    // (their app closed or offline) they have at most been sent a notification.
    statusText = state.ringing ? "Ringing…" : state.waiting ? "Waiting…" : "Calling…";
  }
  else if (phase === CALL_PHASE.CONNECTING) statusText = "Connecting…";
  else if (connected) statusText = elapsed;

  const trustWarning =
    trust?.status === TRUST.DEVICES_ADDED
      ? trust.verified
        ? "This contact's safety number changed: a new device was added. Check it before you trust this call."
        : "A new device was added for this contact. Verify before sharing anything sensitive."
      : trust?.status === TRUST.NEW
        ? "First secure call with this contact. Once connected, compare the emoji code at the top with theirs."
        : "";

  const sink = (
    // Remote audio keeps playing when the call UI is minimised.
    <audio ref={attachAudio} autoPlay playsInline />
  );

  if (minimized) {
    return createPortal(
      <>
        {sink}
        <div
          role="status"
          className="fixed left-1/2 z-[340] flex -translate-x-1/2 items-center gap-3 rounded-full bg-emerald-600 py-1.5 pl-4 pr-1.5 text-white shadow-lg"
          style={{ top: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <Lock size={14} aria-hidden="true" className="shrink-0" />
          <span className={`min-w-0 max-w-[40vw] truncate text-sm font-semibold ${fa}`} dir="auto">
            {peerName}
          </span>
          <span className="min-w-0 max-w-[30vw] truncate text-xs tabular-nums opacity-90" title={statusText}>
            {statusText}
          </span>
          {screenSharing ? (
            // The call is out of sight: sharing still has to be obvious, and one tap from stopping.
            <button
              type="button"
              onClick={stopScreenShare}
              aria-label="Stop sharing"
              title="You are sharing your screen. Stop sharing"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-rose-600 px-2.5 text-xs font-semibold hover:bg-rose-500"
            >
              <ScreenShareOff size={14} aria-hidden="true" /> Sharing
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMinimized(false)}
            aria-label="Expand call"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 hover:bg-white/25"
          >
            <Maximize2 size={15} />
          </button>
          {!incoming && !ended ? (
            <button
              type="button"
              onClick={hangup}
              aria-label="End call"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-600 hover:bg-rose-500"
            >
              <PhoneOff size={15} />
            </button>
          ) : null}
        </div>
      </>,
      document.body,
    );
  }

  return createPortal(
    <>
      {sink}
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-label={`${statusText} with ${peerName}`}
        onClick={onStageClick}
        onKeyDown={wake}
        onPointerMove={(event) => event.pointerType === "mouse" && !pinnedHidden.current && wake()}
        className={`fixed inset-0 z-[340] flex flex-col overflow-hidden ${videoStage || viewingScreen ? "bg-black" : "bg-slate-950"} text-slate-50 outline-none md:inset-auto md:bottom-6 md:right-6 ${viewingScreen ? "md:h-[min(80vh,760px)] md:w-[min(92vw,1180px)]" : "md:h-[560px] md:w-[360px]"} md:rounded-3xl md:border md:border-emerald-500/30 md:shadow-2xl md:shadow-emerald-500/20 [&:fullscreen]:rounded-none [&:fullscreen]:border-0`}
      >
        {showRemoteVideo ? (
          <video
            ref={remoteVideoRef}
            data-view="remote"
            data-slot={slots.remote === "main" ? "main" : "tile"}
            data-fit={slots.remote === "main" ? mainFit : undefined}
            autoPlay
            playsInline
            muted
            className={placed.remote.className}
            style={placed.remote.style}
          />
        ) : null}
        {viewingScreen ? (
          <video
            ref={screenVideoRef}
            data-view="screen"
            data-slot={slots.screen === "main" ? "main" : "tile"}
            data-fit={slots.screen === "main" ? "contain" : undefined}
            autoPlay
            playsInline
            muted
            className={placed.screen.className}
            style={placed.screen.style}
          />
        ) : null}
        <div
          data-chrome="shade"
          className={`absolute inset-0 z-[5] bg-linear-to-b from-slate-950/70 via-transparent to-slate-950/80 ${chromeClass(hideChrome)}`}
        />

        {/* What a key press did, for screen readers (the buttons can be out of the way, and inert, when it happens). */}
        <p role="status" className="sr-only">
          {announcement}
        </p>

        <div
          data-chrome="header"
          inert={hideChrome}
          className={`relative z-10 flex items-start justify-between gap-2 px-4 ${chromeClass(hideChrome)}`}
          style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setSafetyOpen(true)}
              disabled={!sas}
              className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap rounded-full border border-emerald-400/40 bg-slate-900/70 px-3 py-1.5 text-xs font-semibold text-emerald-200 backdrop-blur transition hover:border-emerald-300 disabled:cursor-default"
              aria-label="End-to-end encrypted. Verify security."
            >
              <Lock size={13} aria-hidden="true" />
              {/* On the narrowest phones the emoji code keeps the room (the button's name still says it). */}
              <span className={sas ? "max-[359px]:hidden" : undefined}>{sas ? "Encrypted" : "End-to-end encrypted"}</span>
              {sas ? <span className="text-base leading-none tracking-wide">{sas.join("")}</span> : null}
            </button>
            {connected ? (
              <QualityIndicator
                rank={connectionQuality}
                reconnecting={reconnecting}
                relayed={relayed}
                onClick={() => setSettingsOpen(true)}
              />
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {pip.available ? (
              <button
                type="button"
                onClick={togglePip}
                aria-label="Picture in picture"
                aria-pressed={pip.inPip}
                title="Picture in picture (P)"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
              >
                <PictureInPicture2 size={16} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setMinimized(true)}
              aria-label="Minimise call"
              title="Minimise call (Esc)"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
            >
              <Minimize2 size={16} />
            </button>
          </div>
        </div>

        {trustWarning ? (
          <p
            data-chrome="warning"
            inert={hideChrome}
            // The small pictures down the right edge must not sit on top of the words.
            style={tiles > 0 && !viewingScreen ? { marginRight: "7rem" } : undefined}
            className={`relative z-10 mx-4 mt-3 flex items-start gap-2 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-xs text-amber-100 ${chromeClass(hideChrome)}`}
          >
            <ShieldOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{trustWarning}</span>
            {trust?.status === TRUST.DEVICES_ADDED ? (
              <button
                type="button"
                onClick={() => setSafetyOpen(true)}
                className="shrink-0 rounded-full border border-amber-300/60 px-2 py-0.5 font-semibold hover:bg-amber-400/20"
              >
                Review
              </button>
            ) : null}
          </p>
        ) : null}

        {/* The middle scrolls when there is more than fits (a long report, a short screen), so the buttons below stay on the card. */}
        <div
          data-chrome="status"
          inert={hideChrome}
          className={`relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-3 overflow-y-auto px-6 text-center ${chromeClass(hideChrome)}`}
        >
          {!showRemoteVideo && !videoStage && !viewingScreen ? (
            <Avatar
              src={peer?.avatarUrl || peer?.avatar_url}
              name={peerName}
              color={peer?.color || "#10b981"}
              className={`h-28 w-28 ${incoming || phase === CALL_PHASE.OUTGOING ? "ring-4 ring-emerald-400/40" : ""}`}
              placeholderClassName="text-4xl font-semibold text-white"
            />
          ) : null}
          <h2 className={`max-w-full truncate text-2xl font-semibold ${fa}`} dir="auto">
            {peerName}
          </h2>
          {/* Status changes are announced; the running clock is not (it would
              interrupt the call audio for screen-reader users every second). */}
          <p
            className="text-sm tabular-nums text-slate-300"
            {...(connected ? { role: "timer", "aria-live": "off" } : { "aria-live": "polite" })}
          >
            {statusText}
          </p>
          {viewingScreen ? <SharingTheirScreenLabel waiting={!pictureSize.screen} /> : null}
          {ended && connectionDetails?.length ? (
            <details className="max-w-[18rem] text-left text-xs text-slate-400">
              <summary className="cursor-pointer text-center">Technical details</summary>
              <ul className="mt-1 space-y-0.5 break-words font-mono text-[11px]">
                {connectionDetails.map((line, index) => (
                  <li key={index} className="whitespace-pre-wrap">{line}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={copyReport}
                className="mt-2 rounded-full border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                {copyState === "copied" ? "Copied" : copyState === "failed" ? "Couldn't copy" : "Copy report"}
              </button>
            </details>
          ) : null}
          {/* Hints that appear while the call goes on are announced (the region
              exists from the start, so screen readers notice what is added). */}
          <div aria-live="polite" className="flex flex-col items-center gap-3">
            {videoStage && !remoteCameraOn && !viewingScreen ? (
              <p className="inline-flex items-center gap-1.5 text-sm text-slate-400">
                <VideoOff size={16} aria-hidden="true" /> Camera off
              </p>
            ) : null}
            {phase === CALL_PHASE.CONNECTING && relayCheck === "unreachable" ? (
              <p className="max-w-[18rem] text-xs text-amber-200">
                Can't reach the relay server yet. Calls between different networks need it. If you use a VPN or proxy,
                it must allow this connection.
              </p>
            ) : phase === CALL_PHASE.CONNECTING && relayCheck === "proxied" ? (
              <p className="max-w-[18rem] text-xs text-amber-200">
                This server's relay is behind Cloudflare's proxy, which cannot carry calls. Its DNS record must be set
                to “DNS only”.
              </p>
            ) : phase === CALL_PHASE.CONNECTING && relayCheck === "refused" ? (
              <p className="max-w-[18rem] text-xs text-amber-200">
                The relay server refused this device. The relay settings on the server may be wrong.
              </p>
            ) : phase === CALL_PHASE.CONNECTING && connectingSlow ? (
              <p className="max-w-[18rem] text-xs text-slate-400">
                Still connecting. This can take a little longer on mobile networks.
              </p>
            ) : null}
            {cameraBlocked && !ended && kind === "video" ? (
              <p className="max-w-[18rem] text-xs text-amber-200">
                {cameraBlocked === "permission_denied"
                  ? "Camera access is blocked, so you are not sending video."
                  : cameraBlocked === "no_device"
                    ? "No camera was found, so you are not sending video."
                    : "The camera could not be started, so you are not sending video."}
              </p>
            ) : null}
            {screenError && !ended ? (
              <p className="max-w-[18rem] text-xs text-amber-200">{SCREEN_ERROR_TEXT[screenError] || SCREEN_ERROR_TEXT.failed}</p>
            ) : null}
            {pipNote && !ended ? (
              <p className="max-w-[18rem] text-xs text-amber-200">Picture in picture is not available right now.</p>
            ) : null}
            {connected && reconnecting ? (
              <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-3 py-1 text-xs text-amber-100">
                <WifiOff size={12} aria-hidden="true" /> Reconnecting…
              </p>
            ) : null}
          </div>
          {connected && remoteMuted ? (
            <p className="text-xs text-slate-400">{peerName} is muted</p>
          ) : null}
          {connected && networkPaused ? (
            <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-3 py-1 text-xs text-amber-100">
              <WifiOff size={12} aria-hidden="true" /> Poor connection. Video paused to keep the call going.
            </p>
          ) : null}
          {connected && relayed ? (
            <p className="text-[11px] text-slate-500">Relayed through your server for privacy and reliability</p>
          ) : null}
        </div>

        {/* The small tile. It is you; after a swap it is the other person. */}
        {videoStage && !cameraOn && !minimized && !viewingScreen ? (
          <div
            className="absolute right-4 z-20 flex h-32 w-24 items-center justify-center rounded-2xl border border-white/10 bg-black text-slate-500 shadow-lg md:h-28 md:w-20"
            style={TILE_TOP}
            aria-label="Your camera is off"
            role="img"
          >
            <VideoOff size={22} aria-hidden="true" />
          </div>
        ) : null}
        {swappedView && !showRemoteVideo ? (
          <div
            className="absolute right-4 z-20 flex h-32 w-24 items-center justify-center rounded-2xl border border-white/10 bg-black text-slate-500 shadow-lg md:h-28 md:w-20"
            style={TILE_TOP}
            aria-label="Their camera is off"
            role="img"
          >
            <VideoOff size={22} aria-hidden="true" />
          </div>
        ) : null}
        {showLocalVideo ? (
          <>
            <video
              ref={localVideoRef}
              data-view="local"
              data-slot={slots.local === "main" ? "main" : "tile"}
              data-fit={slots.local === "main" ? mainFit : undefined}
              autoPlay
              playsInline
              muted
              className={`${placed.local.className} -scale-x-100`}
              style={placed.local.style}
            />
            {canSwap && !viewingScreen ? (
              <button
                type="button"
                data-keep-chrome
                onClick={() => setSwapped(!swappedView)}
                aria-label={swappedView ? "Show their picture full screen" : "Show your picture full screen"}
                className="absolute right-4 z-30 h-32 w-24 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 md:h-28 md:w-20"
                style={TILE_TOP}
              />
            ) : null}
          </>
        ) : null}

        {canSwapScreen && viewingScreen ? (
          // The tile at the top is the one that is not full screen: tapping it swaps the two.
          <button
            type="button"
            data-keep-chrome
            onClick={() => setScreenSwapped(!screenSwappedView)}
            aria-label={screenSwappedView ? "Show the shared screen full screen" : "Show their camera full screen"}
            className="absolute right-4 z-30 h-32 w-24 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 md:h-28 md:w-20"
            style={TILE_TOP}
          />
        ) : null}
        {screenSharing && !minimized ? (
          <ScreenPreviewTile
            stream={screenStream}
            surface={screenSurface}
            className={`absolute right-4 z-20 h-32 w-24 md:h-28 md:w-20 ${TILE_BELOW[slots.preview] || ""}`}
            style={slots.preview === 0 ? TILE_TOP : undefined}
          />
        ) : null}
        {/* Whoever shares always sees that they do, however the other details are hidden. */}
        {screenSharing && !ended ? <ScreenSharingBanner surface={screenSurface} onStop={stopScreenShare} /> : null}

        <CallSettingsMenu
          open={settingsOpen && inCallScreen}
          onClose={closeSettings}
          audio={{
            model: audioDevices.model,
            routeKind: currentRoute?.kind,
            inputId: state.microphoneId || "default",
            outputId: audioDevices.outputId,
            outputError: audioDevices.outputError,
            deviceError: state.audioDeviceError,
          }}
          onPickRoute={(route) => setMicrophone(route.id)}
          onPickInput={(id) => setMicrophone(id)}
          onPickOutput={audioDevices.chooseOutput}
          showQuality={kind === "video"}
          quality={state.quality || "auto"}
          onQuality={setQuality}
          videoStats={state.videoStats}
          screenStats={viewingScreen ? state.screenStats : null}
          fit={fit}
          onFit={chooseFit}
          connection={
            connected
              ? { rank: connectionQuality, reconnecting, relayed, stats: connectionStats, limit: connectionLimit }
              : null
          }
          showShortcuts={shortcutsHelp}
        />

        <div
          data-chrome="controls"
          inert={hideChrome}
          className={`relative z-10 flex flex-wrap items-center justify-center gap-3 px-6 pt-4 ${chromeClass(hideChrome)}`}
          style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
        >
          {ended ? (
            // The reason a call ended stays up long enough to read; this closes it sooner.
            <RoundButton label="Close" onClick={dismiss}>
              <Close size={22} />
            </RoundButton>
          ) : incoming ? (
            <>
              <RoundButton label="Decline call" danger onClick={decline}>
                <PhoneOff size={22} />
              </RoundButton>
              {kind === "video" ? (
                // Answer a video call without showing yourself: you still see
                // them, and the camera can be turned on during the call.
                <RoundButton label="Answer with camera off" onClick={() => accept({ camera: false })}>
                  <VideoOff size={22} />
                </RoundButton>
              ) : null}
              <RoundButton label="Accept call" accept onClick={() => accept()}>
                {kind === "video" ? <Video size={22} /> : <Phone size={22} />}
              </RoundButton>
            </>
          ) : (
            <>
              <RoundButton size="h-12 w-12" label={muted ? "Unmute microphone" : "Mute microphone"} shortcut="M" active={muted} onClick={() => setMuted(!muted)}>
                {muted ? <MicOff size={22} /> : <Mic size={22} />}
              </RoundButton>
              {kind === "video" ? (
                <RoundButton
                  size="h-12 w-12"
                  label={cameraOn ? "Turn camera off" : "Turn camera on"}
                  shortcut="V"
                  active={!cameraOn}
                  onClick={() => setCameraEnabled(!cameraOn)}
                >
                  {cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
                </RoundButton>
              ) : null}
              {screenSupported && (phase === CALL_PHASE.CONNECTING || connected) ? (
                // Hidden where the browser cannot capture a screen (phones). Off until the call is up
                // and the other app has said it can show one, with the reason in its title.
                <RoundButton
                  size="h-12 w-12"
                  label={screenSharing ? "Stop sharing" : "Share screen"}
                  shortcut="S"
                  hint={screenSharing ? undefined : shareHint || undefined}
                  active={screenSharing || state.screenBusy}
                  disabled={!screenSharing && !state.screenBusy && Boolean(shareHint)}
                  onClick={toggleScreenShare}
                >
                  {screenSharing ? <ScreenShareOff size={22} /> : <ScreenShare size={22} />}
                </RoundButton>
              ) : null}
              {quickRoute && inCallScreen ? (
                // Like a phone call: the loudspeaker on or off (the earpiece is the other way).
                <RoundButton
                  size="h-12 w-12"
                  label={currentRoute?.kind === "speaker" ? "Switch to phone earpiece" : "Switch to speaker"}
                  active={currentRoute?.kind === "speaker"}
                  onClick={() => setMicrophone(quickRoute.id)}
                >
                  <Volume2 size={22} />
                </RoundButton>
              ) : null}
              {showSettingsButton ? (
                <RoundButton
                  size="h-12 w-12"
                  buttonRef={settingsButtonRef}
                  label="Call settings"
                  active={settingsOpen}
                  expanded={settingsOpen}
                  onClick={() => setSettingsOpen(!settingsOpen)}
                >
                  <SlidersHorizontal size={22} />
                </RoundButton>
              ) : null}
              <RoundButton label={phase === CALL_PHASE.OUTGOING ? "Cancel call" : "End call"} shortcut="Shift+H" danger onClick={hangup}>
                <PhoneOff size={22} />
              </RoundButton>
            </>
          )}
        </div>
      </div>

      <SafetyNumberModal
        open={safetyOpen}
        onClose={() => setSafetyOpen(false)}
        chatId={state.chatId}
        selfUser={user}
        peer={peer ? { userId: peer.userId, username: peer.username, nickname: peer.nickname } : null}
        sas={sas}
      />
    </>,
    document.body,
  );
}

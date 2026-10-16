import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Lock, Play, Pause, LoaderCircle, ShieldOff, TriangleAlert } from "../../../icons/lucide.js";
import { getE2eeServices } from "../../../e2ee/services.js";
import { fetchCiphertext } from "../../../api/e2eeApi.js";
import { formatDurationMs } from "../../../videoNote/config.js";
import { getRememberedVideoNote } from "../../../videoNote/localCache.js";
import {
  friendlyDecryptError,
  loadVideoNote,
  loadVideoNotePoster,
  videoNoteKey,
} from "../../../videoNote/receive.js";

// Only loaded when the sender's keys need a look.
const SafetyNumberModal = lazy(() => import("../../calls/SafetyNumberModal.jsx"));

const SIZE = 224;
const STROKE = 5;
const RADIUS = SIZE / 2 - STROKE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// A press this close to the ring (in the 224-unit drawing) grabs the seek bullet.
const GRAB = 16;
const KEY_STEP_S = 5;

// Only one video message plays at a time: the pause function of the one playing.
let activePause = null;

/**
 * A round, end-to-end encrypted video message. Nothing but the tiny poster
 * frame is decrypted until the viewer taps play, and the video file is only
 * downloaded at that moment, so scrolling through a chat costs no data.
 */
export default function VideoNoteBubble({ msg, user }) {
  const envelope = msg?.e2ee || null;
  const key = videoNoteKey(msg);
  const durationMs = Number(envelope?.durationMs || 0);

  const [poster, setPoster] = useState(() => getRememberedVideoNote(key)?.posterUrl || null);
  const [source, setSource] = useState(() => getRememberedVideoNote(key)?.url || null);
  const [status, setStatus] = useState("idle"); // idle | loading | playing | paused | error
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [senderPending, setSenderPending] = useState(() => Boolean(getRememberedVideoNote(key)?.senderPending));
  const [reviewOpen, setReviewOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [mediaDuration, setMediaDuration] = useState(0); // seconds, once the file says so
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const abortRef = useRef(null);
  const dragRef = useRef({ active: false, last: 0, suppressClick: false });

  useEffect(() => {
    let cancelled = false;
    if (poster || !envelope) return undefined;
    loadVideoNotePoster({ msg, user, services: getE2eeServices() }).then((url) => {
      if (!cancelled && url) setPoster(url);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, Boolean(envelope)]);

  // The message can be replaced (optimistic copy -> server copy) with a
  // different key; pick up what this device already has for it.
  useEffect(() => {
    const remembered = key ? getRememberedVideoNote(key) : null;
    if (!remembered) return;
    setSource((current) => current || remembered.url || null);
    setPoster((current) => current || remembered.posterUrl || null);
  }, [key]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const pause = useCallback(() => {
    videoRef.current?.pause();
    setStatus((s) => (s === "playing" ? "paused" : s));
  }, []);

  const play = useCallback(
    async (url) => {
      const el = videoRef.current;
      if (!el) return;
      if (activePause && activePause !== pause) activePause();
      activePause = pause;
      try {
        if (el.src !== url) el.src = url;
        await el.play();
        setHint("");
        setStatus("playing");
      } catch (e) {
        if (e?.name === "NotAllowedError") {
          // The tap that asked for the video was used up by the download and
          // decryption; the video is ready now, so one more tap plays it.
          setHint("Ready. Tap again to play.");
          setStatus("paused");
        } else {
          setError("This device can't play this video.");
          setStatus("error");
        }
      }
    },
    [pause],
  );

  const totalS = durationMs ? durationMs / 1000 : mediaDuration;

  const seekToFraction = (fraction) => {
    const el = videoRef.current;
    const total = totalS;
    if (!el || !total) return;
    const clamped = Math.min(1, Math.max(0, fraction));
    el.currentTime = clamped * total;
    dragRef.current.last = clamped;
    setProgress(clamped);
  };

  const seekBySeconds = (delta) => {
    const el = videoRef.current;
    const total = totalS;
    if (!el || !total) return;
    seekToFraction((el.currentTime + delta) / total);
  };

  // Where a pointer is on the ring: how far round it is (clockwise from the
  // top) and whether it is on the ring itself.
  const readRing = (event) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    const scale = rect.width / SIZE;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += 2 * Math.PI;
    return { fraction: angle / (2 * Math.PI), onRing: Math.abs(Math.hypot(dx, dy) / scale - RADIUS) <= GRAB };
  };

  const onRingDown = (event) => {
    if (!source) return; // nothing to seek in until the video has been loaded
    const hit = readRing(event);
    if (!hit?.onRing) return; // a press on the picture is a tap: play/pause
    event.preventDefault();
    try {
      wrapRef.current?.setPointerCapture?.(event.pointerId);
    } catch (_) {
      // (a synthetic or already-released pointer: moves still arrive while over the ring)
    }
    dragRef.current = { active: true, last: hit.fraction, suppressClick: true };
    setDragging(true);
    seekToFraction(hit.fraction);
  };

  const onRingMove = (event) => {
    if (!dragRef.current.active) return;
    const hit = readRing(event);
    if (!hit) return;
    // Carried over the top: stop at the end (or the start) instead of jumping.
    let fraction = hit.fraction;
    if (dragRef.current.last > 0.75 && fraction < 0.25) fraction = 1;
    else if (dragRef.current.last < 0.25 && fraction > 0.75) fraction = 0;
    seekToFraction(fraction);
  };

  const onRingUp = () => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    setDragging(false);
    // The click that ends a drag is not a tap on the picture.
    setTimeout(() => {
      dragRef.current.suppressClick = false;
    }, 60);
  };

  const onSliderKey = (event) => {
    if (!source) return;
    const keys = {
      ArrowRight: () => seekBySeconds(KEY_STEP_S),
      ArrowUp: () => seekBySeconds(KEY_STEP_S),
      ArrowLeft: () => seekBySeconds(-KEY_STEP_S),
      ArrowDown: () => seekBySeconds(-KEY_STEP_S),
      Home: () => seekToFraction(0),
      End: () => seekToFraction(1),
    };
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    act();
  };

  const onToggle = async () => {
    if (dragRef.current.suppressClick) return;
    if (status === "loading") return;
    if (status === "playing") return pause();
    if (source) return play(source);

    setStatus("loading");
    setError("");
    setHint("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const loaded = await loadVideoNote({
        msg,
        user,
        services: getE2eeServices(),
        fetchCiphertext,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSource(loaded.url);
      setSenderPending(Boolean(loaded.senderPending));
      if (loaded.posterUrl && !poster) setPoster(loaded.posterUrl);
      setStatus("paused");
      await play(loaded.url);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(friendlyDecryptError(e) || "Could not load this video message.");
      setStatus("error");
    }
  };

  const playing = status === "playing";
  // The bullet shows once there is something to seek in and it is in use.
  const seekable = Boolean(source) && (playing || progress > 0 || dragging);
  const label = `${playing ? "Pause" : "Play"} video message, ${formatDurationMs(durationMs)}`;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        ref={wrapRef}
        className="relative touch-manipulation"
        style={{ position: "relative", width: SIZE, height: SIZE, maxWidth: "62vw", maxHeight: "62vw" }}
        onPointerDownCapture={onRingDown}
        onPointerMove={onRingMove}
        onPointerUp={onRingUp}
        onPointerCancel={onRingUp}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          aria-busy={status === "loading"}
          className="absolute inset-[5px] overflow-hidden rounded-full bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          {poster ? (
            <img
              src={poster}
              alt=""
              className={`absolute inset-0 h-full w-full object-cover ${source && playing ? "opacity-0" : "scale-110 blur-[1px]"}`}
              draggable="false"
            />
          ) : null}
          <video
            ref={videoRef}
            playsInline
            preload="none"
            disablePictureInPicture
            controlsList="nodownload noplaybackrate"
            onError={() => {
              if (!videoRef.current?.getAttribute("src")) return;
              setError("This device can't play this video.");
              setStatus("error");
            }}
            onLoadedMetadata={(e) => {
              if (Number.isFinite(e.currentTarget.duration)) setMediaDuration(e.currentTarget.duration);
            }}
            onTimeUpdate={(e) => {
              const total = durationMs || (Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration * 1000 : 0);
              if (total) setProgress(Math.min(1, (e.currentTarget.currentTime * 1000) / total));
            }}
            onEnded={() => {
              setStatus("paused");
              setProgress(0);
              if (activePause === pause) activePause = null;
              if (videoRef.current) videoRef.current.currentTime = 0;
            }}
            className={`absolute inset-0 h-full w-full object-cover ${source && (playing || progress > 0) ? "" : "invisible"}`}
          />
          {status !== "playing" ? (
            <span className="absolute inset-0 flex items-center justify-center bg-black/25 text-white">
              {status === "loading" ? (
                <LoaderCircle className="h-8 w-8 animate-spin" />
              ) : status === "error" ? (
                <TriangleAlert className="h-8 w-8 text-amber-300" />
              ) : (
                <Play size={34} className="drop-shadow" />
              )}
            </span>
          ) : (
            <span className="absolute inset-0 flex items-end justify-center pb-3 text-white opacity-0 transition hover:opacity-100">
              <Pause size={22} className="drop-shadow" />
            </span>
          )}
        </button>
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="pointer-events-none"
          // Fills the ring's box and starts the progress at the top.
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", transform: "rotate(-90deg)", pointerEvents: "none" }}
          aria-hidden="true"
        >
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-emerald-900/10 dark:stroke-white/10" />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
            className="stroke-emerald-500"
            style={{ transition: dragging ? "none" : "stroke-dashoffset 250ms linear" }}
          />
          {seekable ? (
            <circle
              data-testid="seek-bullet"
              cx={SIZE / 2 + RADIUS * Math.cos(2 * Math.PI * progress)}
              cy={SIZE / 2 + RADIUS * Math.sin(2 * Math.PI * progress)}
              r={dragging ? 11 : 8}
              strokeWidth={3}
              className="fill-white stroke-emerald-500 drop-shadow"
              style={{ transition: dragging ? "none" : "cx 250ms linear, cy 250ms linear, r 120ms ease" }}
            />
          ) : null}
        </svg>
        <div
          role="slider"
          aria-label="Seek video message"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalS)}
          aria-valuenow={Math.round(progress * totalS)}
          aria-valuetext={`${formatDurationMs(progress * totalS * 1000)} of ${formatDurationMs(durationMs)}`}
          tabIndex={source ? 0 : -1}
          onKeyDown={onSliderKey}
          className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        />
        <span className="pointer-events-none absolute bottom-2 left-3 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
          <Lock size={10} aria-hidden="true" />
          {formatDurationMs(source && progress > 0 ? Math.max(0, durationMs - progress * durationMs) : durationMs)}
        </span>
      </div>
      {status === "error" && error ? (
        <p className="max-w-[16rem] text-center text-xs text-rose-600 dark:text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      {hint && status !== "error" ? (
        <p className="max-w-[16rem] text-center text-xs text-slate-500 dark:text-slate-400" role="status">
          {hint}
        </p>
      ) : null}
      {senderPending ? (
        <p className="flex max-w-[16rem] items-center justify-center gap-1.5 text-center text-xs text-amber-700 dark:text-amber-300">
          <ShieldOff size={12} aria-hidden="true" />
          <span>Sent from a new device.</span>
          <button type="button" className="font-semibold underline" onClick={() => setReviewOpen(true)}>
            Check
          </button>
        </p>
      ) : null}
      {reviewOpen ? (
        <Suspense fallback={null}>
          <SafetyNumberModal
            open
            onClose={() => setReviewOpen(false)}
            selfUser={user}
            chatId={msg?.chat_id || msg?.chatId}
            peer={{ userId: msg?.user_id || msg?.userId, username: msg?.username, nickname: msg?.nickname }}
            onChanged={() => setSenderPending(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

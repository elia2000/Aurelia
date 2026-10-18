import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Lock, LoaderCircle, Pause, Play, RotateCcw, ShieldOff, TriangleAlert, VolumeX } from "../../../icons/lucide.js";
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
import { useAutoplayAllowed, useOnScreen } from "./useVideoNoteAutoplay.js";
import "./videoNote.css";

// Only loaded when the sender's keys need a look.
const SafetyNumberModal = lazy(() => import("../../calls/SafetyNumberModal.jsx"));

// The drawing the ring and the bullet are made in; it is scaled to the circle.
const SIZE = 240;
const STROKE = 3;
// The picture sits this far inside the box, so the ring runs round its edge.
const INSET = 7;
const RADIUS = SIZE / 2 - STROKE / 2 - 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// A press this close to the ring (in the 240-unit drawing) grabs the seek bullet.
const GRAB = 16;
const KEY_STEP_S = 5;
// A round video that is only looping waits a moment before it starts, so
// scrolling past it costs nothing.
const AUTOPLAY_DELAY_MS = 250;

// Only one video message plays with sound at a time: the pause function of the one that does.
let activeSound = null;

/**
 * A round, end-to-end encrypted video message, like Telegram's: just the
 * circle on the chat background. While it is on screen it plays by itself,
 * muted and looping; a tap plays it from the start with sound and a ring that
 * fills as it goes, and another tap pauses it. The file is only downloaded and
 * decrypted when it is about to play (so scrolling a chat costs no data when
 * autoplay is off); until then only the tiny poster frame is decrypted.
 *
 * `header` is whatever goes above the circle (the sender's name, a forwarded-from
 * line, the quoted message); it is drawn as a compact chip, not inside the circle.
 * The time and read mark are the message's own and sit over the circle's corner.
 */
export default function VideoNoteBubble({ msg, user, header = null }) {
  const envelope = msg?.e2ee || null;
  const key = videoNoteKey(msg);
  const durationMs = Number(envelope?.durationMs || 0);
  const sizeBytes = Number((Array.isArray(msg?.files) && msg.files[0]?.sizeBytes) || 0);
  const own = Boolean(user?.id) && (msg?.user_id || msg?.userId) === user.id;

  const [poster, setPoster] = useState(() => getRememberedVideoNote(key)?.posterUrl || null);
  const [posterPending, setPosterPending] = useState(() => Boolean(envelope) && !getRememberedVideoNote(key)?.posterUrl);
  const [source, setSource] = useState(() => getRememberedVideoNote(key)?.url || null);
  const [engaged, setEngaged] = useState(false); // played by a person: sound on, ring showing
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [frame, setFrame] = useState(false); // the video has a picture to show
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
  const loadRef = useRef(null); // the download in progress, shared by a tap and the autoplay
  const engagedRef = useRef(false);
  const onScreenRef = useRef(false);
  const dragRef = useRef({ active: false, last: 0, suppressClick: false });

  const onScreen = useOnScreen(wrapRef);
  const autoplayAllowed = useAutoplayAllowed(sizeBytes);
  useEffect(() => {
    onScreenRef.current = onScreen;
  }, [onScreen]);

  useEffect(() => {
    let cancelled = false;
    if (poster || !envelope) {
      setPosterPending(false);
      return undefined;
    }
    setPosterPending(true);
    loadVideoNotePoster({ msg, user, services: getE2eeServices() }).then((url) => {
      if (cancelled) return;
      if (url) setPoster(url);
      setPosterPending(false);
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

  const pause = useCallback(() => {
    videoRef.current?.pause();
    setPlaying(false);
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (activeSound === pause) activeSound = null;
    },
    [pause],
  );

  const setEngagement = useCallback((value) => {
    engagedRef.current = value;
    setEngaged(value);
  }, []);

  // The decrypted copy, downloaded and verified when it is not on this device
  // yet. Asked for again at every start: the memory of copies is small, and
  // one that was dropped has an address that no longer works.
  const acquire = useCallback(() => {
    if (loadRef.current) return loadRef.current;
    setLoading(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    const promise = loadVideoNote({
      msg,
      user,
      services: getE2eeServices(),
      fetchCiphertext,
      signal: controller.signal,
    })
      .then((loaded) => {
        if (controller.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        setSenderPending(Boolean(loaded.senderPending));
        setPoster((current) => current || loaded.posterUrl || null);
        setSource(loaded.url);
        return loaded.url;
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(friendlyDecryptError(e) || "Could not load this video message.");
        throw e;
      })
      .finally(() => {
        loadRef.current = null;
        setLoading(false);
      });
    loadRef.current = promise;
    return promise;
  }, [msg, user]);

  const attach = (el, url) => {
    if (el.src === url) return;
    setFrame(false);
    el.src = url;
  };

  // The quiet state of a round video on screen: muted, looping, no ring.
  const startLoop = useCallback(async () => {
    const running = videoRef.current;
    if (engagedRef.current || (running && !running.paused && running.loop)) return;
    try {
      const url = await acquire();
      const el = videoRef.current;
      // It moved on while the file came in: a tap took over, or it scrolled away.
      if (!el || engagedRef.current || !onScreenRef.current) return;
      attach(el, url);
      el.muted = true;
      el.loop = true;
      await el.play();
      setPlaying(true);
    } catch {
      // A failed download is already explained on the circle. A browser that
      // refuses to start a muted video leaves the poster and its play button.
    }
  }, [acquire]);

  useEffect(() => {
    if (engaged) return undefined;
    if (onScreen && autoplayAllowed && !error) {
      const timer = setTimeout(startLoop, AUTOPLAY_DELAY_MS);
      return () => clearTimeout(timer);
    }
    const el = videoRef.current;
    if (el && !el.paused) pause();
    return undefined;
  }, [onScreen, autoplayAllowed, engaged, error, startLoop, pause]);

  // The person's play: from the start the first time, with sound.
  const engage = useCallback(async () => {
    const fromStart = !engagedRef.current;
    setEngagement(true);
    setHint("");
    let url;
    try {
      url = await acquire();
    } catch {
      setEngagement(false); // the download failed: the circle explains why
      return;
    }
    const el = videoRef.current;
    if (!el) return;
    try {
      attach(el, url);
      if (activeSound && activeSound !== pause) activeSound();
      activeSound = pause;
      el.loop = false;
      el.muted = false;
      if (fromStart) {
        el.currentTime = 0;
        setProgress(0);
      }
      await el.play();
      setPlaying(true);
    } catch (e) {
      if (e?.name === "NotAllowedError") {
        // The tap that asked for the video was used up by the download and
        // decryption; the video is ready now, so one more tap plays it.
        setHint("Ready. Tap again to play.");
        setPlaying(false);
      } else if (e?.name !== "AbortError") {
        // (an interrupted start is ignored: whatever interrupted it carries on)
        setError("This device can't play this video.");
        setEngagement(false);
        setPlaying(false);
      }
    }
  }, [acquire, pause, setEngagement]);

  const retry = () => {
    setError("");
    void engage();
  };

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
    if (!source || !engaged) return; // nothing to seek in until a person plays it
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
    if (!source || !engaged) return;
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

  // A tap plays it with sound, another pauses it, a third carries on.
  const onToggle = () => {
    if (dragRef.current.suppressClick) return;
    if (error) return retry();
    if (loading && engagedRef.current) return;
    if (engagedRef.current && playing) return pause();
    void engage();
  };

  const onEnded = () => {
    // Back to the quiet state: the effect above starts the muted loop again if it is on screen.
    const el = videoRef.current;
    if (activeSound === pause) activeSound = null;
    if (el) {
      el.currentTime = 0;
      el.muted = true;
      el.loop = true;
    }
    setEngagement(false);
    setPlaying(false);
    setProgress(0);
  };

  const showRing = engaged || dragging;
  const seekable = Boolean(source) && engaged;
  const label = `${engaged && playing ? "Pause" : "Play"} video message, ${formatDurationMs(durationMs)}`;
  // The pill counts down while a person is watching, and shows the length otherwise.
  const remainingMs = Math.ceil(Math.max(0, durationMs - (engaged ? progress * durationMs : 0)) / 1000) * 1000;
  const placeholder = !poster && !frame;
  // What sits on the middle of the circle.
  const centre = error ? "" : loading || (placeholder && posterPending) ? "spinner" : !playing ? "play" : engaged ? "pause" : "";

  return (
    <div className="flex flex-col gap-1" data-video-note>
      {header ? (
        <div
          data-video-note-header
          className={`min-w-0 max-w-full self-start rounded-2xl px-2.5 py-1 text-[13px] leading-[1.25] shadow-xs ${
            own
              ? "bg-emerald-200 text-emerald-950 dark:bg-emerald-800 dark:text-white"
              : "bg-white/90 text-slate-800 dark:bg-slate-800/75 dark:text-slate-100"
          }`}
        >
          {header}
        </div>
      ) : null}
      {senderPending ? (
        <p className="flex w-fit max-w-full items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs text-amber-900 dark:bg-amber-500/20 dark:text-amber-100">
          <ShieldOff size={12} aria-hidden="true" className="shrink-0" />
          <span>Sent from a new device.</span>
          <button type="button" className="font-semibold underline" onClick={() => setReviewOpen(true)}>
            Check
          </button>
        </p>
      ) : null}
      <div
        ref={wrapRef}
        className="relative touch-manipulation"
        style={{ position: "relative", width: "100%", aspectRatio: "1" }}
        onPointerDownCapture={onRingDown}
        onPointerMove={onRingMove}
        onPointerUp={onRingUp}
        onPointerCancel={onRingUp}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          aria-busy={loading}
          className="absolute inset-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          style={{ position: "absolute", inset: 0, padding: `${(INSET / SIZE) * 100}%` }}
        >
          <span
            className={`relative block h-full w-full overflow-hidden rounded-full ${
              placeholder ? "bg-slate-300 dark:bg-slate-700" : "bg-slate-800"
            }`}
          >
            {poster ? (
              <img
                src={poster}
                alt=""
                className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${frame ? "opacity-0" : "scale-110 blur-[1px]"}`}
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
                setEngagement(false);
                setPlaying(false);
              }}
              onLoadedMetadata={(e) => {
                if (Number.isFinite(e.currentTarget.duration)) setMediaDuration(e.currentTarget.duration);
              }}
              onLoadedData={() => setFrame(true)}
              onPlaying={() => {
                setFrame(true);
                setPlaying(true);
              }}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(e) => {
                if (!engagedRef.current) return;
                const total = durationMs || (Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration * 1000 : 0);
                if (total) setProgress(Math.min(1, (e.currentTarget.currentTime * 1000) / total));
              }}
              onEnded={onEnded}
              className={`absolute inset-0 h-full w-full object-cover ${frame ? "" : "invisible"}`}
            />
            {centre ? (
              <span
                className={`absolute inset-0 flex items-center justify-center text-white ${
                  centre === "pause" ? "opacity-0 transition-opacity hover:opacity-100" : ""
                }`}
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm">
                  {centre === "spinner" ? (
                    <LoaderCircle className="h-7 w-7 animate-spin" />
                  ) : centre === "pause" ? (
                    <Pause size={24} className="drop-shadow" />
                  ) : (
                    <Play size={26} className="translate-x-px drop-shadow" />
                  )}
                </span>
              </span>
            ) : null}
          </span>
        </button>
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className={`pointer-events-none overflow-visible transition-opacity duration-200 motion-reduce:transition-none ${showRing ? "opacity-100" : "opacity-0"}`}
          // Fills the ring's box and starts the progress at the top.
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", transform: "rotate(-90deg)", pointerEvents: "none" }}
          aria-hidden="true"
        >
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-slate-900/15 dark:stroke-white/20" />
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
              r={dragging ? 9 : 6.5}
              strokeWidth={2.5}
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
          tabIndex={source && engaged ? 0 : -1}
          onKeyDown={onSliderKey}
          className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        />
        {error ? (
          <div
            role="alert"
            className="absolute flex flex-col items-center justify-center gap-1.5 rounded-full bg-slate-900/80 px-9 text-center text-white"
            style={{ position: "absolute", inset: `${(INSET / SIZE) * 100}%` }}
          >
            <TriangleAlert className="h-6 w-6 shrink-0 text-amber-300" aria-hidden="true" />
            <p className="text-[11px] leading-snug">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold transition hover:bg-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              <RotateCcw size={12} aria-hidden="true" />
              Retry
            </button>
          </div>
        ) : null}
        <span
          data-video-note-duration
          className="pointer-events-none absolute left-[22%] top-[13%] inline-flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-[3px] text-[11px] font-semibold leading-none tabular-nums text-white backdrop-blur-sm"
        >
          <span>{formatDurationMs(remainingMs)}</span>
          {engaged ? null : <VolumeX size={11} aria-label="Sound off" role="img" />}
        </span>
        <span
          data-video-note-lock
          className="pointer-events-none absolute bottom-[16%] left-[16%] inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm"
        >
          <Lock size={10} aria-label="End-to-end encrypted" role="img" />
        </span>
        {hint && !error ? (
          <p
            role="status"
            className="pointer-events-none absolute inset-x-[18%] bottom-[16%] rounded-full bg-black/55 px-2 py-1 text-center text-[11px] leading-tight text-white"
          >
            {hint}
          </p>
        ) : null}
      </div>
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

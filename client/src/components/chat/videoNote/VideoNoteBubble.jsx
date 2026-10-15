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
  const videoRef = useRef(null);
  const abortRef = useRef(null);

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

  const onToggle = async () => {
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
  const label = `${playing ? "Pause" : "Play"} video message, ${formatDurationMs(durationMs)}`;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: SIZE, height: SIZE, maxWidth: "62vw", maxHeight: "62vw" }}>
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
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="pointer-events-none absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
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
            style={{ transition: "stroke-dashoffset 250ms linear" }}
          />
        </svg>
        <span className="pointer-events-none absolute bottom-2 left-3 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
          <Lock size={10} aria-hidden="true" />
          {formatDurationMs(durationMs)}
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

import { useEffect, useRef, useState } from "react";
import { describeCameraError, stopStream } from "../../utils/qr/qrScanner.js";

const FRAME_INTERVAL_MS = 250;

/**
 * Runs the camera and the barcode detector while `active` is true and hands
 * the first QR code's text to `onResult` (once). The camera is released when
 * a code is read, when `active` turns false and when the component goes away.
 *
 * @returns {{videoRef: object, phase: "idle"|"starting"|"scanning"|"error", error: string}}
 *          put `videoRef` on the <video> element that shows the picture
 */
export function useQrScanner({ active, onResult }) {
  const videoRef = useRef(null);
  const onResultRef = useRef(onResult);
  const [state, setState] = useState({ phase: "idle", error: "" });

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    if (!active) {
      setState({ phase: "idle", error: "" });
      return undefined;
    }
    let cancelled = false;
    let stream = null;
    let timer = null;
    setState({ phase: "starting", error: "" });

    const release = () => {
      window.clearTimeout(timer);
      stopStream(stream);
      stream = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    (async () => {
      try {
        const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) throw new Error("no video element");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play().catch(() => {});
        if (cancelled) return;
        setState({ phase: "scanning", error: "" });

        const look = async () => {
          if (cancelled) return;
          try {
            if (video.readyState >= 2) {
              const codes = await detector.detect(video);
              const hit = (codes || []).find((code) => typeof code?.rawValue === "string" && code.rawValue);
              if (hit && !cancelled) {
                cancelled = true;
                release();
                setState({ phase: "idle", error: "" });
                onResultRef.current?.(hit.rawValue);
                return;
              }
            }
          } catch {
            // A frame that cannot be read is skipped.
          }
          if (!cancelled) timer = window.setTimeout(look, FRAME_INTERVAL_MS);
        };
        look();
      } catch (error) {
        if (cancelled) return;
        release();
        setState({ phase: "error", error: describeCameraError(error) });
      }
    })();

    return () => {
      cancelled = true;
      release();
    };
  }, [active]);

  return { videoRef, phase: state.phase, error: state.error };
}

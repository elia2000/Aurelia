import { POSTER_QUALITY, POSTER_SIZE_PX } from "./config.js";

/**
 * Captures a tiny square JPEG (about 2-4 kB) of the current video frame. It is
 * encrypted with the message and shown while the full video is still not
 * downloaded, which spares the recipient's data until they choose to watch.
 */
export function captureVideoPoster(videoEl) {
  return new Promise((resolve) => {
    try {
      const width = videoEl?.videoWidth || 0;
      const height = videoEl?.videoHeight || 0;
      if (!width || !height) return resolve(null);
      const side = Math.min(width, height);
      const canvas = document.createElement("canvas");
      canvas.width = POSTER_SIZE_PX;
      canvas.height = POSTER_SIZE_PX;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(
        videoEl,
        (width - side) / 2,
        (height - side) / 2,
        side,
        side,
        0,
        0,
        POSTER_SIZE_PX,
        POSTER_SIZE_PX,
      );
      canvas.toBlob((blob) => resolve(blob || null), "image/jpeg", POSTER_QUALITY);
    } catch (_) {
      resolve(null);
    }
  });
}

// Reading a QR code with the camera, using what the browser already has: the
// BarcodeDetector API (Chrome, Edge and Safari have it, Firefox does not) over
// a getUserMedia stream. Nothing is downloaded and no frame leaves the page.

/** True when this browser has both a barcode detector and a camera to feed it. */
export function hasQrScanApi() {
  if (typeof window === "undefined") return false;
  return Boolean(
    typeof window.BarcodeDetector === "function" &&
      window.isSecureContext !== false &&
      typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function",
  );
}

/** Whether the detector of this device can read QR codes (some know no formats at all). */
export async function detectorReadsQr() {
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return Array.isArray(formats) && formats.includes("qr_code");
  } catch {
    return false;
  }
}

/** What a failed camera start means for the person. */
export function describeCameraError(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "Camera access was blocked. Allow the camera for this site to scan, or compare the number instead.";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "No camera was found on this device.";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "The camera is in use by another app.";
    default:
      return "Could not start the camera.";
  }
}

export function stopStream(stream) {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // Already stopped.
  }
}

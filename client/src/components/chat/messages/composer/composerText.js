// Small text helpers shared by the composer and its strips.

export const normalizeComposerBody = (value) => {
  if (typeof value === "string") return value === "[object Object]" ? "" : value;
  if (value && typeof value === "object") {
    const text = value.text ?? value.body;
    return typeof text === "string" ? text : "";
  }
  return "";
};

export const formatVoiceDuration = (totalSeconds) => {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds || 0)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const FILE_SUMMARY =
  /^Sent (a media file|a photo|a video|a document|a voice message|\d+ (files|photos|videos|documents|media files|voice messages))$/i;

/** True when an edited message's body is only the generated "Sent a photo" line. */
export function isGeneratedFileSummary(body) {
  return FILE_SUMMARY.test(String(normalizeComposerBody(body) || "").trim());
}

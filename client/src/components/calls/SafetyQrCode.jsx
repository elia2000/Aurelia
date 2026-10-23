import { useMemo } from "react";
import { encodeQr } from "../../utils/qr/qrEncoder.js";
import { qrToSvgPath } from "../../utils/qr/qrSvg.js";

/**
 * A QR code as an inline SVG: crisp at any size, dark modules on a white
 * square with the four-module quiet zone the standard asks for. The white is
 * fixed on purpose, also in dark mode: a scanner needs dark on light.
 *
 * @param {string} payload  the text to encode
 * @param {string} label    what a screen reader says (the number itself is shown next to it)
 * @param {string} [description]  the same information as text, for assistive technology
 */
export default function SafetyQrCode({ payload, label, description = "", className = "" }) {
  const drawn = useMemo(() => {
    try {
      const code = encodeQr(payload, { ecc: "M" });
      return { ...qrToSvgPath(code.modules), version: code.version };
    } catch {
      return null;
    }
  }, [payload]);
  if (!drawn) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${drawn.size} ${drawn.size}`}
      shapeRendering="crispEdges"
      data-qr-version={drawn.version}
      className={`block aspect-square h-auto w-full rounded-xl bg-white ${className}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{label}</title>
      {description ? <desc>{description}</desc> : null}
      <rect width={drawn.size} height={drawn.size} fill="#ffffff" />
      <path d={drawn.d} fill="#000000" />
    </svg>
  );
}

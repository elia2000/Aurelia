import { SAS_EMOJI } from "./sasEmoji.js";

/**
 * Short authentication string: 4 emoji from 4 bytes of key-derived material.
 * Both call participants derive the same bytes; if a man-in-the-middle
 * substituted keys, the two screens show different emoji.
 */
export function sasEmoji(bytes, count = 4) {
  if (!bytes || bytes.length < count) {
    throw new Error("Not enough material for a verification code.");
  }
  return Array.from({ length: count }, (_, i) => SAS_EMOJI[bytes[i] & 0xff]);
}

// Turns the module matrix of `encodeQr` into what an inline <svg> needs: one
// path (a rectangle per horizontal run of dark modules, so a 57x57 code is a
// few hundred short commands, not three thousand elements) and the size of the
// square including the quiet zone.

/** The standard asks for a quiet zone of four light modules on every side. */
export const QUIET_ZONE_MODULES = 4;

/**
 * @param {boolean[][]} modules  rows of the matrix, true is dark
 * @param {number} [quiet=4]     light modules to leave around the code
 * @returns {{size: number, d: string}}  viewBox is `0 0 size size`
 */
export function qrToSvgPath(modules, quiet = QUIET_ZONE_MODULES) {
  const n = modules.length;
  const commands = [];
  for (let y = 0; y < n; y += 1) {
    const row = modules[y];
    for (let x = 0; x < n; x += 1) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < n && row[end + 1]) end += 1;
      const run = end - x + 1;
      commands.push(`M${x + quiet} ${y + quiet}h${run}v1h-${run}z`);
      x = end;
    }
  }
  return { size: n + quiet * 2, d: commands.join("") };
}

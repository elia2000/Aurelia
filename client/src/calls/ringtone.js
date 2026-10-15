// A short, quiet chime generated with WebAudio — no audio asset to download
// and almost no CPU: about 0.9 s of sound every 3 s while a call rings.
// Browsers may block audio until the user has interacted with the page; in
// that case the ringer stays silent and vibration/notification still apply.

const PATTERNS = {
  incoming: { notes: [880, 660, 880], gap: 0.18, length: 0.16, period: 3000, gain: 0.07 },
  outgoing: { notes: [440], gap: 0, length: 0.4, period: 3500, gain: 0.04 },
};

export function startRingtone(kind = "incoming") {
  const pattern = PATTERNS[kind] || PATTERNS.incoming;
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  let context = null;
  let timer = null;
  let stopped = false;

  const ring = () => {
    if (stopped || !context) return;
    const start = context.currentTime + 0.02;
    pattern.notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = start + index * (pattern.length + pattern.gap);
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(pattern.gain, at + 0.02);
      gain.gain.linearRampToValueAtTime(0, at + pattern.length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + pattern.length + 0.05);
    });
    if (kind === "incoming") {
      try {
        navigator.vibrate?.([200, 120, 200]);
      } catch (_) {}
    }
  };

  try {
    if (Ctx) {
      context = new Ctx();
      if (context.state === "suspended") context.resume().catch(() => {});
    }
  } catch (_) {
    context = null;
  }
  ring();
  timer = setInterval(ring, pattern.period);

  return () => {
    stopped = true;
    clearInterval(timer);
    try {
      navigator.vibrate?.(0);
    } catch (_) {}
    try {
      context?.close();
    } catch (_) {}
  };
}

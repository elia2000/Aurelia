// What a person can choose for sound during a call, worked out from the list
// the browser gives (pure functions, so they can be tested without one).
//
//  - A computer: pick the microphone and, where the browser lets a page choose
//    (setSinkId), the speakers.
//  - Chrome on a phone cannot choose the speaker like that. It lists the ways
//    the phone can route a call (speakerphone, earpiece, Bluetooth, ...) as
//    extra microphone entries, and opening one re-routes the call's sound. Two
//    or more of those turn into a phone-style route choice.

import { defaultStorage } from "../utils/safeStorage.js";

const ROUTES = [
  { kind: "earpiece", name: "Phone earpiece", label: /^headset earpiece$/i },
  { kind: "speaker", name: "Speaker", label: /^speakerphone$/i },
  { kind: "wired", name: "Wired headset", label: /^wired headset$/i },
  { kind: "bluetooth", name: "Bluetooth", label: /^bluetooth headset$/i },
  { kind: "usb", name: "USB audio", label: /^usb audio$/i },
];

// Chromium on Windows adds a second "communications" copy of the default
// devices; it only confuses a list that already has "Default".
const hidden = (device) => device.deviceId === "communications";

/** Whether a speaker id means "whatever the system uses" (Firefox and Safari list it with an empty id). */
export const isDefaultOutput = (id) => !id || id === "default";

/** What to hand setSinkId: an empty id puts the sound back on the default speaker everywhere. */
export const sinkIdFor = (id) => (isDefaultOutput(id) ? "" : String(id));

const unique = (list) => {
  const seen = new Set();
  return list.filter((device) => {
    if (seen.has(device.id)) return false;
    seen.add(device.id);
    return true;
  });
};

// Chromium lists the system default as a "default" entry next to the real
// device it stands for (they share a group). Listing both would make one
// microphone look like a choice, so the real one is left out.
const withoutDefaultTwin = (list) => {
  const standIn = list.find((device) => device.id === "default" && device.group);
  if (!standIn) return list;
  return list.filter((device) => device.id === "default" || device.group !== standIn.group);
};

const named = (devices, fallback) =>
  devices.map((device, index) => ({ ...device, label: device.label?.trim() || `${fallback} ${index + 1}` }));

/**
 * @param {MediaDeviceInfo[]} devices   from enumerateDevices()
 * @param {{canPickOutput: boolean}} options  whether the page may route to a speaker
 */
export function buildAudioModel(devices, { canPickOutput = false } = {}) {
  const list = Array.isArray(devices) ? devices : [];
  const pick = (kind) =>
    unique(list.filter((d) => d.kind === kind && !hidden(d)).map((d) => ({ id: d.deviceId, label: d.label, group: d.groupId || "" })));
  const allInputs = pick("audioinput");

  // The phone's own routes are looked for among every entry: a phone may give them all one group.
  const routes = ROUTES.flatMap((route) => {
    const match = allInputs.find((input) => route.label.test(input.label.trim()));
    return match ? [{ kind: route.kind, id: match.id, name: route.name }] : [];
  });
  if (routes.length >= 2) {
    return { inputs: [], outputs: [], routes, canPickInput: false, canPickOutput: false };
  }
  const inputs = withoutDefaultTwin(allInputs);
  const outputs = withoutDefaultTwin(pick("audiooutput"));
  const namedInputs = named(inputs, "Microphone").map(({ id, label }) => ({ id, label }));
  const namedOutputs = canPickOutput ? named(outputs, "Speaker").map(({ id, label }) => ({ id, label })) : [];
  return {
    inputs: namedInputs,
    outputs: namedOutputs,
    routes: [],
    canPickInput: namedInputs.length > 1,
    canPickOutput: namedOutputs.length > 1,
  };
}

/**
 * Which route a phone uses when the page asked for no particular one: a
 * headset if there is one, otherwise the loudspeaker (never the earpiece).
 */
export function guessDefaultRoute(routes) {
  for (const kind of ["wired", "usb", "bluetooth", "speaker"]) {
    const found = routes.find((r) => r.kind === kind);
    if (found) return found;
  }
  return null;
}

/** What the quick speaker button switches to from the route in use (null: nothing to switch to). */
export function nextQuickRoute(routes, currentKind) {
  const earpiece = routes.find((r) => r.kind === "earpiece");
  const speaker = routes.find((r) => r.kind === "speaker");
  if (currentKind === "speaker") return earpiece || null;
  return speaker || null;
}

const OUTPUT_KEY = "aurelle-call-output";

export function loadOutputChoice(storage = defaultStorage()) {
  try {
    return storage?.getItem(OUTPUT_KEY) || "default";
  } catch (_) {
    return "default";
  }
}

export function saveOutputChoice(id, storage = defaultStorage()) {
  try {
    storage?.setItem(OUTPUT_KEY, String(id || "default"));
  } catch (_) {
    // not remembered
  }
}

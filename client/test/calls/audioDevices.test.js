import { describe, test, expect } from "vitest";
import {
  buildAudioModel,
  isDefaultOutput,
  sinkIdFor,
  guessDefaultRoute,
  loadOutputChoice,
  nextQuickRoute,
  saveOutputChoice,
} from "../../src/calls/audioDevices.js";

const input = (deviceId, label, groupId) => ({ kind: "audioinput", deviceId, label, groupId });
const output = (deviceId, label, groupId) => ({ kind: "audiooutput", deviceId, label, groupId });

describe("a desktop with several microphones and speakers", () => {
  const devices = [
    input("default", "Default - Built-in Microphone"),
    input("mic-1", "Built-in Microphone"),
    input("mic-2", "USB Headset"),
    output("default", "Default - Speakers"),
    output("out-1", "Speakers"),
    output("out-2", "USB Headset"),
    { kind: "videoinput", deviceId: "cam", label: "Camera" },
  ];

  test("lists the microphones and, where the browser lets a page choose, the speakers", () => {
    const model = buildAudioModel(devices, { canPickOutput: true });
    expect(model.inputs.map((d) => d.id)).toEqual(["default", "mic-1", "mic-2"]);
    expect(model.outputs.map((d) => d.id)).toEqual(["default", "out-1", "out-2"]);
    expect(model.canPickOutput).toBe(true);
    expect(model.canPickInput).toBe(true);
    expect(model.routes).toEqual([]);
  });

  test("offers no speaker choice when the browser cannot route to one", () => {
    const model = buildAudioModel(devices, { canPickOutput: false });
    expect(model.canPickOutput).toBe(false);
    expect(model.outputs).toEqual([]);
    expect(model.canPickInput).toBe(true);
  });

  test("a single microphone is nothing to choose between", () => {
    const model = buildAudioModel([input("default", "Microphone"), output("default", "Speakers")], { canPickOutput: true });
    expect(model.canPickInput).toBe(false);
    expect(model.canPickOutput).toBe(false);
  });

  test("devices without a name (permission not given yet) get a numbered one", () => {
    const model = buildAudioModel([input("a", ""), input("b", "")], { canPickOutput: false });
    expect(model.inputs.map((d) => d.label)).toEqual(["Microphone 1", "Microphone 2"]);
  });

  test("the same device listed twice is shown once", () => {
    const model = buildAudioModel([input("a", "Mic"), input("a", "Mic"), input("b", "Other")], { canPickOutput: false });
    expect(model.inputs.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("Windows' extra 'communications' entry and Firefox's unnamed default speaker", () => {
  test("the Windows-only 'communications' devices are left out", () => {
    const model = buildAudioModel(
      [
        input("default", "Default - Mic"),
        input("communications", "Communications - Mic"),
        input("mic-1", "Mic"),
        output("default", "Default - Speakers"),
        output("communications", "Communications - Speakers"),
        output("out-1", "Speakers"),
      ],
      { canPickOutput: true },
    );
    expect(model.inputs.map((d) => d.id)).toEqual(["default", "mic-1"]);
    expect(model.outputs.map((d) => d.id)).toEqual(["default", "out-1"]);
  });

  test("a default speaker with an empty id counts as the default, and the default resets with an empty sink id", () => {
    expect(isDefaultOutput("")).toBe(true);
    expect(isDefaultOutput("default")).toBe(true);
    expect(isDefaultOutput(undefined)).toBe(true);
    expect(isDefaultOutput("out-1")).toBe(false);
    expect(sinkIdFor("default")).toBe("");
    expect(sinkIdFor("")).toBe("");
    expect(sinkIdFor("out-1")).toBe("out-1");
  });
});

describe("Chrome on a phone, where the route is a microphone entry", () => {
  const devices = [
    input("default", "Default"),
    input("route-speaker", "Speakerphone"),
    input("route-earpiece", "Headset earpiece"),
    input("route-bt", "Bluetooth headset"),
    output("default", "Default"),
  ];

  test("turns those entries into routes with names a person knows", () => {
    const model = buildAudioModel(devices, { canPickOutput: false });
    expect(model.routes).toEqual([
      { kind: "earpiece", id: "route-earpiece", name: "Phone earpiece" },
      { kind: "speaker", id: "route-speaker", name: "Speaker" },
      { kind: "bluetooth", id: "route-bt", name: "Bluetooth" },
    ]);
    // The routes replace the plain lists.
    expect(model.canPickInput).toBe(false);
    expect(model.canPickOutput).toBe(false);
  });

  test("one such entry alone is not a choice", () => {
    const model = buildAudioModel([input("default", "Default"), input("route-speaker", "Speakerphone")], { canPickOutput: false });
    expect(model.routes).toEqual([]);
  });

  test("the names are matched in any case", () => {
    const model = buildAudioModel([input("a", "SPEAKERPHONE"), input("b", "headset earpiece")], { canPickOutput: false });
    expect(model.routes.map((r) => r.kind)).toEqual(["earpiece", "speaker"]);
  });

  test("a device only called that in passing is not a route", () => {
    const model = buildAudioModel([input("a", "My Speakerphone Pro Mic"), input("b", "Studio Mic")], { canPickOutput: false });
    expect(model.routes).toEqual([]);
  });

  test("the route in use follows the microphone, and the default is the headset if there is one, else the speaker", () => {
    const { routes } = buildAudioModel(devices, { canPickOutput: false });
    expect(guessDefaultRoute(routes).kind).toBe("bluetooth");
    expect(guessDefaultRoute(routes.filter((r) => r.kind !== "bluetooth")).kind).toBe("speaker");
    expect(guessDefaultRoute([{ kind: "earpiece", id: "e", name: "x" }, { kind: "speaker", id: "s", name: "y" }]).kind).toBe("speaker");
    expect(guessDefaultRoute([])).toBeNull();
  });

  test("the quick button flips between the earpiece and the speaker, and from anything else goes to the speaker", () => {
    const { routes } = buildAudioModel(devices, { canPickOutput: false });
    expect(nextQuickRoute(routes, "speaker").kind).toBe("earpiece");
    expect(nextQuickRoute(routes, "earpiece").kind).toBe("speaker");
    expect(nextQuickRoute(routes, "bluetooth").kind).toBe("speaker");
    // Without an earpiece there is nothing to flip to.
    expect(nextQuickRoute(routes.filter((r) => r.kind !== "earpiece"), "speaker")).toBeNull();
  });
});

describe("remembering the speaker", () => {
  const memory = () => {
    const data = new Map();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
  };
  test("is kept and read back", () => {
    const storage = memory();
    expect(loadOutputChoice(storage)).toBe("default");
    saveOutputChoice("out-2", storage);
    expect(loadOutputChoice(storage)).toBe("out-2");
  });
  test("survives unreadable storage", () => {
    const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(loadOutputChoice(broken)).toBe("default");
    expect(() => saveOutputChoice("x", broken)).not.toThrow();
  });
});

describe("Chromium's virtual default entry", () => {
  test("one microphone listed as Default and as itself is not a choice", () => {
    const model = buildAudioModel(
      [input("default", "Default - Built-in Microphone", "g1"), input("mic-1", "Built-in Microphone", "g1")],
      { canPickOutput: false },
    );
    expect(model.canPickInput).toBe(false);
    expect(model.inputs.map((d) => d.id)).toEqual(["default"]);
  });

  test("one speaker listed as Default and as itself is not a choice either", () => {
    const model = buildAudioModel(
      [input("default", "Mic", "m"), output("default", "Default - Speakers", "g1"), output("out-1", "Speakers", "g1")],
      { canPickOutput: true },
    );
    expect(model.canPickOutput).toBe(false);
  });

  test("with a second device the default stays as one choice and the second is another", () => {
    const model = buildAudioModel(
      [
        input("default", "Default - Built-in", "g1"),
        input("mic-1", "Built-in", "g1"),
        input("mic-2", "USB Headset", "g2"),
      ],
      { canPickOutput: false },
    );
    expect(model.canPickInput).toBe(true);
    expect(model.inputs.map((d) => d.id)).toEqual(["default", "mic-2"]);
  });

  test("a phone that gives all its routes one group still lists them all", () => {
    const model = buildAudioModel(
      [
        input("default", "Default", "phone"),
        input("r-spk", "Speakerphone", "phone"),
        input("r-ear", "Headset earpiece", "phone"),
      ],
      { canPickOutput: false },
    );
    expect(model.routes.map((r) => r.kind)).toEqual(["earpiece", "speaker"]);
  });

  test("devices that do not say which group they belong to are all kept", () => {
    const model = buildAudioModel([input("a", "A"), input("b", "B")], { canPickOutput: false });
    expect(model.inputs.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

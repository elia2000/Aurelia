import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "vitest-browser-react";
import { act } from "react";
import { useAudioDevices } from "../../../src/calls/useAudioDevices.js";

const device = (kind, deviceId, label) => ({ kind, deviceId, label });
const LIST = [
  device("audioinput", "default", "Default mic"),
  device("audioinput", "mic-2", "USB mic"),
  device("audiooutput", "default", "Default speakers"),
  device("audiooutput", "out-1", "Speakers"),
  device("audiooutput", "out-2", "USB headset"),
];

const original = Object.getOwnPropertyDescriptor(navigator.mediaDevices, "enumerateDevices");
const listeners = new Set();

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: async () => LIST, configurable: true });
  vi.spyOn(navigator.mediaDevices, "addEventListener").mockImplementation((type, fn) => type === "devicechange" && listeners.add(fn));
  vi.spyOn(navigator.mediaDevices, "removeEventListener").mockImplementation((type, fn) => listeners.delete(fn));
  if (!("setSinkId" in HTMLMediaElement.prototype)) {
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { value: async () => {}, configurable: true, writable: true });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  listeners.clear();
  if (original) Object.defineProperty(navigator.mediaDevices, "enumerateDevices", original);
});

const fakeAudio = () => ({ sinkId: "", setSinkId: vi.fn(async function (id) { this.sinkId = id; }) });

describe("useAudioDevices", () => {
  test("lists the microphones and speakers once a call is on screen", async () => {
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: null }));
    await expect.poll(() => result.current.model.inputs.length).toBe(2);
    expect(result.current.model.outputs.map((o) => o.id)).toEqual(["default", "out-1", "out-2"]);
    expect(result.current.model.canPickOutput).toBe(true);
  });

  test("lists nothing while no call is on screen", async () => {
    const { result } = await renderHook(() => useAudioDevices({ active: false, microphoneId: null, audioElement: null }));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.model.inputs).toEqual([]);
  });

  test("picking a speaker applies it to the call's audio inside the tap, and remembers it", async () => {
    const audio = fakeAudio();
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: audio }));
    await expect.poll(() => result.current.model.outputs.length).toBe(3);
    await new Promise((r) => setTimeout(r, 30)); // the first listing has been applied
    const before = audio.setSinkId.mock.calls.length;
    let sameTick;
    // The call is made straight from the click handler (Safari only allows it there).
    await act(async () => {
      const promise = result.current.chooseOutput("out-2");
      sameTick = audio.setSinkId.mock.calls.slice(before).map((call) => call[0]);
      await promise;
    });
    expect(sameTick).toEqual(["out-2"]);
    expect(audio.setSinkId).toHaveBeenCalledWith("out-2");
    expect(result.current.outputId).toBe("out-2");
    expect(result.current.outputError).toBe(false);
    expect(localStorage.getItem("aurelle-call-output")).toBe("out-2");
  });

  test("going back to the default speaker resets the sink with an empty id", async () => {
    const audio = fakeAudio();
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: audio }));
    await expect.poll(() => result.current.model.outputs.length).toBe(3);
    await act(async () => {
      await result.current.chooseOutput("out-1");
    });
    await act(async () => {
      await result.current.chooseOutput("default");
    });
    expect(audio.setSinkId).toHaveBeenLastCalledWith("");
    expect(result.current.outputId).toBe("default");
  });

  test("a list that arrives late is still used, and until then the call screen carries on", async () => {
    let release;
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
      value: () => new Promise((resolve) => (release = () => resolve(LIST))),
      configurable: true,
    });
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: null }));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.model.inputs).toEqual([]);
    expect(result.current.outputId).toBe("default");
    await act(async () => release());
    await expect.poll(() => result.current.model.inputs.length).toBe(2);
  });

  test("when two lists are asked for, the older answer never replaces the newer one", async () => {
    const releases = [];
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
      value: () => new Promise((resolve) => releases.push(resolve)),
      configurable: true,
    });
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: null }));
    await expect.poll(() => releases.length).toBe(1);
    await act(async () => {
      listeners.forEach((fn) => fn()); // a device was plugged in: the list is asked for again
    });
    await expect.poll(() => releases.length).toBe(2);
    await act(async () => releases[1](LIST)); // the newer answer comes first ...
    await act(async () => releases[0](LIST.slice(0, 1))); // ... and the older one after it
    await expect.poll(() => result.current.model.inputs.length).toBe(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.model.inputs.length).toBe(2);
  });

  test("a speaker the browser refuses is reported, is not shown as chosen and is not remembered", async () => {
    const audio = fakeAudio();
    audio.setSinkId = vi.fn(async () => {
      throw Object.assign(new Error("no"), { name: "NotAllowedError" });
    });
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: audio }));
    await expect.poll(() => result.current.model.outputs.length).toBe(3);
    await act(async () => {
      await result.current.chooseOutput("out-1");
    });
    expect(result.current.outputError).toBe(true);
    expect(result.current.outputId).toBe("default");
    expect(localStorage.getItem("aurelle-call-output")).toBeNull();
  });

  test("a refused speaker keeps the one that was working before", async () => {
    const audio = fakeAudio();
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: audio }));
    await expect.poll(() => result.current.model.outputs.length).toBe(3);
    await act(async () => {
      await result.current.chooseOutput("out-1");
    });
    audio.setSinkId = vi.fn(async () => {
      throw Object.assign(new Error("no"), { name: "NotAllowedError" });
    });
    await act(async () => {
      await result.current.chooseOutput("out-2");
    });
    expect(result.current.outputId).toBe("out-1");
    expect(localStorage.getItem("aurelle-call-output")).toBe("out-1");
    expect(result.current.outputError).toBe(true);
  });

  test("a remembered speaker the browser will not switch to without a tap shows as the default", async () => {
    localStorage.setItem("aurelle-call-output", "out-1");
    const audio = fakeAudio();
    audio.setSinkId = vi.fn(async () => {
      throw Object.assign(new Error("needs a gesture"), { name: "NotAllowedError" });
    });
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: audio }));
    await expect.poll(() => result.current.model.outputs.length).toBe(3);
    await expect.poll(() => result.current.outputId).toBe("default");
    // It is still remembered: the next call tries again.
    expect(localStorage.getItem("aurelle-call-output")).toBe("out-1");
    expect(result.current.outputError).toBe(false);
  });

  test("a warning about a speaker does not follow the person into the next call", async () => {
    const audio = fakeAudio();
    audio.setSinkId = vi.fn(async () => {
      throw Object.assign(new Error("no"), { name: "NotAllowedError" });
    });
    const { result, rerender } = await renderHook((props) => useAudioDevices(props), {
      initialProps: { active: true, microphoneId: "default", audioElement: audio },
    });
    await expect.poll(() => result.current.model.outputs.length).toBe(3);
    await act(async () => {
      await result.current.chooseOutput("out-1");
    });
    expect(result.current.outputError).toBe(true);
    await rerender({ active: false, microphoneId: null, audioElement: null });
    await expect.poll(() => result.current.outputError).toBe(false);
  });

  test("a remembered speaker is applied when the next call opens", async () => {
    localStorage.setItem("aurelle-call-output", "out-1");
    const audio = fakeAudio();
    await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: audio }));
    await expect.poll(() => audio.setSinkId.mock.calls.at(-1)?.[0]).toBe("out-1");
  });

  test("a remembered speaker that is no longer there counts as the default", async () => {
    localStorage.setItem("aurelle-call-output", "gone");
    const audio = fakeAudio();
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: audio }));
    await expect.poll(() => result.current.model.outputs.length).toBe(3);
    expect(result.current.outputId).toBe("default");
  });

  test("devices plugged in during the call appear", async () => {
    let list = LIST.slice(0, 3);
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: async () => list, configurable: true });
    const { result } = await renderHook(() => useAudioDevices({ active: true, microphoneId: "default", audioElement: null }));
    await expect.poll(() => result.current.model.inputs.length).toBe(2);
    list = LIST;
    await act(async () => {
      listeners.forEach((fn) => fn());
    });
    await expect.poll(() => result.current.model.outputs.length).toBe(3);
  });
});

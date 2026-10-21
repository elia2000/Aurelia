import { describe, test, expect, afterEach } from "vitest";
import {
  readDeleteForEveryonePreference,
  writeDeleteForEveryonePreference,
} from "../../src/utils/deletePreference.js";

const KEY = "songbird-delete-message-for-everyone";
const original = globalThis.window;

const fakeWindow = (storage) => {
  globalThis.window = { localStorage: storage };
};

afterEach(() => {
  if (original === undefined) delete globalThis.window;
  else globalThis.window = original;
});

describe("delete-for-everyone preference", () => {
  test("is off until it is turned on, under the key the single delete uses", () => {
    const data = new Map();
    fakeWindow({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) });
    expect(readDeleteForEveryonePreference()).toBe(false);
    writeDeleteForEveryonePreference(true);
    expect(data.get(KEY)).toBe("1");
    expect(readDeleteForEveryonePreference()).toBe(true);
    writeDeleteForEveryonePreference(false);
    expect(data.get(KEY)).toBe("0");
    expect(readDeleteForEveryonePreference()).toBe(false);
  });

  test("blocked storage is not an error", () => {
    fakeWindow({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readDeleteForEveryonePreference()).toBe(false);
    expect(() => writeDeleteForEveryonePreference(true)).not.toThrow();
  });

  test("no window at all is not an error", () => {
    delete globalThis.window;
    expect(readDeleteForEveryonePreference()).toBe(false);
    expect(() => writeDeleteForEveryonePreference(true)).not.toThrow();
  });
});

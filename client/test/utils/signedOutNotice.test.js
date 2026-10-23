import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SIGNED_OUT_MESSAGES,
  noticeMessage,
  rememberSignedOutNotice,
  takeSignedOutNotice,
} from "../../src/utils/signedOutNotice.js";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { sessionStorage: memoryStorage() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signed-out notice", () => {
  test("is shown once, then forgotten", () => {
    rememberSignedOutNotice("signed_out");
    expect(takeSignedOutNotice()).toBe(SIGNED_OUT_MESSAGES.signed_out);
    expect(takeSignedOutNotice()).toBe("");
  });
  test("each reason has its own words and unknown ones fall back", () => {
    for (const reason of ["signed_out", "password_changed", "password_reset", "two_factor_reset", "banned", "account_deleted"]) {
      rememberSignedOutNotice(reason);
      expect(takeSignedOutNotice()).toBe(SIGNED_OUT_MESSAGES[reason]);
    }
    expect(noticeMessage("something-new")).toBe(SIGNED_OUT_MESSAGES.default);
    rememberSignedOutNotice(undefined);
    expect(takeSignedOutNotice()).toBe(SIGNED_OUT_MESSAGES.default);
  });
  test("nothing pending gives an empty string", () => {
    expect(takeSignedOutNotice()).toBe("");
  });
  test("blocked storage never throws", () => {
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    vi.stubGlobal("window", { sessionStorage: blocked });
    expect(() => rememberSignedOutNotice("signed_out")).not.toThrow();
    expect(takeSignedOutNotice()).toBe("");
  });
});

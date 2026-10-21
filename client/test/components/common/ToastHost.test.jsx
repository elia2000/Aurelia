import { describe, test, expect } from "vitest";
import { render } from "vitest-browser-react";
import { act } from "react";
import ToastHost from "../../../src/components/common/ToastHost.jsx";
import { showToast } from "../../../src/utils/toast.js";

const status = () => document.querySelector('[role="status"]');
const alertRegion = () => document.querySelector('[role="alert"]');

const toast = async (...args) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      showToast(...args);
    });
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
};

describe("ToastHost", () => {
  test("the live regions are there before any toast, so a screen reader hears the text that is put into them", async () => {
    await render(<ToastHost />);
    expect(status()).not.toBeNull();
    expect(alertRegion()).not.toBeNull();
    expect(status().textContent).toBe("");
    expect(alertRegion().textContent).toBe("");
    expect(status().getAttribute("aria-live") ?? "polite").toBe("polite");
  });

  test("an info toast goes into the polite region and an error into the alert region, in the same elements", async () => {
    await render(<ToastHost />);
    const polite = status();
    const assertive = alertRegion();
    await toast("GIF saved", { tone: "info" });
    expect(status()).toBe(polite);
    expect(polite.textContent).toBe("GIF saved");
    expect(assertive.textContent).toBe("");
    await toast("That message is no longer available.", { tone: "error" });
    expect(alertRegion()).toBe(assertive);
    expect(assertive.textContent).toBe("That message is no longer available.");
    expect(polite.textContent).toBe("GIF saved");
  });

  test("the same text twice is shown once, and at most three toasts stay", async () => {
    await render(<ToastHost />);
    await toast("One", { tone: "info" });
    await toast("One", { tone: "info" });
    expect(status().children).toHaveLength(1);
    await toast("Two", { tone: "info" });
    await toast("Three", { tone: "info" });
    await toast("Four", { tone: "info" });
    expect(status().textContent).toContain("Four");
    expect(status().textContent).not.toContain("One");
  });
});

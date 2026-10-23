import { describe, expect, test } from "vitest";
import { formatRelativeTime, formatShortDate } from "../../src/utils/relativeTime.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  test("under a minute is 'Active now'", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("Active now");
    expect(formatRelativeTime(ago(59_000), NOW)).toBe("Active now");
    // a clock a little ahead of the server never shows a negative age
    expect(formatRelativeTime(new Date(NOW + 5000).toISOString(), NOW)).toBe("Active now");
  });
  test("minutes, hours, days", () => {
    expect(formatRelativeTime(ago(5 * MIN), NOW)).toBe("5 minutes ago");
    expect(formatRelativeTime(ago(MIN), NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(3 * HOUR + 10 * MIN), NOW)).toBe("3 hours ago");
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("yesterday");
    expect(formatRelativeTime(ago(12 * DAY), NOW)).toBe("12 days ago");
  });
  test("older than 30 days is a date", () => {
    expect(formatRelativeTime(ago(45 * DAY), NOW)).toMatch(/2026/);
  });
  test("junk gives an empty string", () => {
    expect(formatRelativeTime("not a date", NOW)).toBe("");
    expect(formatRelativeTime(undefined, NOW)).toBe("");
  });
});

describe("formatShortDate", () => {
  test("formats a date and tolerates junk", () => {
    expect(formatShortDate("2026-01-02T03:04:05Z")).toMatch(/2026/);
    expect(formatShortDate("nope")).toBe("");
  });
});

import { describe, expect, test } from "vitest";
import { findPreviewUrl, normalizePreviewUrl } from "../../src/utils/linkPreviewUrl.js";

const ORIGIN = "https://chat.example.org";

// The HTML utils/markdown.js makes for a link (a real render needs a DOM and is
// covered in test/components/chat/linkPreviewMessage.test.jsx).
const anchor = (href, text = href) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer" class="sb-link">${text}</a>`;
const first = (...hrefs) => findPreviewUrl(`<p>look: ${hrefs.map((h) => anchor(h)).join(" and ")}</p>`, ORIGIN);

describe("the link of a message, as the message shows it", () => {
  test("a plain address", () => {
    expect(first("https://example.com/page?x=1")).toBe("https://example.com/page?x=1");
  });

  test("the first link wins", () => {
    expect(first("https://one.example.com/", "https://two.example.com/")).toBe("https://one.example.com/");
  });

  test("a link with extra attributes in any order", () => {
    const html = '<p><a class="sb-link" data-auto-link="1" target="_blank" href="https://example.com/a" rel="noopener noreferrer">x</a></p>';
    expect(findPreviewUrl(html, ORIGIN)).toBe("https://example.com/a");
  });

  test("the address is read back with its &amp; as an ampersand", () => {
    expect(first("https://example.com/?a=1&amp;b=2")).toBe("https://example.com/?a=1&b=2");
    expect(first("https://example.com/?q=%22x%22&amp;r=&quot;y&quot;")).toBe("https://example.com/?q=%22x%22&r=%22y%22");
  });

  test("the #fragment is dropped", () => {
    expect(first("https://example.com/a#section")).toBe("https://example.com/a");
  });

  test("a message without a link has none", () => {
    expect(findPreviewUrl("<p>hello there</p>", ORIGIN)).toBe("");
    expect(findPreviewUrl("", ORIGIN)).toBe("");
    expect(findPreviewUrl(null)).toBe("");
    expect(findPreviewUrl(undefined)).toBe("");
  });

  test("an anchor without an address is not a link", () => {
    expect(findPreviewUrl("<p><a>nothing</a></p>", ORIGIN)).toBe("");
    expect(findPreviewUrl('<p><a href="">nothing</a></p>', ORIGIN)).toBe("");
  });
});

describe("links that are not previewed", () => {
  test.each([
    ["ftp://example.com/file", "not http"],
    ["https://user:pass@example.com/", "has a user name"],
    [`${ORIGIN}/invite/abc123`, "a link into this very app"],
    [`${ORIGIN}/`, "a link into this very app"],
    ["javascript:alert(1)", "not http"],
    ["mailto:a@example.com", "not http"],
  ])("%s (%s)", (value) => {
    expect(first(value)).toBe("");
  });

  test("only the first link counts: if it cannot be previewed, a later one does not take its place", () => {
    expect(first(`${ORIGIN}/invite/abc`, "https://example.com/a")).toBe("");
  });
});

describe("normalizePreviewUrl", () => {
  test.each([
    ["https://example.com/a b", ""],
    ["javascript:alert(1)", ""],
    ["data:text/html,x", ""],
    ["//example.com/", ""],
    ["example.com", ""],
    ["", ""],
    [null, ""],
    ["http://example.com:80/x", "http://example.com/x"],
    ["https://example.com:443/x", "https://example.com/x"],
    ["https://example.com:80/x", "https://example.com:80/x"],
    ["http://example.com:8080/x", "http://example.com:8080/x"], // the server decides about ports
    ["https://example.com/x#y", "https://example.com/x"],
  ])("%j -> %j", (value, expected) => {
    expect(normalizePreviewUrl(value, ORIGIN)).toBe(expected);
  });

  test("an address over 2048 characters is not previewed", () => {
    expect(normalizePreviewUrl(`https://example.com/${"a".repeat(2100)}`, ORIGIN)).toBe("");
  });

  test("a link into this app is told apart by origin, not by text", () => {
    expect(normalizePreviewUrl("https://chat.example.org.evil.com/", ORIGIN)).not.toBe("");
    expect(normalizePreviewUrl("https://chat.example.org/x", ORIGIN)).toBe("");
  });
});

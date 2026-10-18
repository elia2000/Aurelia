import { describe, expect, test } from "vitest";
import {
  getBodyTailKind,
  getMediaAspectKey,
  getMediaBubbleWidthPx,
  getMediaMaxHeightPx,
  getMetaSpacer,
  getTextDirection,
  MEDIA_MAX_WIDTH_PX,
  MEDIA_MIN_WIDTH_PX,
  resolveMediaAspectRatio,
} from "../../src/utils/messageLayout.js";

describe("getTextDirection", () => {
  test("latin text is ltr, Persian and Arabic are rtl", () => {
    expect(getTextDirection("Hello")).toBe("ltr");
    expect(getTextDirection("سلام دنیا")).toBe("rtl");
    expect(getTextDirection("مرحبا")).toBe("rtl");
  });

  test("the first strong letter decides, digits and emoji are ignored", () => {
    expect(getTextDirection("123 😀 سلام")).toBe("rtl");
    expect(getTextDirection("12:30 hello")).toBe("ltr");
    expect(getTextDirection("سلام hello")).toBe("rtl");
    expect(getTextDirection("hello سلام")).toBe("ltr");
  });

  test("only the last paragraph counts, because that is where the time sits", () => {
    expect(getTextDirection("hello\n\nسلام")).toBe("rtl");
    expect(getTextDirection("سلام\n\nhello")).toBe("ltr");
  });

  test("empty or symbol-only text defaults to ltr", () => {
    expect(getTextDirection("")).toBe("ltr");
    expect(getTextDirection(null)).toBe("ltr");
    expect(getTextDirection("👍👍")).toBe("ltr");
  });
});

describe("getBodyTailKind", () => {
  test("plain text and inline markup end inline", () => {
    expect(getBodyTailKind("ok")).toBe("inline");
    expect(getBodyTailKind("a<br />b")).toBe("inline");
    expect(getBodyTailKind("a <strong>b</strong>")).toBe("inline");
    expect(getBodyTailKind('<img src="x" alt="y" />')).toBe("inline");
    expect(getBodyTailKind("")).toBe("inline");
  });

  test("a paragraph keeps the time on its last line", () => {
    expect(getBodyTailKind("<p>hello</p>\n")).toBe("p");
  });

  test("lists, quotes, code blocks and headings need their own time row", () => {
    expect(getBodyTailKind("<ul><li>a</li></ul>")).toBe("block");
    expect(getBodyTailKind("<blockquote><p>q</p></blockquote>")).toBe("block");
    expect(getBodyTailKind('<div class="sb-code-block">x</div>')).toBe("block");
    expect(getBodyTailKind("<pre><code>x</code></pre>")).toBe("block");
    expect(getBodyTailKind("<h2>t</h2>")).toBe("block");
    expect(getBodyTailKind("<hr />")).toBe("block");
  });
});

describe("getMetaSpacer", () => {
  test("is the text MessageMeta prints, plus room for the icons", () => {
    const plain = getMetaSpacer({ timeLabel: "12:31", isEdited: false, expiryLabel: "", viewsLabel: "", hasStatusIcon: false });
    expect(plain.text).toBe("12:31");
    const full = getMetaSpacer({ timeLabel: "12:31", isEdited: true, expiryLabel: "7d", viewsLabel: "1.2K", hasStatusIcon: true });
    expect(full.text).toBe("7d edited 12:31 1.2K");
    expect(full.extraPx).toBeGreaterThan(plain.extraPx);
  });

  test("never lets a quote or control character break out of the CSS string", () => {
    const { text } = getMetaSpacer({ timeLabel: 'a"b\\c\nd', isEdited: false, expiryLabel: "", viewsLabel: "", hasStatusIcon: false });
    expect(text).not.toMatch(/["\\\n]/);
  });
});

describe("resolveMediaAspectRatio", () => {
  test("prefers the ratio measured in the browser", () => {
    expect(resolveMediaAspectRatio({ file: { width: 100, height: 100 }, cachedRatio: 1.5 })).toBe(1.5);
  });

  test("falls back to the stored size, then to a stable guess", () => {
    expect(resolveMediaAspectRatio({ file: { width: 800, height: 600 } })).toBeCloseTo(4 / 3, 5);
    expect(resolveMediaAspectRatio({ file: {} })).toBe(1);
    expect(resolveMediaAspectRatio({ file: { width: 0, height: 10 } })).toBe(1);
    expect(resolveMediaAspectRatio({ file: {}, isVideo: true })).toBeCloseTo(16 / 9, 5);
  });

  test("clamps extreme shapes", () => {
    expect(resolveMediaAspectRatio({ file: { width: 10, height: 1000 } })).toBe(0.42);
    expect(resolveMediaAspectRatio({ file: { width: 1000, height: 10 } })).toBe(2.4);
    expect(resolveMediaAspectRatio({ file: {}, cachedRatio: 9 })).toBe(2.4);
  });
});

describe("getMediaAspectKey", () => {
  test("uses the file id, else name and size", () => {
    expect(getMediaAspectKey({ id: "f1", name: "a.png", sizeBytes: 3 })).toBe("f1");
    expect(getMediaAspectKey({ name: "a.png", sizeBytes: 3 })).toBe("a.png-3");
    expect(getMediaAspectKey({})).toBe("-0");
  });
});

describe("getMediaBubbleWidthPx", () => {
  test("a landscape or square picture gets the full media width", () => {
    expect(getMediaBubbleWidthPx({ ratio: 1.5, isDesktop: true })).toBe(MEDIA_MAX_WIDTH_PX);
    expect(getMediaBubbleWidthPx({ ratio: 1, isDesktop: true })).toBe(MEDIA_MAX_WIDTH_PX);
  });

  test("a tall picture gets a narrow bubble so it stays within the height cap", () => {
    const ratio = 0.6;
    const width = getMediaBubbleWidthPx({ ratio, isDesktop: true });
    expect(width).toBeLessThan(MEDIA_MAX_WIDTH_PX);
    expect(width / ratio).toBeLessThanOrEqual(getMediaMaxHeightPx(true) + 1);
  });

  test("never narrower than the minimum", () => {
    expect(getMediaBubbleWidthPx({ ratio: 0.42, isDesktop: false })).toBe(MEDIA_MIN_WIDTH_PX);
  });

  test("phones cap the height lower than desktops", () => {
    expect(getMediaMaxHeightPx(false)).toBeLessThan(getMediaMaxHeightPx(true));
  });
});

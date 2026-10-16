import { describe, test, expect } from "vitest";
import {
  EMOJI_IMAGE_BASE,
  emojiFilename,
  emojifyHtml,
  fallbackEmojiSrc,
  isJumboEmojiText,
} from "../../src/emoji/emojiImages.js";

describe("emojiFilename", () => {
  test.each([
    ["😀", "1f600.png"],
    ["❤️", "2764-fe0f.png"],
    ["🇮🇷", "1f1ee-1f1f7.png"],
    ["👨‍👩‍👧‍👦", "1f468-200d-1f469-200d-1f467-200d-1f466.png"],
    ["👋🏽", "1f44b-1f3fd.png"],
    ["1️⃣", "0031-fe0f-20e3.png"],
  ])("%s -> %s", (emoji, file) => {
    expect(emojiFilename(emoji)).toBe(file);
  });
});

describe("emojifyHtml", () => {
  const img = (alt, file) => `<img class="emoji" alt="${alt}" src="${EMOJI_IMAGE_BASE}${file}" draggable="false">`;

  test("turns emoji in the text into images that keep the emoji as their alt text", () => {
    expect(emojifyHtml("<p>hi 😀!</p>")).toBe(`<p>hi ${img("😀", "1f600.png")}!</p>`);
  });

  test("works next to Persian and with several emoji in a row", () => {
    expect(emojifyHtml("سلام 👋🏽❤️")).toBe(`سلام ${img("👋🏽", "1f44b-1f3fd.png")}${img("❤️", "2764-fe0f.png")}`);
  });

  test("a '>' inside a quoted attribute does not end the tag", () => {
    const html = '<a href="https://x.test/" title="a > 😀 <b>">go 😀</a>';
    expect(emojifyHtml(html)).toBe(`<a href="https://x.test/" title="a > 😀 <b>">go ${img("😀", "1f600.png")}</a>`);
    const single = "<a title='1 > 😀'>😀</a>";
    expect(emojifyHtml(single)).toBe(`<a title='1 > 😀'>${img("😀", "1f600.png")}</a>`);
  });

  test("never touches tag attributes", () => {
    const html = '<a href="https://x.test/😀" title="😀 hello">go 😀</a>';
    expect(emojifyHtml(html)).toBe(`<a href="https://x.test/😀" title="😀 hello">go ${img("😀", "1f600.png")}</a>`);
  });

  test("leaves code alone", () => {
    expect(emojifyHtml("<pre><code>let a = '😀'</code></pre><p>😀</p>")).toBe(
      `<pre><code>let a = '😀'</code></pre><p>${img("😀", "1f600.png")}</p>`,
    );
    expect(emojifyHtml("<code>😀</code>")).toBe("<code>😀</code>");
  });

  test("leaves symbols that are text unless they are asked to be emoji", () => {
    expect(emojifyHtml("<p>© 2026 ❤ 123 # *</p>")).toBe("<p>© 2026 ❤ 123 # *</p>");
    expect(emojifyHtml("<p>©️</p>")).toContain("<img");
  });

  test("a message that is only a few emoji is shown big", () => {
    expect(emojifyHtml("<p>😀</p>", { jumbo: true })).toContain('class="emoji emoji-jumbo"');
    expect(emojifyHtml("<p>😀</p>")).not.toContain("emoji-jumbo");
  });

  test("text without emoji comes back as it was", () => {
    const html = "<p>plain <b>text</b></p>";
    expect(emojifyHtml(html)).toBe(html);
    expect(emojifyHtml("")).toBe("");
  });
});

describe("isJumboEmojiText", () => {
  test("one to three emoji, with or without spaces and line breaks", () => {
    expect(isJumboEmojiText("😀")).toBe(true);
    expect(isJumboEmojiText("😀 😀\n😀")).toBe(true);
    expect(isJumboEmojiText("👨‍👩‍👧‍👦")).toBe(true);
  });
  test("not for more than three, or when there is any other text", () => {
    expect(isJumboEmojiText("😀😀😀😀")).toBe(false);
    expect(isJumboEmojiText("hi 😀")).toBe(false);
    expect(isJumboEmojiText("")).toBe(false);
    expect(isJumboEmojiText("❤")).toBe(false); // text-style symbol, not an emoji image
  });
});

describe("fallbackEmojiSrc", () => {
  test("tries the other spelling of the same emoji once, then gives up", () => {
    expect(fallbackEmojiSrc(`${EMOJI_IMAGE_BASE}2764.png`, 0)).toBe(`${EMOJI_IMAGE_BASE}2764-fe0f.png`);
    expect(fallbackEmojiSrc(`${EMOJI_IMAGE_BASE}2764-fe0f.png`, 0)).toBe(`${EMOJI_IMAGE_BASE}2764.png`);
    expect(fallbackEmojiSrc(`${EMOJI_IMAGE_BASE}2764.png`, 1)).toBeNull();
    expect(fallbackEmojiSrc("https://elsewhere.test/x.png", 0)).toBeNull();
  });
});

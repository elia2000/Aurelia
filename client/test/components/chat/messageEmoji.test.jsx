import { describe, test, expect } from "vitest";
import { renderMarkdownBlock, renderMarkdownInlinePlain } from "../../../src/utils/markdown.js";

describe("emoji in rendered messages", () => {
  test("an emoji in a message is drawn as a picture that keeps the emoji as its alt text", () => {
    const html = renderMarkdownBlock("hi 😀");
    expect(html).toContain('<img class="emoji"');
    expect(html).toContain('alt="😀"');
    expect(html).toContain('src="/emoji/apple/64/1f600.png"');
  });

  test("it works inside formatting and next to links, without touching the links", () => {
    const html = renderMarkdownBlock("**bold 🔥** and https://example.com/a?x=😀");
    expect(html).toContain("<strong>bold <img");
    expect(html).toContain('alt="🔥"');
    expect(html).not.toMatch(/href="[^"]*<img/);
  });

  test("code stays as typed", () => {
    const html = renderMarkdownBlock("`let a = '😀'`");
    expect(html).toContain("<code>let a = '😀'</code>");
    expect(html).not.toContain("<img");
  });

  test("one to three emoji on their own are shown big, a sentence is not", () => {
    expect(renderMarkdownBlock("😀")).toContain("emoji-jumbo");
    expect(renderMarkdownBlock("😀😀😀")).toContain("emoji-jumbo");
    expect(renderMarkdownBlock("😀😀😀😀")).not.toContain("emoji-jumbo");
    expect(renderMarkdownBlock("hello 😀")).not.toContain("emoji-jumbo");
  });

  test("a message without emoji is as it was", () => {
    expect(renderMarkdownBlock("hello world")).not.toContain("<img");
  });

  test("previews (chat list, replies) show the pictures too, and escape what they must", () => {
    const html = renderMarkdownInlinePlain("<b>x</b> 😀");
    expect(html).toContain('alt="😀"');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
});

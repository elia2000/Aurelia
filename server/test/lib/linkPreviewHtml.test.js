import { describe, expect, test } from "vitest";
import {
  DESCRIPTION_MAX_CHARS,
  SITE_NAME_MAX_CHARS,
  TITLE_MAX_CHARS,
  cleanText,
  decodeEntities,
  decodeHtml,
  extractMetadata,
  parsePreviewFields,
  resolveHttpUrl,
} from "../../lib/linkPreview/html.js";

const fields = (head, url = "https://www.example.com/post/1") =>
  parsePreviewFields(`<!doctype html><html><head>${head}</head><body><h1>x</h1></body></html>`, url);

describe("what a card is made from", () => {
  test("Open Graph first", () => {
    const result = fields(`
      <title>Page title</title>
      <meta name="description" content="Plain description">
      <meta property="og:title" content="OG title">
      <meta property="og:description" content="OG description">
      <meta property="og:site_name" content="Example News">
      <meta property="og:image" content="https://cdn.example.com/a.png">`);
    expect(result).toEqual({
      title: "OG title",
      description: "OG description",
      siteName: "Example News",
      imageCandidates: ["https://cdn.example.com/a.png"],
    });
  });

  test("then the Twitter card, then <title> and the plain description", () => {
    expect(fields(`<title>T</title><meta name="twitter:title" content="TW"><meta name="twitter:description" content="TWD">`))
      .toMatchObject({ title: "TW", description: "TWD" });
    expect(fields(`<title>Only title</title><meta name="description" content="Only description">`))
      .toMatchObject({ title: "Only title", description: "Only description" });
  });

  test("an empty or blank og:title falls through to the next source", () => {
    expect(fields(`<meta property="og:title" content="   "><meta name="twitter:title" content="TW"><title>T</title>`).title).toBe("TW");
    expect(fields(`<meta property="og:title" content=""><title>T</title>`).title).toBe("T");
  });

  test("the site name is the host without www when the page does not say", () => {
    expect(fields(`<title>T</title>`, "https://www.example.com/x").siteName).toBe("example.com");
    expect(fields(`<title>T</title>`, "https://blog.example.com/x").siteName).toBe("blog.example.com");
  });

  test("an address is not a site name", () => {
    expect(fields(`<title>T</title>`, "http://93.184.216.34/x").siteName).toBe("");
    expect(fields(`<title>T</title>`, "http://[2606:4700:4700::1111]/x").siteName).toBe("");
  });

  test("meta tags are found with the name or property attribute, in any order and case", () => {
    expect(fields(`<META CONTENT="Upper" PROPERTY="OG:TITLE">`).title).toBe("Upper");
    expect(fields(`<meta content='Single' name='og:title'>`).title).toBe("Single");
    expect(fields(`<meta name=og:title content=Unquoted>`).title).toBe("Unquoted");
    expect(fields(`<meta   property = "og:title"   content = "Spaced"  />`).title).toBe("Spaced");
  });

  test("the first of a repeated tag or attribute wins", () => {
    expect(fields(`<meta property="og:title" content="First"><meta property="og:title" content="Second">`).title).toBe("First");
    expect(fields(`<meta property="og:title" content="A" content="B">`).title).toBe("A");
    expect(fields(`<title>One</title><title>Two</title>`).title).toBe("One");
  });

  test("a > inside a quoted attribute does not end the tag", () => {
    expect(fields(`<meta property="og:title" content="a > b > c">`).title).toBe("a > b > c");
  });

  test("a page with nothing usable gives empty strings", () => {
    expect(fields(``)).toEqual({ title: "", description: "", siteName: "example.com", imageCandidates: [] });
  });

  test("Persian text and its zero-width non-joiner are kept", () => {
    const text = "می\u200cخواهم سلام";
    expect(fields(`<meta property="og:title" content="${text}">`).title).toBe(text);
  });
});

describe("markup that must not be read as markup", () => {
  test("tags inside comments, scripts, styles, textareas and templates are ignored", () => {
    const result = fields(`
      <!-- <meta property="og:title" content="in a comment"> -->
      <script>var s = '<meta property="og:title" content="in a script">';</script>
      <style>/* <meta property="og:title" content="in a style"> */</style>
      <textarea><meta property="og:title" content="in a textarea"></textarea>
      <template><meta property="og:title" content="in a template"></template>
      <meta property="og:title" content="the real one">`);
    expect(result.title).toBe("the real one");
  });

  test("nothing after <body> is read", () => {
    const result = parsePreviewFields(
      `<html><head><title>Head</title></head><body><meta property="og:title" content="late"><title>Body title</title></body></html>`,
      "https://example.com/",
    );
    expect(result.title).toBe("Head");
    expect(parsePreviewFields(`<html><body><title>Late</title></body></html>`, "https://example.com/").title).toBe("");
  });

  test("an unclosed comment ends the reading instead of swallowing a wrong tag", () => {
    expect(fields(`<title>T</title><!-- never closed <meta property="og:title" content="hidden">`).title).toBe("T");
  });

  test("<title> text is text: markup inside it is not parsed", () => {
    const result = fields(`<title>A <meta property="og:title" content="inside"> B</title>`);
    expect(result.title).toBe('A <meta property="og:title" content="inside"> B');
  });

  test("a title that is never closed is cut", () => {
    const result = fields(`<title>${"x".repeat(5000)}`);
    expect(Array.from(result.title).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  test("scripts and event handlers stay inert text (the client shows text, never HTML)", () => {
    const result = fields(`
      <title><script>alert(1)</script></title>
      <meta property="og:description" content="&lt;img src=x onerror=alert(1)&gt;">`);
    // Strings only: what they contain is data for a text node.
    expect(typeof result.title).toBe("string");
    expect(result.title).toBe("<script>alert(1)</script>");
    expect(result.description).toBe("<img src=x onerror=alert(1)>");
  });

  test("CDATA, processing instructions and the doctype are skipped", () => {
    const result = parsePreviewFields(
      `<?xml version="1.0"?><!DOCTYPE html><![CDATA[ <meta property="og:title" content="cdata"> ]]><html><head><title>Fine</title>`,
      "https://example.com/",
    );
    expect(result.title).toBe("Fine");
  });
});

describe("entities", () => {
  test.each([
    ["Tom &amp; Jerry", "Tom & Jerry"],
    ["&lt;b&gt;", "<b>"],
    ["&quot;hi&quot; &apos;x&apos;", "\"hi\" 'x'"],
    ["caf&eacute;", "café"],
    ["&#39;", "'"],
    ["&#x27;", "'"],
    ["&#X27;", "'"],
    ["&#x1F600;", "\u{1F600}"],
    ["&#128512;", "\u{1F600}"],
    ["a&nbsp;b", "a b"],
    ["&hellip;&mdash;&ndash;", "…—–"],
    ["&amp;lt;", "&lt;"], // decoded once, not twice
    ["&amp;amp;", "&amp;"],
  ])("%s", (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  test.each([
    ["&unknownentity;", "&unknownentity;"],
    ["&amp", "&amp"], // no semicolon: left alone
    ["fish & chips", "fish & chips"],
    ["&#;", "&#;"],
    ["&#x;", "&#x;"],
  ])("%s stays as written", (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  test.each(["&#0;", "&#xD800;", "&#xDFFF;", "&#1114112;", "&#99999999;", "&#xFFFFFFF;"])(
    "%s (not a character) becomes the replacement character",
    (input) => {
      expect(decodeEntities(input)).toBe("�");
    },
  );
});

describe("cleaning text", () => {
  test("white space is collapsed and trimmed, new lines included", () => {
    expect(cleanText("  a \n\t b\r\n\r\n c  ", 100)).toBe("a b c");
  });

  test("control characters, bidi overrides and separators are removed", () => {
    expect(cleanText("a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg", 100)).toBe("a b c d e f g");
    expect(cleanText("safe\u202etxt.exe", 100)).toBe("safe txt.exe");
    expect(cleanText("\u202aA\u202bB\u202cC\u202dD\u202eE\u2066F\u2067G\u2068H\u2069I", 100)).toBe("A B C D E F G H I");
    expect(cleanText("a\u2028b\u2029c\ufeffd", 100)).toBe("a b c d");
    expect(cleanText("a\ufff9b\ufffac\ufffbd", 100)).toBe("a b c d");
  });

  test("emoji sequences keep their zero-width joiners", () => {
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    expect(cleanText(`hi ${family}`, 100)).toBe(`hi ${family}`);
  });

  test("lone surrogates are dropped", () => {
    expect(cleanText("a\ud83db", 100)).toBe("ab");
    expect(cleanText("a\ude00b", 100)).toBe("ab");
    expect(JSON.parse(JSON.stringify(cleanText("x\ud83d", 100)))).toBe("x");
  });

  test("text over the limit is cut to the limit, ending in an ellipsis", () => {
    const cut = cleanText("a".repeat(500), 120);
    expect(Array.from(cut)).toHaveLength(120);
    expect(cut.endsWith("…")).toBe(true);
    expect(cleanText("a".repeat(120), 120)).toBe("a".repeat(120));
    expect(cleanText("a".repeat(121), 120)).toBe(`${"a".repeat(119)}…`);
  });

  test("a cut never splits an emoji", () => {
    const text = "\u{1F600}".repeat(200);
    const cut = cleanText(text, 10);
    expect(Array.from(cut)).toHaveLength(10);
    expect(cut).toBe(`${"\u{1F600}".repeat(9)}…`);
  });

  test("a cut does not leave a space before the ellipsis", () => {
    expect(cleanText(`${"a".repeat(8)} ${"b".repeat(50)}`, 10)).toBe(`${"a".repeat(8)}…`);
  });

  test("nothing, null and undefined are empty", () => {
    expect(cleanText("", 10)).toBe("");
    expect(cleanText(null, 10)).toBe("");
    expect(cleanText(undefined, 10)).toBe("");
    expect(cleanText("   \u202e  ", 10)).toBe("");
  });

  test("the limits apply to title, description and site name", () => {
    const long = "w".repeat(1000);
    const result = fields(
      `<meta property="og:title" content="${long}"><meta property="og:description" content="${long}"><meta property="og:site_name" content="${long}">`,
    );
    expect(Array.from(result.title)).toHaveLength(TITLE_MAX_CHARS);
    expect(Array.from(result.description)).toHaveLength(DESCRIPTION_MAX_CHARS);
    expect(Array.from(result.siteName)).toHaveLength(SITE_NAME_MAX_CHARS);
    expect([TITLE_MAX_CHARS, DESCRIPTION_MAX_CHARS, SITE_NAME_MAX_CHARS]).toEqual([120, 240, 60]);
  });
});

describe("picture addresses", () => {
  const image = (value, page = "https://www.example.com/post/1") =>
    fields(`<meta property="og:image" content="${value}">`, page).imageCandidates;

  test("absolute, root-relative, relative and protocol-relative addresses are resolved against the page", () => {
    expect(image("https://cdn.example.com/a.png")).toEqual(["https://cdn.example.com/a.png"]);
    expect(image("/img/a.png")).toEqual(["https://www.example.com/img/a.png"]);
    expect(image("a.png")).toEqual(["https://www.example.com/post/a.png"]);
    expect(image("//cdn.example.com/a.png")).toEqual(["https://cdn.example.com/a.png"]);
    expect(image("//cdn.example.com/a.png", "http://example.com/")).toEqual(["http://cdn.example.com/a.png"]);
  });

  test("entities in the address are decoded", () => {
    expect(image("https://cdn.example.com/a.png?x=1&amp;y=2")).toEqual(["https://cdn.example.com/a.png?x=1&y=2"]);
  });

  test.each([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "file:///etc/passwd",
    "ftp://example.com/a.png",
    "blob:https://example.com/x",
    "https://user:pw@cdn.example.com/a.png",
    "",
    "   ",
    "http://exa mple.com/a.png",
  ])("%j is not a usable picture address", (value) => {
    expect(image(value)).toEqual([]);
  });

  test("an address over 2048 characters is dropped", () => {
    expect(image(`https://cdn.example.com/${"a".repeat(2100)}`)).toEqual([]);
  });

  test("candidates come in a fixed order without repeats", () => {
    const result = fields(`
      <meta name="twitter:image" content="https://cdn.example.com/tw.png">
      <meta property="og:image" content="https://cdn.example.com/og.png">
      <meta property="og:image:secure_url" content="https://cdn.example.com/og.png">`);
    expect(result.imageCandidates).toEqual(["https://cdn.example.com/og.png", "https://cdn.example.com/tw.png"]);
  });

  test("resolveHttpUrl drops the fragment", () => {
    expect(resolveHttpUrl("/a#b", "https://example.com/")).toBe("https://example.com/a");
  });
});

describe("hostile pages", () => {
  test("an attribute that never closes its quote does not hide what follows", () => {
    const result = fields(`<meta property="og:description" content="never closed><title>Still found</title>`);
    expect(result.title).toBe("Still found");
  });

  test("a tag that never ends is treated as text", () => {
    const result = parsePreviewFields(`<title>T</title><meta property="og:title" content="x"`, "https://example.com/");
    expect(result.title).toBe("T");
  });

  test("an absurdly long tag is skipped", () => {
    const result = fields(`<meta property="og:title" content="${"a".repeat(20_000)}"><title>Short</title>`);
    expect(result.title).toBe("Short");
  });

  test("a very long attribute value is cut", () => {
    const result = fields(`<meta property="og:description" content="${"d ".repeat(3000)}">`);
    expect(Array.from(result.description).length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
  });

  test("only the first 64 attributes of a tag count", () => {
    const attrs = Array.from({ length: 100 }, (_, i) => `a${i}="1"`).join(" ");
    expect(fields(`<meta ${attrs} property="og:title" content="late">`).title).toBe("");
    expect(fields(`<meta property="og:title" content="early" ${attrs}>`).title).toBe("early");
  });

  test("a tag with thousands of attributes is too long to be a meta tag and is skipped", () => {
    const attrs = Array.from({ length: 3000 }, (_, i) => `a${i}="1"`).join(" ");
    expect(fields(`<meta property="og:title" content="early" ${attrs}><title>T</title>`).title).toBe("T");
  });

  test("null bytes and binary garbage do not break it", () => {
    const garbage = String.fromCharCode(...Array.from({ length: 2000 }, (_, i) => (i * 7) % 256));
    const result = parsePreviewFields(`${garbage}<title>Found</title>${garbage}`, "https://example.com/");
    expect(result.title).toBe("Found");
    expect(fields(`<meta property="og:title" content="a\u0000b">`).title).toBe("a b");
  });

  test("half a million bytes of broken tags is read quickly", () => {
    const evil = [
      `<meta content="${"x".repeat(7000)}`.repeat(70),
      "<a ".repeat(100_000),
      "<title>".repeat(10_000),
      "<!-".repeat(50_000),
      `<meta property="og:title" content="late">`,
    ].join("").slice(0, 512 * 1024);
    const started = performance.now();
    parsePreviewFields(evil, "https://example.com/");
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("half a million unclosed quotes is read quickly", () => {
    const evil = '<meta content="'.repeat(35_000);
    const started = performance.now();
    parsePreviewFields(evil, "https://example.com/");
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("a million-character title is bounded", () => {
    const result = fields(`<title>${"y".repeat(1_000_000)}</title>`);
    expect(Array.from(result.title).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  test("extractMetadata on nothing", () => {
    expect(extractMetadata("")).toEqual({ meta: {}, titleTag: "" });
    expect(extractMetadata(null)).toEqual({ meta: {}, titleTag: "" });
    expect(extractMetadata(undefined)).toEqual({ meta: {}, titleTag: "" });
  });

  test("only the wanted keys are kept", () => {
    const { meta } = extractMetadata(
      `<meta name="viewport" content="width=device-width"><meta property="og:title" content="x"><meta name="__proto__" content="bad"><meta name="constructor" content="bad">`,
    );
    expect(Object.keys(meta)).toEqual(["og:title"]);
    expect(Object.getPrototypeOf(meta)).toBeNull();
  });
});

describe("page encodings", () => {
  const latin1 = (text) => Buffer.from(text, "latin1");

  test("UTF-8 is the default and its byte order mark is dropped", () => {
    expect(decodeHtml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<title>é</title>")]))).toBe("<title>é</title>");
  });

  test("the Content-Type charset is used", () => {
    expect(decodeHtml(latin1("caf\xe9"), "text/html; charset=iso-8859-1")).toBe("café");
    expect(decodeHtml(latin1("caf\xe9"), "text/html; charset=windows-1252")).toBe("café");
    expect(decodeHtml(latin1("caf\xe9"), 'text/html; charset="ISO-8859-1"')).toBe("café");
  });

  test("a <meta charset> is used when the header names none", () => {
    expect(decodeHtml(latin1('<meta charset="windows-1252"><title>caf\xe9</title>'), "text/html")).toBe(
      '<meta charset="windows-1252"><title>café</title>',
    );
    expect(
      decodeHtml(latin1('<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1"><title>caf\xe9</title>'), "text/html"),
    ).toContain("café");
  });

  test("an unknown charset falls back to UTF-8 instead of failing", () => {
    expect(decodeHtml(Buffer.from("<title>ok</title>"), "text/html; charset=x-nonsense")).toBe("<title>ok</title>");
  });

  test("invalid UTF-8 becomes replacement characters", () => {
    expect(decodeHtml(Buffer.from([0x3c, 0xff, 0xfe, 0x3e]))).toBe("<��>");
  });
});

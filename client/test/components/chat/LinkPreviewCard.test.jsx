import { describe, test, expect } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import LinkPreviewCard from "../../../src/components/chat/linkPreview/LinkPreviewCard.jsx";

// A data: picture, so the test needs no server (and no 404 for a made-up path).
const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const PREVIEW = {
  url: "https://example.com/post",
  siteName: "Example News",
  title: "A very important headline",
  description: "The first lines of the article, as the site describes them.",
  image: { url: PIXEL, width: 640, height: 360 },
};

const card = () => document.querySelector("[data-link-preview]");

describe("LinkPreviewCard", () => {
  test("shows the site, the title and the description", async () => {
    await render(<LinkPreviewCard url="https://example.com/post" preview={PREVIEW} />);
    await expect.element(page.getByText("Example News")).toBeVisible();
    await expect.element(page.getByText("A very important headline")).toBeVisible();
    await expect.element(page.getByText(/The first lines of the article/)).toBeVisible();
  });

  test("is a link that opens in a new tab without giving the site the opener", async () => {
    await render(<LinkPreviewCard url="https://example.com/post" preview={PREVIEW} />);
    const link = card();
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com/post");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("draggable")).toBe("false");
  });

  test("is left out of selected and copied text", async () => {
    await render(<LinkPreviewCard url="https://example.com/post" preview={PREVIEW} />);
    expect(card().hasAttribute("data-no-select")).toBe(true);
  });

  test("has a 2px accent bar, a bold title and a two-line description", async () => {
    await render(<LinkPreviewCard url="https://example.com/post" preview={PREVIEW} />);
    const bar = card().querySelector("span[aria-hidden='true']");
    expect(bar.className).toContain("w-0.5");
    const title = [...card().querySelectorAll("span")].find((el) => el.textContent === PREVIEW.title);
    expect(title.className).toContain("font-bold");
    expect(title.className).toContain("line-clamp-2");
    const description = [...card().querySelectorAll("span")].find((el) => el.textContent === PREVIEW.description);
    expect(description.className).toContain("line-clamp-2");
  });

  test("a small picture of 64px, loaded from the address it was given", async () => {
    await render(<LinkPreviewCard url="https://example.com/post" preview={PREVIEW} />);
    const image = card().querySelector("img");
    expect(image.getAttribute("src")).toBe(PIXEL);
    expect(image.className).toContain("h-16");
    expect(image.className).toContain("w-16");
    expect(image.getAttribute("alt")).toBe("");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  test("without a picture there is no picture", async () => {
    await render(<LinkPreviewCard url="https://example.com/post" preview={{ ...PREVIEW, image: null }} />);
    expect(card().querySelector("img")).toBeNull();
    await expect.element(page.getByText("A very important headline")).toBeVisible();
  });

  test("a picture that fails to load disappears and the text stays", async () => {
    await render(
      <LinkPreviewCard
        url="https://example.com/post"
        preview={{ ...PREVIEW, image: { url: "data:image/png;base64,AAAA" } }}
      />,
    );
    await expect.poll(() => card().querySelector("img")).toBeNull();
    await expect.element(page.getByText("A very important headline")).toBeVisible();
  });

  test("a page's text is text: markup in it is shown, not run", async () => {
    await render(
      <LinkPreviewCard
        url="https://example.com/post"
        preview={{
          ...PREVIEW,
          title: '<img src=x onerror="window.__xss = 1">Hello',
          description: "<script>window.__xss = 1</script>",
          siteName: "<b>bold</b>",
        }}
      />,
    );
    expect(window.__xss).toBeUndefined();
    expect(card().querySelector("img[src='x']")).toBeNull();
    expect(card().querySelector("script")).toBeNull();
    expect(card().querySelector("b")).toBeNull();
    expect(card().textContent).toContain("<script>window.__xss = 1</script>");
  });

  test("only what the page has is drawn", async () => {
    await render(
      <LinkPreviewCard url="https://example.com/post" preview={{ ...PREVIEW, siteName: "", description: "", image: null }} />,
    );
    expect(card().textContent).toBe("A very important headline");
  });

  test("Persian text gets the Persian font and a right-to-left layout", async () => {
    await render(
      <LinkPreviewCard
        url="https://example.com/fa"
        preview={{ ...PREVIEW, title: "عنوان خبر مهم", description: "توضیح کوتاه", siteName: "خبر" }}
      />,
    );
    expect(card().className).toContain("font-fa");
    expect(card().getAttribute("dir")).toBe("auto");
  });

  test("nothing to show draws nothing", async () => {
    await render(<LinkPreviewCard url="" preview={PREVIEW} />);
    expect(card()).toBeNull();
    await render(<LinkPreviewCard url="https://example.com/" preview={null} />);
    expect(card()).toBeNull();
  });

  test("an own message and someone else's use different colours", async () => {
    await render(<LinkPreviewCard url="https://example.com/a" preview={PREVIEW} isOwn />);
    const own = card().innerHTML;
    document.body.innerHTML = "";
    await render(<LinkPreviewCard url="https://example.com/a" preview={PREVIEW} />);
    expect(card().innerHTML).not.toBe(own);
  });
});

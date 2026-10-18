import { describe, test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { AppearanceSettingsPanel } from "../../../src/components/settings/panels/AppearanceSettingsPanel.jsx";
import { setEmojiSize } from "../../../src/emoji/emojiSize.js";
import { renderMarkdownBlock } from "../../../src/utils/markdown.js";

const html = document.documentElement;
const widthOf = (element) => element.getBoundingClientRect().width;
const sample = (size) => document.querySelector(`label[data-emoji-size="${size}"] img`);

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
// The test server has no emoji pictures, and a picture that is missing is drawn
// as its alt text whatever size the CSS gives it. So the pictures are swapped for a loaded one.
async function loadPictures(root = document) {
  const images = [...root.querySelectorAll("img.emoji")];
  images.forEach((image) => image.setAttribute("src", PIXEL));
  await Promise.all(images.map((image) => image.decode()));
  return images;
}

beforeEach(() => {
  localStorage.clear();
  setEmojiSize("large");
});

describe("the emoji size setting in Appearance", () => {
  test.each(["desktop", "mobile"])("the %s panel offers Large, Medium and Normal, with Large chosen to begin with", async (variant) => {
    render(<AppearanceSettingsPanel variant={variant} />);
    await expect.element(page.getByRole("group", { name: "Emoji-only messages (up to 3 emoji)" })).toBeInTheDocument();
    await expect.element(page.getByRole("radio", { name: "Large" })).toBeChecked();
    await expect.element(page.getByRole("radio", { name: "Medium" })).not.toBeChecked();
    await expect.element(page.getByRole("radio", { name: "Normal" })).not.toBeChecked();
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });

  test("choosing a size applies at once to the whole app and is remembered on this device", async () => {
    render(<AppearanceSettingsPanel />);
    expect(html.getAttribute("data-emoji-size")).toBe("large");
    await page.getByRole("radio", { name: "Medium" }).click();
    await expect.element(page.getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(html.getAttribute("data-emoji-size")).toBe("medium");
    expect(localStorage.getItem("aurelle-emoji-size")).toBe("medium");
    await page.getByRole("radio", { name: "Normal" }).click();
    await expect.element(page.getByRole("radio", { name: "Medium" })).not.toBeChecked();
    expect(html.getAttribute("data-emoji-size")).toBe("normal");
    expect(localStorage.getItem("aurelle-emoji-size")).toBe("normal");
  });

  test("opens on the size that was chosen before", async () => {
    setEmojiSize("normal");
    render(<AppearanceSettingsPanel />);
    await expect.element(page.getByRole("radio", { name: "Normal" })).toBeChecked();
    await expect.element(page.getByRole("radio", { name: "Large" })).not.toBeChecked();
  });

  test("the keyboard works: the arrow keys move between the three", async () => {
    await render(<AppearanceSettingsPanel />);
    page.getByRole("radio", { name: "Large" }).element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(html.getAttribute("data-emoji-size")).toBe("medium");
    await userEvent.keyboard("{ArrowRight}");
    expect(html.getAttribute("data-emoji-size")).toBe("normal");
  });

  test("each choice shows a sample at its own size, whatever is chosen for the app", async () => {
    await render(<AppearanceSettingsPanel />);
    await loadPictures();
    for (const chosen of ["large", "medium", "normal"]) {
      setEmojiSize(chosen);
      const [large, medium, normal] = ["large", "medium", "normal"].map((size) => widthOf(sample(size)));
      expect(large).toBeGreaterThan(medium);
      expect(medium).toBeGreaterThan(normal);
    }
  });
});

describe("messages in the chat", () => {
  // The message HTML is what a chat shows for each text.
  const message = async (text) => {
    const { container } = await render(<div dangerouslySetInnerHTML={{ __html: renderMarkdownBlock(text) }} />);
    return loadPictures(container);
  };
  const widthsFor = (images) =>
    ["large", "medium", "normal"].map((size) => {
      setEmojiSize(size);
      return images.map(widthOf);
    });

  test("one to three emoji on their own get bigger or smaller with the choice", async () => {
    const images = await message("😀😀");
    expect(images).toHaveLength(2);
    expect(images[0].classList.contains("emoji-jumbo")).toBe(true);
    const [large, medium, normal] = widthsFor(images);
    expect(large[0]).toBeGreaterThan(medium[0]);
    expect(medium[0]).toBeGreaterThan(normal[0]);
    expect(large[1]).toBe(large[0]);
  });

  test("Normal is the size of an emoji inside a line of text", async () => {
    const [jumbo] = await message("😀");
    const [inline] = await message("hi 😀");
    // The em rule of a plain emoji (index.css); the tests do not load that file.
    inline.style.width = "1.3em";
    inline.style.height = "1.3em";
    setEmojiSize("normal");
    expect(widthOf(jumbo)).toBeCloseTo(widthOf(inline), 1);
  });

  test("more than three emoji, or text with an emoji, do not change with the choice", async () => {
    for (const text of ["😀😀😀😀", "hello 😀", "😀 hello"]) {
      const images = await message(text);
      expect(images.length).toBeGreaterThan(0);
      expect(images.some((image) => image.classList.contains("emoji-jumbo"))).toBe(false);
      const [large, medium, normal] = widthsFor(images);
      expect(medium).toEqual(large);
      expect(normal).toEqual(large);
    }
  });
});

import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import EmojiPicker from "../../../src/components/chat/emoji/EmojiPicker.jsx";

beforeEach(() => localStorage.clear());

const emojiButton = (name) => page.getByRole("button", { name, exact: true });

describe("EmojiPicker", () => {
  test("shows every category, with the smileys first, and loads on demand", async () => {
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} />);
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
    const tabs = document.querySelectorAll('[role="tablist"] button');
    expect(tabs).toHaveLength(9);
    const firstTitle = document.querySelector("[data-emoji-section] h3");
    expect(firstTitle.textContent).toBe("Smileys & Emotion");
  });

  test("picking an emoji hands it over and remembers it as recently used", async () => {
    const onSelect = vi.fn();
    render(<EmojiPicker onSelect={onSelect} onClose={() => {}} />);
    await emojiButton("grinning").click();
    expect(onSelect).toHaveBeenCalledWith("😀");
    expect(JSON.parse(localStorage.getItem("aurelle-emoji-recent"))).toEqual(["😀"]);
  });

  test("recently used emoji come first the next time", async () => {
    localStorage.setItem("aurelle-emoji-recent", JSON.stringify(["🔥"]));
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} />);
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
    const first = document.querySelector("[data-emoji-section] h3");
    expect(first.textContent).toBe("Frequently used");
    expect(document.querySelector("[data-emoji-section] button img").getAttribute("alt")).toBe("🔥");
  });

  test("searching finds emoji by name and replaces the categories", async () => {
    const onSelect = vi.fn();
    render(<EmojiPicker onSelect={onSelect} onClose={() => {}} />);
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("fire");
    await expect.element(emojiButton("fire")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-emoji-section] h3")).toHaveLength(0);
    await emojiButton("fire").click();
    expect(onSelect).toHaveBeenCalledWith("🔥");
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("qqqqzzzz");
    await expect.element(page.getByText("No emoji found")).toBeInTheDocument();
  });

  test("a skin tone can be chosen and is used for people and hands", async () => {
    const onSelect = vi.fn();
    render(<EmojiPicker onSelect={onSelect} onClose={() => {}} />);
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
    await page.getByRole("button", { name: /Skin tone/ }).click();
    await page.getByRole("menuitemradio", { name: "Medium", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("wave");
    await emojiButton("wave").click();
    expect(onSelect).toHaveBeenCalledWith("👋🏽");
  });

  test("Escape closes only the picker: the rest of the app does not see that key press", async () => {
    const elsewhere = vi.fn();
    document.addEventListener("keydown", elsewhere);
    window.addEventListener("keydown", elsewhere);
    const onClose = vi.fn();
    render(<EmojiPicker onSelect={() => {}} onClose={onClose} />);
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(elsewhere).not.toHaveBeenCalled(); // e.g. the handler that closes the open chat
    document.removeEventListener("keydown", elsewhere);
    window.removeEventListener("keydown", elsewhere);
  });

  test("Escape closes it", async () => {
    const onClose = vi.fn();
    render(<EmojiPicker onSelect={() => {}} onClose={onClose} />);
    await expect.element(emojiButton("grinning")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

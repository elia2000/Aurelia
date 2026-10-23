/**
 * The text of an element, whitespace collapsed, for `expect.poll(textOf(locator)).toMatch(...)`.
 * (The browser matchers compare the whole text; polling a substring is what these tests mean.)
 */
export const textOf = (locator) => () => String(locator.element().textContent || "").replace(/\s+/g, " ").trim();

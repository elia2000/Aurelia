import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import NewVersionBanner from "../../../src/components/pwa/NewVersionBanner.jsx";

describe("NewVersionBanner", () => {
  test("shows nothing while the page is current", async () => {
    render(<NewVersionBanner clientBuildId="a-1" fetchBuildId={async () => "a-1"} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).not.toContain("new version");
  });

  test("offers a reload when the server has a newer build, and reloads on request", async () => {
    const reload = vi.fn();
    render(<NewVersionBanner clientBuildId="a-1" fetchBuildId={async () => "a-2"} onReload={reload} />);
    await expect.element(page.getByText(/new version of/i)).toBeInTheDocument();
    await page.getByRole("button", { name: "Reload" }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("can be put off, and a failing check says nothing", async () => {
    render(<NewVersionBanner clientBuildId="a-1" fetchBuildId={async () => "a-2"} />);
    await expect.element(page.getByText(/new version of/i)).toBeInTheDocument();
    await page.getByRole("button", { name: "Later" }).click();
    expect(document.body.textContent).not.toContain("new version of");

    render(<NewVersionBanner clientBuildId="a-1" fetchBuildId={async () => { throw new Error("offline"); }} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).not.toContain("Reload");
  });
});

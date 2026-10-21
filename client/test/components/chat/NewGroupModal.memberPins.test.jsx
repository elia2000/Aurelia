import { useState } from "react";
import { describe, test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import NewGroupModal from "../../../src/components/modals/NewGroupModal.jsx";

const baseForm = {
  nickname: "Team",
  username: "team",
  groupColor: "#10b981",
  visibility: "private",
  allowMemberInvites: true,
  allowMemberPins: false,
};

function Harness({ showMemberPinsSetting, onChange }) {
  const [form, setForm] = useState(baseForm);
  onChange?.(form);
  return (
    <NewGroupModal
      open
      groupForm={form}
      setGroupForm={setForm}
      groupSearchQuery=""
      setGroupSearchQuery={vi.fn()}
      groupSearchResults={[]}
      groupSearchLoading={false}
      selectedGroupMembers={[]}
      setSelectedGroupMembers={vi.fn()}
      groupError=""
      setGroupError={vi.fn()}
      creatingGroup={false}
      onCreate={vi.fn()}
      onClose={vi.fn()}
      title="Edit group"
      submitLabel="Save"
      showMemberPinsSetting={showMemberPinsSetting}
    />
  );
}

describe("NewGroupModal - Members Can Pin Messages", () => {
  test("is not offered by default (creating a group, or a channel)", async () => {
    await render(<Harness showMemberPinsSetting={false} />);
    await expect.element(page.getByText("Members Can Invite")).toBeVisible();
    expect(document.body.textContent).not.toContain("Members Can Pin Messages");
  });

  test("an existing group's owner sees the switch, off, and can turn it on and off", async () => {
    let latest = null;
    await render(<Harness showMemberPinsSetting onChange={(form) => { latest = form; }} />);
    const toggle = page.getByRole("switch", { name: /Members Can Pin Messages/ });
    await expect.element(toggle).toBeVisible();
    await expect.element(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    expect(latest.allowMemberPins).toBe(true);
    await toggle.click();
    expect(latest.allowMemberPins).toBe(false);
  });
});

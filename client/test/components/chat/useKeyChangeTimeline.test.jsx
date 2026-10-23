import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

const holder = vi.hoisted(() => ({ services: null }));
vi.mock("../../../src/e2ee/services.js", () => ({ getE2eeServices: () => holder.services }));

import { createDirectory } from "../../../src/e2ee/directory.js";
import { createKeyStore, createMemoryAdapter } from "../../../src/e2ee/keyStore.js";
import { createTrustTracker } from "../../../src/e2ee/trust.js";
import { __setKeyNoticeStoreForTests, createKeyNoticeStore } from "../../../src/e2ee/keyChangeNotices.js";
import { useKeyChangeTimeline } from "../../../src/e2ee/useKeyChangeTimeline.js";
import { makeIdentity } from "../../e2ee/helpers.js";

const BOB = { id: "bob", username: "bob", nickname: "Bob" };
let bob1;
let bob2;
let devices;
let trust;
let storage;

function Harness({ messages = [], peer = BOB, chatType = "dm", chatId = "chat-1", selfUserId = "me" }) {
  const merged = useKeyChangeTimeline({ messages, chatId, chatType, peer, selfUserId });
  return (
    <ol>
      {merged.map((m) => (
        <li key={m.id} data-local={m._localOnly ? "1" : "0"}>
          {m._systemEvent?.text || m.body}
        </li>
      ))}
    </ol>
  );
}

const lines = () => [...document.querySelectorAll("li")].map((li) => li.textContent);
const stored = (key = "me:bob") => JSON.parse(storage.map.get(`aurelle-key-notices:${key}`) || "[]");

beforeEach(async () => {
  bob1 = await makeIdentity("bob");
  bob2 = await makeIdentity("bob");
  devices = [bob1.record];
  trust = createTrustTracker(createKeyStore(createMemoryAdapter()));
  const api = {
    fetchUserDevices: vi.fn(async () => ({ devices })),
    fetchChatDevices: vi.fn(),
  };
  holder.services = { trust, directory: createDirectory({ api, trust, ttlMs: 0 }), api };
  const map = new Map();
  storage = { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  __setKeyNoticeStoreForTests(createKeyNoticeStore({ storage }));
});
afterEach(() => __setKeyNoticeStoreForTests(null));

const messages = [{ id: "m1", username: "bob", body: "hi", created_at: new Date(Date.now() - 3600_000).toISOString() }];

describe("useKeyChangeTimeline - notices made from what the trust tracker sees", () => {
  test("opening a chat with a contact whose devices did not change adds nothing", async () => {
    const view = await render(<Harness messages={messages} />);
    await vi.waitFor(() => expect(holder.services.api.fetchUserDevices).toHaveBeenCalled());
    await view.unmount();
    // The second visit is the same contact with the same device.
    await render(<Harness messages={messages} />);
    await vi.waitFor(() => expect(holder.services.api.fetchUserDevices).toHaveBeenCalledTimes(2));
    expect(lines()).toEqual(["hi"]);
  });

  test("a device that appears while the chat is open between two visits is noticed once, and stays across reloads", async () => {
    const first = await render(<Harness messages={messages} />);
    await vi.waitFor(() => expect(holder.services.api.fetchUserDevices).toHaveBeenCalledTimes(1));
    await first.unmount();

    devices = [bob1.record, bob2.record];
    await render(<Harness messages={messages} />);
    await expect.element(page.getByText("Bob added a new device. Verify the safety number")).toBeInTheDocument();
    expect(lines()).toEqual(["hi", "Bob added a new device. Verify the safety number"]);
    expect(document.querySelector('li[data-local="1"]')).not.toBeNull();

    // Looking again (any number of times) keeps it one line.
    for (let i = 0; i < 3; i += 1) await holder.services.directory.getUserDevices("bob", { force: true });
    expect(stored()).toHaveLength(1);

    // A reload: a fresh store reads the same storage, and the line is where it was.
    __setKeyNoticeStoreForTests(createKeyNoticeStore({ storage }));
    document.body.innerHTML = "";
    await render(<Harness messages={messages} />);
    await expect.element(page.getByText("Bob added a new device. Verify the safety number")).toBeInTheDocument();
    expect(lines().filter((t) => t.includes("added a new device"))).toHaveLength(1);
  });

  test("for a verified contact the same change is 'Safety number changed'", async () => {
    await holder.services.directory.getUserDevices("bob");
    await trust.setVerified("bob", "123", true, [bob1.record]);
    devices = [bob1.record, bob2.record];
    await render(<Harness messages={messages} />);
    await expect.element(page.getByText(/^Safety number changed\. Bob added a new device/)).toBeInTheDocument();
  });

  test("a device that went away is a line of its own", async () => {
    devices = [bob1.record, bob2.record];
    await holder.services.directory.getUserDevices("bob");
    devices = [bob1.record];
    await render(<Harness messages={messages} />);
    await expect.element(page.getByText("Bob removed a device. Verify the safety number")).toBeInTheDocument();
  });

  test("keys that changed for a known device are a red line, and it is over when they are consistent again", async () => {
    await holder.services.directory.getUserDevices("bob");
    const evil = await makeIdentity("bob", bob1.record.id);
    devices = [evil.record];
    const view = await render(<Harness messages={messages} />);
    await expect.element(page.getByText(/security keys changed unexpectedly/)).toBeInTheDocument();
    await view.unmount();
    devices = [bob1.record];
    await render(<Harness messages={messages} />);
    await expect.element(page.getByText("Bob's security keys match again")).toBeInTheDocument();
  });

  test("accepting the device (from anywhere) settles the line without a reload", async () => {
    await holder.services.directory.getUserDevices("bob");
    devices = [bob1.record, bob2.record];
    await render(<Harness messages={messages} />);
    await expect.element(page.getByText("Bob added a new device. Verify the safety number")).toBeInTheDocument();
    await holder.services.directory.acknowledge("bob", devices);
    await expect.element(page.getByText("You accepted Bob's new device")).toBeInTheDocument();
    expect(stored()[0]).toMatchObject({ state: "resolved", resolution: "accepted" });
  });

  test("verifying the new number settles it as verified", async () => {
    await holder.services.directory.getUserDevices("bob");
    devices = [bob1.record, bob2.record];
    await render(<Harness messages={messages} />);
    await expect.element(page.getByText("Bob added a new device. Verify the safety number")).toBeInTheDocument();
    await trust.setVerified("bob", "999", true, devices);
    await expect.element(page.getByText("You verified Bob's new safety number")).toBeInTheDocument();
  });

  test("notes are kept per contact and per signed-in person", async () => {
    await holder.services.directory.getUserDevices("bob");
    devices = [bob1.record, bob2.record];
    const view = await render(<Harness messages={messages} />);
    await expect.element(page.getByText(/added a new device/)).toBeInTheDocument();
    expect(stored("me:bob")).toHaveLength(1);

    // Another person's chat does not show Bob's note.
    await view.rerender(<Harness messages={messages} peer={{ id: "carol", username: "carol" }} chatId="chat-2" />);
    await vi.waitFor(() => expect(lines()).toEqual(["hi"]));
    expect(stored("me:carol")).toHaveLength(0);

    // Another account on the same browser has notes of its own: it never reads "me"'s.
    await view.rerender(<Harness messages={messages} selfUserId="someone-else" />);
    await vi.waitFor(() => expect(stored("someone-else:bob")).toHaveLength(1));
    expect(stored("someone-else:bob")[0].id).not.toBe(stored("me:bob")[0].id);
    expect(stored("me:bob")).toHaveLength(1);
  });

  test("groups, channels, saved messages and deleted accounts get nothing and look nothing up", async () => {
    await holder.services.directory.getUserDevices("bob");
    devices = [bob1.record, bob2.record];
    const calls = holder.services.api.fetchUserDevices.mock.calls.length;
    for (const props of [{ chatType: "group" }, { chatType: "channel" }, { chatType: "saved" }, { peer: { ...BOB, isDeleted: true } }, { peer: null }]) {
      const view = await render(<Harness messages={messages} {...props} />);
      expect(lines()).toEqual(["hi"]);
      await view.unmount();
    }
    expect(holder.services.api.fetchUserDevices.mock.calls.length).toBe(calls);
    expect(stored()).toHaveLength(0);
  });

  test("a failing directory (offline) changes nothing and breaks nothing", async () => {
    holder.services.api.fetchUserDevices.mockRejectedValue(new Error("offline"));
    await render(<Harness messages={messages} />);
    await vi.waitFor(() => expect(holder.services.api.fetchUserDevices).toHaveBeenCalled());
    expect(lines()).toEqual(["hi"]);
  });

  test("the notice is a local line: it has no id the server knows and is never unread", async () => {
    await holder.services.directory.getUserDevices("bob");
    devices = [bob1.record, bob2.record];
    await render(<Harness messages={messages} />);
    await expect.element(page.getByText(/added a new device/)).toBeInTheDocument();
    expect(stored().every((n) => !("body" in n) && !("chat_id" in n))).toBe(true);
    expect(JSON.stringify(stored())).not.toContain("hi");
  });
});

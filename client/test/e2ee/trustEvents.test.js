import { describe, test, expect, beforeEach, vi } from "vitest";
import { createKeyStore, createMemoryAdapter } from "../../src/e2ee/keyStore.js";
import { createTrustTracker, TRUST } from "../../src/e2ee/trust.js";
import { makeIdentity } from "./helpers.js";

// The tracker tells whoever listens what it saw (so the chat can say "Bob
// added a new device"). Listening never changes an answer, and a broken
// listener never breaks the check it listens to.
describe("trust events", () => {
  let store;
  let trust;
  let events;
  beforeEach(() => {
    store = createKeyStore(createMemoryAdapter());
    trust = createTrustTracker(store);
    events = [];
    trust.subscribe((event) => events.push(event));
  });

  test("first sight is reported as new, with nothing known before", async () => {
    const bob = await makeIdentity("bob");
    await trust.assess("bob", [bob.record]);
    expect(events).toEqual([
      { type: "assessed", userId: "bob", status: TRUST.NEW, added: [], removed: [], mismatched: [], listed: [bob.record.id], known: 0, verified: false },
    ]);
  });

  test("an added device is reported on every lookup until it is acknowledged, then never again", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record]);
    events.length = 0;
    await trust.assess("bob", [bob1.record, bob2.record]);
    await trust.assess("bob", [bob1.record, bob2.record]);
    expect(events.map((e) => [e.type, e.status, e.added, e.known])).toEqual([
      ["assessed", TRUST.DEVICES_ADDED, [bob2.record.id], 1],
      ["assessed", TRUST.DEVICES_ADDED, [bob2.record.id], 1],
    ]);
    await trust.acknowledge("bob", [bob1.record, bob2.record]);
    await trust.assess("bob", [bob1.record, bob2.record]);
    expect(events.at(-1)).toMatchObject({ type: "assessed", status: TRUST.OK, added: [] });
  });

  test("the event says whether the person had been verified", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record]);
    await trust.setVerified("bob", "123", true, [bob1.record]);
    events.length = 0;
    await trust.assess("bob", [bob1.record, bob2.record]);
    expect(events[0]).toMatchObject({ status: TRUST.DEVICES_ADDED, verified: true });
  });

  test("the event lists every device the server listed, so a device that went away can be told from one that was accepted", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record]);
    events.length = 0;
    await trust.assess("bob", [bob1.record, bob2.record]);
    await trust.assess("bob", [bob1.record]);
    expect(events.map((e) => e.listed)).toEqual([[bob1.record.id, bob2.record.id], [bob1.record.id]]);
  });

  test("a revoked device is reported once, as removed", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record, bob2.record]);
    events.length = 0;
    await trust.assess("bob", [bob1.record]);
    await trust.assess("bob", [bob1.record]);
    expect(events.map((e) => [e.status, e.removed, e.known])).toEqual([
      [TRUST.OK, [bob2.record.id], 2],
      [TRUST.OK, [], 1],
    ]);
  });

  test("changed keys for a known device are reported as a mismatch", async () => {
    const bob = await makeIdentity("bob");
    await trust.assess("bob", [bob.record]);
    events.length = 0;
    const evil = await makeIdentity("bob", bob.record.id);
    const result = await trust.assess("bob", [evil.record]);
    expect(result.status).toBe(TRUST.KEY_MISMATCH);
    expect(events).toEqual([
      { type: "assessed", userId: "bob", status: TRUST.KEY_MISMATCH, added: [], removed: [], mismatched: [bob.record.id], listed: [bob.record.id], known: 1, verified: false },
    ]);
  });

  test("acknowledging and verifying are reported", async () => {
    const bob = await makeIdentity("bob");
    await trust.assess("bob", [bob.record]);
    events.length = 0;
    await trust.acknowledge("bob", [bob.record]);
    await trust.setVerified("bob", "42", true, [bob.record]);
    await trust.setVerified("bob", "42", false);
    expect(events).toEqual([
      { type: "acknowledged", userId: "bob" },
      { type: "verified", userId: "bob", verified: true },
      { type: "verified", userId: "bob", verified: false },
    ]);
  });

  test("events cannot be used to change the pins: a listener only gets copies", async () => {
    const bob1 = await makeIdentity("bob");
    const bob2 = await makeIdentity("bob");
    await trust.assess("bob", [bob1.record]);
    trust.subscribe((event) => {
      event.added?.push?.("sneaky");
      if (event.added) Object.freeze(event.added);
    });
    const first = await trust.assess("bob", [bob1.record, bob2.record]);
    const second = await trust.assess("bob", [bob1.record, bob2.record]);
    expect(first.added).toEqual([bob2.record.id]);
    expect(second.added).toEqual([bob2.record.id]);
    expect(Object.keys((await store.getPeer("bob")).devices)).toEqual([bob1.record.id]);
  });

  test("a listener that throws breaks neither the check nor the other listeners", async () => {
    const seen = vi.fn();
    trust.subscribe(() => {
      throw new Error("boom");
    });
    trust.subscribe(seen);
    const bob = await makeIdentity("bob");
    await expect(trust.assess("bob", [bob.record])).resolves.toMatchObject({ status: TRUST.NEW });
    await expect(trust.acknowledge("bob", [bob.record])).resolves.toBeUndefined();
    await expect(trust.setVerified("bob", "1")).resolves.toBeUndefined();
    expect(seen).toHaveBeenCalledTimes(3);
  });

  test("an async listener that rejects does not surface as an unhandled rejection", async () => {
    trust.subscribe(async () => {
      throw new Error("later");
    });
    const bob = await makeIdentity("bob");
    await expect(trust.assess("bob", [bob.record])).resolves.toMatchObject({ status: TRUST.NEW });
  });

  test("unsubscribing stops the events", async () => {
    const seen = vi.fn();
    const stop = trust.subscribe(seen);
    const bob = await makeIdentity("bob");
    await trust.assess("bob", [bob.record]);
    stop();
    await trust.assess("bob", [bob.record]);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  test("a tracker nobody listens to behaves as before", async () => {
    const quiet = createTrustTracker(createKeyStore(createMemoryAdapter()));
    const bob = await makeIdentity("bob");
    expect((await quiet.assess("bob", [bob.record])).status).toBe(TRUST.NEW);
    expect((await quiet.assess("bob", [bob.record])).status).toBe(TRUST.OK);
  });
});

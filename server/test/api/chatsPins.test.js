import { describe, test, expect, vi } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  CHAT_ID,
  MSG_ID,
  makePinApp,
  pinAs,
} from "../helpers/pinFixture.js";

const putGroup = async (ctx, username, body) => {
  const cookie = await ctx.login(username);
  return request(ctx.app)
    .put(`/api/chats/group/${CHAT_ID}`)
    .set("Cookie", cookie)
    .send({
      username,
      nickname: "Friends",
      groupUsername: "friends",
      visibility: "public",
      allowMemberInvites: true,
      ...body,
    });
};

function makeSettingsApp({ chat, deps = {} } = {}) {
  const updateGroupChat = vi.fn((_chatId, payload) => {
    if (typeof payload.allowMemberPins === "boolean") {
      ctx.chatRecord.allow_member_pins = payload.allowMemberPins ? 1 : 0;
    }
  });
  const updateChannelChat = vi.fn();
  const ctx = makePinApp({
    chat,
    deps: {
      updateGroupChat,
      updateChannelChat,
      findChatByGroupUsername: () => null,
      ...deps,
    },
  });
  return { ctx, updateGroupChat, updateChannelChat };
}

describe("PUT /api/chats/group/:chatId allowMemberPins", () => {
  test("the owner turns the setting on and members can then pin", async () => {
    const { ctx, updateGroupChat } = makeSettingsApp();
    expect((await pinAs(ctx, "bob", MSG_ID)).status).toBe(403);

    const res = await putGroup(ctx, "alice", { allowMemberPins: true });
    expect(res.status).toBe(200);
    expect(updateGroupChat).toHaveBeenCalledTimes(1);
    expect(updateGroupChat.mock.calls[0][1]).toMatchObject({ allowMemberPins: true });

    expect((await pinAs(ctx, "bob", MSG_ID)).status).toBe(200);
  });

  test("the owner turns it off again", async () => {
    const { ctx } = makeSettingsApp({
      chat: { type: "group", name: "Friends", allow_member_pins: 1 },
    });
    const res = await putGroup(ctx, "alice", { allowMemberPins: false });
    expect(res.status).toBe(200);
    expect((await pinAs(ctx, "bob", MSG_ID)).status).toBe(403);
  });

  test("a save that does not mention the setting leaves it as it was", async () => {
    const { ctx, updateGroupChat } = makeSettingsApp({
      chat: { type: "group", name: "Friends", allow_member_pins: 1 },
    });
    const res = await putGroup(ctx, "alice", {});
    expect(res.status).toBe(200);
    expect(updateGroupChat.mock.calls[0][1]).not.toHaveProperty("allowMemberPins");
    expect((await pinAs(ctx, "bob", MSG_ID)).status).toBe(200);
  });

  test.each([
    ["a string", "true"],
    ["a number", 1],
    ["null", null],
    ["an object", {}],
  ])("%s is not a valid value", async (_label, value) => {
    const { ctx, updateGroupChat } = makeSettingsApp();
    const res = await putGroup(ctx, "alice", { allowMemberPins: value });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allowMemberPins/);
    expect(updateGroupChat).not.toHaveBeenCalled();
  });

  test("a plain member cannot change it", async () => {
    const { ctx, updateGroupChat } = makeSettingsApp();
    const res = await putGroup(ctx, "bob", { allowMemberPins: true });
    expect(res.status).toBe(403);
    expect(updateGroupChat).not.toHaveBeenCalled();
    expect((await pinAs(ctx, "bob", MSG_ID)).status).toBe(403);
  });

  test("somebody outside the group cannot change it", async () => {
    const { ctx, updateGroupChat } = makeSettingsApp();
    const res = await putGroup(ctx, "carol", { allowMemberPins: true });
    expect(res.status).toBe(403);
    expect(updateGroupChat).not.toHaveBeenCalled();
  });

  test("a channel ignores it: only the owner ever pins there", async () => {
    const { ctx, updateGroupChat, updateChannelChat } = makeSettingsApp({
      chat: { type: "channel", name: "News" },
    });
    const res = await putGroup(ctx, "alice", { allowMemberPins: true });
    expect(res.status).toBe(200);
    expect(updateGroupChat).not.toHaveBeenCalled();
    expect(updateChannelChat.mock.calls[0][1]).not.toHaveProperty("allowMemberPins");
    expect((await pinAs(ctx, "bob", MSG_ID)).status).toBe(403);
  });

  test("the setting is part of the group the client gets back", async () => {
    const { ctx } = makeSettingsApp();
    const res = await putGroup(ctx, "alice", { allowMemberPins: true });
    expect(res.body.group).toMatchObject({ id: CHAT_ID, allow_member_pins: 1 });
    expect(ALICE_ID).toBeTruthy();
    expect(BOB_ID).toBeTruthy();
  });
});

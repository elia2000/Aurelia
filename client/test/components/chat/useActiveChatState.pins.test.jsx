import { describe, test, expect } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useActiveChatState } from "../../../src/hooks/chat/useActiveChatState.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = { id: id(900), username: "alice" };
const dm = (n, nickname, extra = {}) => ({
  id: id(n),
  type: "dm",
  members: [
    { id: user.id, username: "alice", role: "member" },
    { id: id(n + 100), username: nickname.toLowerCase(), nickname, role: "member" },
  ],
  ...extra,
});

const run = (chats, chatsSearchQuery = "") =>
  renderHook(() =>
    useActiveChatState({
      chats,
      chatsSearchQuery,
      user,
      activeChatId: null,
      activeChatIdRef: { current: null },
      activeChatTypeRef: { current: null },
      activePeer: null,
    }),
  );

const names = (hook) => hook.result.current.visibleChats.map((chat) => chat.members[1].nickname);

describe("useActiveChatState - pinned chats", () => {
  // newest message first, as the list is kept
  const chats = [
    dm(1, "Ann"),
    dm(2, "Ben", { pinned: true, pinPosition: 1 }),
    dm(3, "Cat"),
    dm(4, "Dan", { pinned: true, pinPosition: 0 }),
  ];

  test("pinned chats come first in the person's order, the others keep theirs", async () => {
    expect(names(await run(chats))).toEqual(["Dan", "Ben", "Ann", "Cat"]);
  });

  test("a search lists the matches in the usual order (no pinned section)", async () => {
    expect(names(await run(chats, "an"))).toEqual(["Ann", "Dan"]);
  });

  test("with nothing pinned the list is the very same array", async () => {
    const plain = [dm(1, "Ann"), dm(2, "Ben")];
    expect((await run(plain)).result.current.visibleChats).toBe(plain);
  });

  test("a chat that is pinned is still found as the open chat", async () => {
    const hook = await renderHook(() =>
      useActiveChatState({
        chats,
        chatsSearchQuery: "",
        user,
        activeChatId: id(4),
        activeChatIdRef: { current: null },
        activeChatTypeRef: { current: null },
        activePeer: null,
      }),
    );
    expect(hook.result.current.activeChat.id).toBe(id(4));
  });
});

/**
 * The person to call, in the shape `startCall` takes, from a chat member
 * (what the header of a direct chat holds).
 */
export function toCallPeer(peer) {
  return {
    userId: peer.id,
    username: peer.username,
    nickname: peer.nickname,
    avatarUrl: peer.avatar_url,
    color: peer.color,
  };
}

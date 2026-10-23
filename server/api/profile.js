import { ownsPendingAvatarUpload } from "../lib/pendingAvatar.js";
import path from "node:path";
import { removeSavedGifFilesQuietly } from "../lib/savedGifCleanup.js";
import { loginGuardFor, sendTooManyAttempts } from "../lib/loginGuard.js";
import { twoFactorServiceFor } from "../lib/twoFactorService.js";

function registerProfileRoutes(app, deps) {
  const {
    ALLOWED_AVATAR_MIME_TYPES,
    AVATAR_FILE_LIMITS,
    createMessage,
    emitChatEvent,
    emitSseEvent,
    getSetting,
    broadcastPresence,
    listChatMembers,
    listChatsForUser,
    USER_COLORS,
    USERNAME_REGEX,
    bcrypt,
    ensureAvatarExists,
    findChatByGroupUsername,
    findUserById,
    findUserByUsername,
    isConnected,
    deleteUserById,
    hasEnoughFreeDiskSpace,
    avatarUploadRootDir,
    clearSessionCookie,
    removeAvatarByUrl,
    removePendingPresignedUploads,
    listPendingPresignedUploads,
    removeStoredFileNames,
    removeUploadedFiles,
    requireSession,
    requireSessionUsernameMatch,
    storageEncryption,
    storeAvatarFile = deps.storeAvatarFile,
    updateUserPassword,
    updateUserProfile,
    updateUserStatus,
    uploadAvatar,
  } = deps;

  const guard = loginGuardFor(deps);
  const twoFactor = twoFactorServiceFor(deps);
  const maybe = async (value) => (value && typeof value.then === "function" ? await value : value);

  // Ends the other sessions of a person and closes their live streams.
  const signOutOtherSessions = async (userId, keepPublicId, reason) => {
    if (typeof deps.revokeOtherUserSessions !== "function") return 0;
    const revoked = (await maybe(deps.revokeOtherUserSessions(userId, keepPublicId || null))) || [];
    if (revoked.length) {
      try {
        deps.closeSessionStreams?.({ sessionIds: revoked, payload: { type: "session_revoked", reason } });
      } catch {
        // the rows are gone; streams also notice on their next ping
      }
    }
    return revoked.length;
  };

  const emitProfileUpdate = async (user, options = {}) => {
    if (!user?.id) return;
    const currentUsername = String(user.username || "").toLowerCase();
    const previousUsername = String(options.previousUsername || "")
      .trim()
      .toLowerCase();
    const storedStatus = String(user.status || "online").toLowerCase();
    const effectiveStatus =
      typeof isConnected === "function" && isConnected(currentUsername) && storedStatus !== "invisible"
        ? "online"
        : "offline";
    const payload = {
      type: "profile_updated",
      userId: user.id,
      username: currentUsername,
      previousUsername: previousUsername || null,
      nickname: user.nickname || null,
      avatarUrl: ensureAvatarExists(user.id, user.avatar_url) || null,
      color: user.color || USER_COLORS[0],
      status: effectiveStatus,
      rawStatus: storedStatus,
    };
    const targets = new Set();
    if (currentUsername) targets.add(currentUsername);
    if (previousUsername) targets.add(previousUsername);
    const rawChats = listChatsForUser(user.id);
    const chats = (rawChats && typeof rawChats.then === "function" ? await rawChats : rawChats) || [];
    for (const chat of chats) {
      const rawMembers = listChatMembers(chat.id);
      const members = (rawMembers && typeof rawMembers.then === "function" ? await rawMembers : rawMembers) || [];
      members.forEach((member) => {
        const memberUsername = String(member?.username || "").toLowerCase();
        if (memberUsername) targets.add(memberUsername);
      });
    }
    targets.forEach((targetUsername) => {
      emitSseEvent(targetUsername, payload);
    });
  };

  app.get("/api/profile", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const username = req.query.username?.toString();
    if (!username) {
      return res.status(400).json({ error: "Username is required." });
    }

    const rawUser = findUserByUsername(username.toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({
      id: user.id,
      username: user.username,
      nickname: user.nickname || null,
      avatarUrl: ensureAvatarExists(user.id, user.avatar_url) || null,
      color: user.color || USER_COLORS[0],
      status: user.status || "online",
      role: user.role || "user",
      verified: Boolean(user.verified),
    });
  });

  app.put("/api/profile", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { currentUsername, username, nickname, avatarUrl } = req.body || {};
    if (!currentUsername || !username) {
      return res
        .status(400)
        .json({ error: "Current username and new username are required." });
    }

    const rawCurrentUser = findUserByUsername(currentUsername.toLowerCase());
    const currentUser = rawCurrentUser && typeof rawCurrentUser.then === "function" ? await rawCurrentUser : rawCurrentUser;
    if (!currentUser) {
      return res.status(404).json({ error: "User not found." });
    }

    if (!requireSessionUsernameMatch(res, session, currentUsername)) return;

    const trimmed = username.trim().toLowerCase();
    const usernameMax = getSetting("USERNAME_MAX_CHARS");
    const nicknameMax = getSetting("NICKNAME_MAX_CHARS");

    if (trimmed.length < 3) {
      return res
        .status(400)
        .json({ error: "Username must be at least 3 characters." });
    }
    if (usernameMax && trimmed.length > usernameMax) {
      return res.status(400).json({
        error: `Username must be at most ${usernameMax} characters.`,
      });
    }

    if (!USERNAME_REGEX.test(trimmed)) {
      return res.status(400).json({
        error:
          "Username can only include english letters, numbers, dot (.), and underscore (_).",
      });
    }
    if (nickname && String(nickname).trim().length > (nicknameMax || 0)) {
      return res.status(400).json({
        error: `Nickname must be at most ${nicknameMax} characters.`,
      });
    }

    if (trimmed !== currentUser.username) {
      const rawExisting = findUserByUsername(trimmed);
      const existing = rawExisting && typeof rawExisting.then === "function" ? await rawExisting : rawExisting;
      if (existing) {
        return res.status(409).json({ error: "Username already exists." });
      }
      if (findChatByGroupUsername) {
        const rawGroup = findChatByGroupUsername(trimmed);
        const group = rawGroup && typeof rawGroup.then === "function" ? await rawGroup : rawGroup;
        if (group) {
          return res.status(409).json({ error: "Username already exists." });
        }
      }
    }

    const nextAvatarUrl = String(avatarUrl || "").trim() || null;
    const currentAvatarUrl = String(currentUser.avatar_url || "").trim() || null;
    if (currentAvatarUrl && currentAvatarUrl !== nextAvatarUrl) {
      removeAvatarByUrl(currentAvatarUrl);
    }

    await updateUserProfile(
      currentUser.id,
      trimmed,
      nickname?.trim() || null,
      nextAvatarUrl,
    );

    const rawUpdated = findUserById(currentUser.id);
    const updated = rawUpdated && typeof rawUpdated.then === "function" ? await rawUpdated : rawUpdated;
    await emitProfileUpdate(updated, {
      previousUsername: currentUser.username,
    });
    if (typeof broadcastPresence === "function") {
      await broadcastPresence(String(updated.username || "").toLowerCase());
    }

    res.json({
      id: updated.id,
      username: updated.username,
      nickname: updated.nickname || null,
      avatarUrl: ensureAvatarExists(updated.id, updated.avatar_url) || null,
      color: updated.color || USER_COLORS[0],
      status: updated.status || "online",
    });
  });

  app.post("/api/profile/avatar", uploadAvatar.single("avatar"), async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      removeUploadedFiles(req.file ? [req.file] : [], avatarUploadRootDir);
      return;
    }

    const currentUsername = String(req.body?.currentUsername || "")
      .trim()
      .toLowerCase();
    const file = req.file;

    if (!getSetting("FILE_UPLOAD")) {
      removeUploadedFiles(file ? [file] : [], avatarUploadRootDir);
      return res
        .status(503)
        .json({ error: "File uploads are disabled on this server." });
    }

    if (!currentUsername) {
      removeUploadedFiles(file ? [file] : [], avatarUploadRootDir);
      return res.status(400).json({ error: "Current username is required." });
    }

    if (!requireSessionUsernameMatch(res, session, currentUsername)) {
      removeUploadedFiles(file ? [file] : [], avatarUploadRootDir);
      return;
    }

    const rawUser = findUserByUsername(currentUsername);
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      removeUploadedFiles(file ? [file] : [], avatarUploadRootDir);
      return res.status(404).json({ error: "User not found." });
    }

    const directAvatarUrl = String(req.body?.avatarUrl || "").trim();
    let avatarUrl = "";

    if (directAvatarUrl) {
      const fileName = path.basename(directAvatarUrl);
      if (
        (!directAvatarUrl.startsWith("/api/uploads/avatars/") &&
          !directAvatarUrl.startsWith("/uploads/avatars/")) ||
        !fileName.startsWith("avatar-") ||
        fileName.includes("..")
      ) {
        return res.status(400).json({ error: "Invalid avatar URL." });
      }
      if (!(await ownsPendingAvatarUpload({ listPendingPresignedUploads, userId: user.id, fileName }))) {
        return res.status(400).json({ error: "Invalid avatar URL." });
      }
      avatarUrl = directAvatarUrl.startsWith("/uploads/")
        ? `/api${directAvatarUrl}`
        : directAvatarUrl;
    } else {
      if (!file) {
        return res.status(400).json({ error: "Avatar file is required." });
      }

      const avatarMime = String(file.mimetype || "").toLowerCase();
      if (!ALLOWED_AVATAR_MIME_TYPES.has(avatarMime)) {
        removeUploadedFiles([file], avatarUploadRootDir);
        return res
          .status(400)
          .json({ error: "Avatar must be a JPEG, PNG, GIF, WEBP, or BMP image." });
      }

      if (typeof hasEnoughFreeDiskSpace === "function" && !hasEnoughFreeDiskSpace(Number(file.size || 0))) {
        removeUploadedFiles([file], avatarUploadRootDir);
        return res
          .status(400)
          .json({ error: "Not enough free storage space on server." });
      }

      try {
        if (typeof storeAvatarFile === "function") {
          const stored = await storeAvatarFile(file);
          avatarUrl = stored.avatarUrl;
        } else {
          avatarUrl = `/api/uploads/avatars/${file.filename}`;
          storageEncryption?.encryptFileInPlace?.(file.path);
        }
      } catch {
        removeUploadedFiles([file], avatarUploadRootDir);
        return res
          .status(500)
          .json({ error: "Unable to store avatar securely." });
      }
    }

    if (String(user.avatar_url || "").trim() && user.avatar_url !== avatarUrl) {
      removeAvatarByUrl(user.avatar_url);
    }

    await updateUserProfile(
      user.id,
      user.username,
      user.nickname || null,
      avatarUrl,
    );

    const fileName = path.basename(avatarUrl);
    if (fileName && typeof removePendingPresignedUploads === "function") {
      removePendingPresignedUploads([
        `uploads/avatars/${fileName}`,
        // Legacy key from before uploads/avatars unification.
        `avatars/${fileName}`,
      ]);
    }

    const rawUpdated = findUserById(user.id);
    const updated = rawUpdated && typeof rawUpdated.then === "function" ? await rawUpdated : rawUpdated;
    await emitProfileUpdate(updated, {
      previousUsername: user.username,
    });
    if (typeof broadcastPresence === "function") {
      await broadcastPresence(String(updated.username || "").toLowerCase());
    }

    return res.json({
      avatarUrl: ensureAvatarExists(updated.id, updated.avatar_url) || avatarUrl,
      sizeBytes: Number(file?.size || 0),
      maxFileSizeBytes: AVATAR_FILE_LIMITS?.maxFileSizeBytes || 10 * 1024 * 1024,
    });
  });

  app.put("/api/password", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { username, currentPassword, newPassword } = req.body || {};
    if (!username || !currentPassword || !newPassword) {
      return res.status(400).json({
        error: "Username, current password, and new password are required.",
      });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });
    }

    if (!requireSessionUsernameMatch(res, session, username)) return;

    // Wrong passwords here count like wrong passwords at sign-in: a stolen
    // session cookie must not become a way to guess the password.
    const who = { ip: req.ip, account: String(username).toLowerCase() };
    if (!guard.check(who).allowed) return sendTooManyAttempts(res, guard);

    const rawUser = findUserByUsername(username.toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (
      !user ||
      !user.password_hash ||
      typeof currentPassword !== "string" ||
      !(await bcrypt.compare(currentPassword, user.password_hash))
    ) {
      guard.recordFailure(who);
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const blocked = await twoFactor.requireSecondFactor(user, req.body || {});
    if (blocked) return res.status(blocked.status).json(blocked.body);
    guard.recordSuccess(who);

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await updateUserPassword(user.id, passwordHash);

    // Whoever else was signed in with the old password is signed out; this
    // device stays.
    const signedOut = await signOutOtherSessions(
      user.id,
      session.session_public_id,
      "password_changed",
    );

    res.json({ ok: true, otherSessionsSignedOut: signedOut });
  });

  app.put("/api/status", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { username, status } = req.body || {};
    if (!username || !status) {
      return res.status(400).json({ error: "Username and status are required." });
    }

    const allowed = new Set(["online", "invisible"]);
    if (!allowed.has(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }

    if (!requireSessionUsernameMatch(res, session, username)) return;

    const rawUser = findUserByUsername(username.toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    await updateUserStatus(user.id, status);
    await broadcastPresence(String(user.username || "").toLowerCase());

    res.json({ ok: true, status });
  });

  app.post("/api/profile/delete", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }
    if (!requireSessionUsernameMatch(res, session, username)) return;

    const who = { ip: req.ip, account: String(username).toLowerCase() };
    if (!guard.check(who).allowed) return sendTooManyAttempts(res, guard);

    const rawUser = findUserByUsername(String(username || "").toLowerCase());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (!user || !user.password_hash || !(await bcrypt.compare(String(password || ""), user.password_hash))) {
      guard.recordFailure(who);
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const blocked = await twoFactor.requireSecondFactor(user, req.body || {});
    if (blocked) return res.status(blocked.status).json(blocked.body);
    guard.recordSuccess(who);

    if (user.avatar_url) {
      removeAvatarByUrl(user.avatar_url);
    }

    const rawChats = listChatsForUser(user.id);
    const memberChats = Array.isArray(rawChats) ? rawChats : (await rawChats) || [];
    for (const chat of memberChats) {
      const chatId = chat?.id;
      if (!chatId) continue;
      const label = user.nickname || user.username;
      if (String(chat?.type || "").toLowerCase() === "group") {
        await createMessage(
          chatId,
          user.id,
          `[[system:left:${label}]]`,
          null,
          null,
          null,
          { allowPlaintextSystemMessage: true },
        );
        emitChatEvent(chatId, {
          type: "chat_message",
          chatId,
          username: user.username,
          body: `[[system:left:${label}]]`,
        });
      }
      const rawMembers = listChatMembers(chatId);
      const members = Array.isArray(rawMembers) ? rawMembers : (await rawMembers) || [];
      members.forEach((member) => {
        const memberUsername = String(member?.username || "").toLowerCase();
        if (!memberUsername || memberUsername === String(user.username || "").toLowerCase())
          return;
        try {
          emitSseEvent(memberUsername, { type: "chat_list_changed", chatId });
        } catch {
          // ignore realtime list errors
        }
      });
    }

    const rawDel = deleteUserById(user.id);
    const { storedNames, savedGifs } = (rawDel && typeof rawDel.then === "function" ? await rawDel : rawDel) || {};
    if (Array.isArray(storedNames) && storedNames.length) {
      removeStoredFileNames(storedNames);
    }
    // Their private GIF collection goes with them, files included.
    await removeSavedGifFilesQuietly(deps.savedGifStorage, savedGifs);

    // The account is gone: every other device of this person lands on the login page.
    try {
      deps.closeSessionStreams?.({
        username: user.username,
        payload: { type: "session_revoked", reason: "account_deleted" },
      });
    } catch {
      // nothing left to protect: the sessions were deleted with the account
    }

    clearSessionCookie(req, res);
    return res.json({ ok: true });
  });
}

export { registerProfileRoutes };

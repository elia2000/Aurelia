import { readAppMeta } from "../lib/appMeta.js";
import { parseThemeDefault, parseThemePalette } from "../lib/themePalette.js";
import { clampReactionsPerUser } from "../lib/reactions.js";
import { clampMaxPinnedMessages } from "../lib/pins.js";
import { clampMaxPinnedChats } from "../lib/chatPins.js";

function registerAppRoutes(app, deps) {
  const { REMOTE_CHANNELS, getSetting, fs, path, projectRootDir, callsConfig } = deps;

  // The id the client build stamped into itself (client/dist/build-id.txt). A
  // page that was loaded before the latest build compares it with its own and
  // offers to reload, so an old open tab is never mistaken for the new code.
  const readBuildId = () => {
    try {
      const file = path.join(projectRootDir, "client", "dist", "build-id.txt");
      if (!fs.existsSync(file)) return "";
      return String(fs.readFileSync(file, "utf8") || "").trim().slice(0, 80);
    } catch (_) {
      return "";
    }
  };

  app.get("/api/app/build", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ buildId: readBuildId() });
  });

  app.get("/api/app/info", (_req, res) => {
    const appMeta = readAppMeta({ fs, path, projectRootDir });
    res.json({
      buildId: readBuildId(),
      // The colours "Random" draws from (the admin sets them as hex codes).
      themePalette: parseThemePalette(getSetting("THEME_PALETTE")),
      // What people get until they choose: "random", "default" or one "#rrggbb".
      themeDefault: parseThemeDefault(getSetting("THEME_DEFAULT")),
      version: appMeta.version,
      normalizedVersion: appMeta.normalizedVersion,
      changelog: appMeta.changelog,
      changelogSections: appMeta.changelogSections,
      currentChangelog: appMeta.currentChangelog,
      repository: appMeta.repository,
      // Live runtime config the client needs before it can render auth/chat
      // UI correctly. Read via getSetting() on every request so admin-panel
      // changes take effect immediately, without a client rebuild or reload
      // being required beyond a normal page fetch.
      accountCreationEnabled: Boolean(getSetting("SIGN_UP")),
      adminPanelEnabled: !["0", "false", "no", "n", "off"].includes(
        String(process.env.ADMIN_PANEL ?? "true").trim().toLowerCase(),
      ),
      messageMaxChars: Number(getSetting("MESSAGE_MAX_CHARS")) || 4000,
      usernameMaxChars: Number(getSetting("USERNAME_MAX_CHARS")) || 16,
      nicknameMaxChars: Number(getSetting("NICKNAME_MAX_CHARS")) || 24,
      // How many different reactions one person can leave on a message.
      maxReactionsPerUser: clampReactionsPerUser(getSetting("MAX_REACTIONS_PER_USER")),
      // How many messages one chat can have pinned.
      maxPinnedMessages: clampMaxPinnedMessages(getSetting("MAX_PINNED_MESSAGES")),
      // How many chats one person can pin to the top of their chat list.
      maxPinnedChats: clampMaxPinnedChats(getSetting("MAX_PINNED_CHATS")),
      fileUploadEnabled: Boolean(getSetting("FILE_UPLOAD")),
      // Voice/video calls are switched with CALLS_ENABLED; the client hides the
      // call buttons when this is false.
      callsEnabled: (typeof callsConfig === "function" ? callsConfig() : callsConfig)?.enabled !== false,
      fileUploadMaxFiles: Number(getSetting("FILE_UPLOAD_MAX_FILES")) || 10,
      fileUploadMaxSizeMb: Number(getSetting("FILE_UPLOAD_MAX_SIZE_MB")) || 25,
      fileUploadMaxTotalSizeMb: Number(getSetting("FILE_UPLOAD_MAX_TOTAL_SIZE_MB")) || 75,
      chatMessageFetchLimit: Number(getSetting("CHAT_MESSAGE_FETCH_LIMIT")) || 60,
      chatMessagePageSize: Number(getSetting("CHAT_MESSAGE_PAGE_SIZE")) || 60,
      chatCacheTtlHours: Number(getSetting("CHAT_CACHE_TTL")) || 24,
      chatListRefreshIntervalMs: Number(getSetting("CHAT_LIST_REFRESH_INTERVAL")) || 20000,
      chatHealthCheckIntervalMs: Number(getSetting("CHAT_HEALTH_CHECK_INTERVAL")) || 10000,
      chatSseReconnectDelayMs: Number(getSetting("CHAT_SSE_RECONNECT_DELAY")) || 2000,
      chatSearchMaxResults: Number(getSetting("CHAT_SEARCH_MAX_RESULTS")) || 5,
      chatPendingTextTimeoutMs: Number(getSetting("CHAT_PENDING_TEXT_TIMEOUT")) || 300000,
      chatPendingFileTimeoutMs: Number(getSetting("CHAT_PENDING_FILE_TIMEOUT")) || 1200000,
      chatPendingRetryIntervalMs: Number(getSetting("CHAT_PENDING_RETRY_INTERVAL")) || 4000,
      chatPendingStatusCheckIntervalMs: Number(getSetting("CHAT_PENDING_STATUS_CHECK_INTERVAL")) || 1000,
      remoteChannels: {
        // enabled/telegramConfigured/proxyConfigured stay restart-scoped
        // (Telegram credentials + remoteChannelManager are wired once at
        // startup), but uiEnabled/mediaStreamEnabled are pure display flags
        // read live so toggling them in the admin panel applies immediately.
        enabled: Boolean(REMOTE_CHANNELS?.enabled),
        uiEnabled: Boolean(getSetting("REMOTE_CHANNEL_UI")),
        mediaStreamEnabled: Boolean(getSetting("REMOTE_CHANNEL_MEDIA_STREAM")),
        telegramConfigured: Boolean(REMOTE_CHANNELS?.telegramConfigured),
        songbirdConfigured: Boolean(REMOTE_CHANNELS?.enabled),
        proxyConfigured: Boolean(REMOTE_CHANNELS?.proxyConfigured),
      },
    });
  });
}

export { registerAppRoutes };

import { apiFetch } from "./chatApi.js";
import {
  compareVersions,
  fetchLatestGitHubTag,
  normalizeVersion,
} from "../utils/versioning.js";

export const fetchAppInfo = () => apiFetch("/api/app/info");

/** The id of the client build the server is serving ("" when unknown). */
export const fetchAppBuildId = async () => {
  const response = await apiFetch("/api/app/build");
  if (!response.ok) return "";
  const payload = await response.json().catch(() => null);
  return String(payload?.buildId || "");
};

export const checkAppVersion = async (appInfo = null) => {
  const owner = String(appInfo?.repository?.owner || "").trim();
  const repo = String(appInfo?.repository?.repo || "").trim();
  const currentVersion = normalizeVersion(appInfo?.version || "");
  const latestTag = await fetchLatestGitHubTag({ owner, repo });
  const comparison = compareVersions(latestTag.normalizedTag, currentVersion);

  return {
    currentVersion,
    latestVersion: latestTag.normalizedTag,
    latestTag: latestTag.rawTag,
    status: comparison > 0 ? "update-available" : "up-to-date",
    repository: appInfo?.repository || null,
  };
};

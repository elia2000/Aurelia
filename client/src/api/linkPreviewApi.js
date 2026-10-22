import { apiFetch } from "./chatApi.js";

// Link previews are made by the server: it fetches the linked page (and its
// picture) itself, so this browser never contacts the linked site. The address
// goes in the body of a POST, not in the query string, so it stays out of
// server and proxy logs.

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

/** POST /api/link-preview -> { ok, status, data } (data is always an object). */
export async function fetchLinkPreview(url) {
  const response = await apiFetch("/api/link-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = await readJson(response);
  return { ok: response.ok, status: response.status, data: data && typeof data === "object" ? data : {} };
}

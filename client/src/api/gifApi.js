import { apiFetch } from "./chatApi.js";

// The person's own saved GIFs. Every route is scoped to the signed-in person by
// the server; nothing here takes a user id.

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

// { ok, status, data }: the JSON body is always an object, also for an error.
const call = async (url, options) => {
  const response = await apiFetch(url, options);
  const data = await readJson(response);
  return { ok: response.ok, status: response.status, data: data && typeof data === "object" ? data : {} };
};

/** GET /api/gifs -> { gifs, limit, count }, newest first. */
export const listSavedGifs = () => call("/api/gifs");

/** POST /api/gifs: keep a GIF of a message the person can see. */
export const saveGifFromMessage = ({ messageId, fileId = null, fileIndex = null }) =>
  call("/api/gifs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messageId,
      ...(fileId !== null && fileId !== undefined ? { fileId } : {}),
      ...((fileId === null || fileId === undefined) && fileIndex !== null && fileIndex !== undefined
        ? { fileIndex }
        : {}),
    }),
  });

/** POST /api/gifs/upload: add a GIF from the device (multipart, field "file"). */
export const uploadSavedGif = (file) => {
  const form = new FormData();
  form.append("file", file);
  return call("/api/gifs/upload", { method: "POST", body: form });
};

/** DELETE /api/gifs/:id */
export const deleteSavedGif = (id) =>
  call(`/api/gifs/${encodeURIComponent(id)}`, { method: "DELETE" });

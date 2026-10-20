/**
 * Removes the stored files of saved GIFs after their rows are gone (account
 * deletion, resets). The rows are already deleted by then, so a failure here
 * must never fail the request: it is logged and the request goes on.
 */
export async function removeSavedGifFilesQuietly(storage, rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length || typeof storage?.removeGifs !== "function") return { removed: 0, failed: 0 };
  try {
    return await storage.removeGifs(list);
  } catch (error) {
    console.error("saved gifs: unable to remove stored files:", error?.message || error);
    return { removed: 0, failed: list.length };
  }
}

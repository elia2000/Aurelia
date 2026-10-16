// An avatar can be set by naming a file that was uploaded straight to object
// storage. That is only allowed for a file this very person was just given an
// upload address for: otherwise anyone could point their avatar at somebody
// else's file (showing it as their own) and, by changing it later, delete it.

/**
 * @param {object} options
 * @param {Function} options.listPendingPresignedUploads  returns the open upload slots
 * @param {string}   options.userId    the person setting the avatar
 * @param {string}   options.fileName  base name of the avatar file
 */
export async function ownsPendingAvatarUpload({ listPendingPresignedUploads, userId, fileName }) {
  if (typeof listPendingPresignedUploads !== "function" || !userId || !fileName) return false;
  const wanted = new Set([`uploads/avatars/${fileName}`, `avatars/${fileName}`]);
  const raw = listPendingPresignedUploads();
  const rows = (raw && typeof raw.then === "function" ? await raw : raw) || [];
  return rows.some((row) => {
    const key = String(row?.storage_key ?? row?.storageKey ?? "");
    if (!wanted.has(key)) return false;
    const owner = row?.user_id ?? row?.userId ?? null;
    // Slots opened before the owner was recorded carry none; they are still ours to use.
    return !owner || owner === userId;
  });
}

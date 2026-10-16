// Storage keys reach the database from outside the web server (the media
// worker reports them back) and are later turned into file paths and object
// keys. A key that is absolute or climbs out of its folder must never be used.

export function isSafeStorageKey(value) {
  if (typeof value !== "string" || !value || value.length > 1024) return false;
  if (/[\0\\]/.test(value) || value.startsWith("/")) return false;
  return !value.split("/").some((segment) => segment === "..");
}

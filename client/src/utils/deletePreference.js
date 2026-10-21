// "Delete for everyone" is remembered between deletes, for one message and
// for several alike. Storage can be missing or blocked (private windows), so
// every access is guarded.
const DELETE_FOR_EVERYONE_KEY = "songbird-delete-message-for-everyone";

export function readDeleteForEveryonePreference() {
  try {
    return window.localStorage.getItem(DELETE_FOR_EVERYONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDeleteForEveryonePreference(value) {
  try {
    window.localStorage.setItem(DELETE_FOR_EVERYONE_KEY, value ? "1" : "0");
  } catch {
    // The choice just is not remembered.
  }
}

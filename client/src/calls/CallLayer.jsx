import { useEffect } from "react";
import CallOverlay from "../components/calls/CallOverlay.jsx";
import { CallProvider } from "./CallProvider.jsx";
import { clearE2eeSession } from "../e2ee/services.js";
import { useDeviceRegistration } from "../e2ee/useDeviceRegistration.js";
import { clearVideoNoteCaches } from "../videoNote/receive.js";

/**
 * Everything call-related behind one lazy boundary, so the crypto/WebRTC code
 * is only downloaded for signed-in users and loads in parallel with the chat.
 */
export default function CallLayer({ user, children }) {
  const userId = user?.id || null;
  useDeviceRegistration(userId);

  // Decrypted videos, previews and cached keys belong to the signed-in person
  // only: drop them on sign-out or when another account takes over this tab.
  useEffect(
    () => () => {
      clearE2eeSession();
      clearVideoNoteCaches();
    },
    [userId],
  );

  return (
    <CallProvider user={user}>
      {children}
      <CallOverlay user={user} />
    </CallProvider>
  );
}

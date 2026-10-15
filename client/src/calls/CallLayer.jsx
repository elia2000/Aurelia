import CallOverlay from "../components/calls/CallOverlay.jsx";
import { CallProvider } from "./CallProvider.jsx";

/**
 * Everything call-related behind one lazy boundary, so the crypto/WebRTC code
 * is only downloaded for signed-in users and loads in parallel with the chat.
 */
export default function CallLayer({ user, children }) {
  return (
    <CallProvider user={user}>
      {children}
      <CallOverlay user={user} />
    </CallProvider>
  );
}

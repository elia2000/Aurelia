import { useEffect } from "react";
import { getE2eeServices } from "./services.js";
import { isE2eeSupported } from "./support.js";

/**
 * Registers this device's public keys as soon as the app is idle, so other
 * people can already send us encrypted video messages before we have ever made
 * or answered a call. It does not depend on calls being available: someone on
 * a server with calling switched off, or in a browser that cannot place calls,
 * must still be able to receive encrypted video messages.
 */
export function useDeviceRegistration(userId) {
  useEffect(() => {
    if (!userId || !isE2eeSupported()) return undefined;
    const register = () => {
      getE2eeServices()
        .getIdentity(userId)
        .catch(() => {});
    };
    const hasIdle = typeof requestIdleCallback === "function";
    const handle = hasIdle ? requestIdleCallback(register, { timeout: 4000 }) : setTimeout(register, 1500);
    return () => {
      if (hasIdle && typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
      else clearTimeout(handle);
    };
  }, [userId]);
}

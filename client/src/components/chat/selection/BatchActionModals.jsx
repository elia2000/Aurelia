import { Suspense, lazy, useEffect } from "react";

// The same module ChatPage loads for forwarding a single message.
const ForwardMessageModal = lazy(() => import("../../modals/ForwardMessageModal.jsx"));
const DeleteMessagesModal = lazy(() => import("./DeleteMessagesModal.jsx"));

/**
 * The two questions of selection mode: where to forward the ticked messages
 * (the chat chooser the single "Forward" uses) and whether to delete them.
 * Each is shown while its props (from useBatchMessageActions) are set.
 */
export default function BatchActionModals({ forward = null, remove = null }) {
  // The chooser has no key handling of its own: Escape closes it, and not
  // also the chat behind it. (Not while the messages are being sent.)
  const forwardOpen = Boolean(forward);
  const forwardBusy = Boolean(forward?.busy);
  const closeForward = forward?.onClose;
  useEffect(() => {
    if (!forwardOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!forwardBusy) closeForward?.();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [forwardOpen, forwardBusy, closeForward]);

  if (!forward && !remove) return null;
  return (
    <Suspense fallback={null}>
      {forward ? (
        <ForwardMessageModal
          open
          chats={forward.chats}
          savedChat={forward.savedChat}
          currentUser={forward.currentUser}
          sourceChatId={forward.sourceChatId}
          onClose={forward.onClose}
          onSubmit={forward.onSubmit}
        />
      ) : null}
      {remove ? (
        <DeleteMessagesModal
          total={remove.total}
          everyoneCount={remove.everyoneCount}
          offline={remove.offline}
          onClose={remove.onClose}
          onConfirm={remove.onConfirm}
        />
      ) : null}
    </Suspense>
  );
}

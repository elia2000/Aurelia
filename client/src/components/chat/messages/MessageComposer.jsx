import { Suspense, lazy, useEffect, useRef, useState, useCallback } from "react";
import { Smile } from "../../../icons/lucide.js";
import { useRecordingSession } from "../../../hooks/chat/useRecordingSession.js";
import { hasPersian } from "../../../utils/fontUtils.js";
// Loaded when the emoji button is first used (the emoji list is large).
const EmojiPicker = lazy(() => import("../emoji/EmojiPicker.jsx"));
// The round camera is loaded the first time video messages are used.
const loadVideoNoteRecorder = () => import("../videoNote/VideoNoteRecorder.jsx");
const VideoNoteRecorder = lazy(loadVideoNoteRecorder);
import AttachButton from "./composer/AttachButton.jsx";
import {
  EditBar,
  PendingUploads,
  PendingVoiceBar,
  ReplyBar,
  UploadProgressBar,
} from "./composer/ComposerBars.jsx";
import { isGeneratedFileSummary, normalizeComposerBody } from "./composer/composerText.js";
import { createFocusKeeper } from "./composer/focusKeeper.js";
import PrimaryButton from "./composer/PrimaryButton.jsx";
import { PreviewBar, RecordingBar } from "./composer/RecordingBar.jsx";

// One text line is 22 px; the field is 40 px tall with one line and grows to
// six lines before it scrolls.
const MIN_TEXTAREA_HEIGHT = 38;
const MAX_TEXTAREA_HEIGHT = 148;

function applyTextareaSize({
  textareaEl,
  composerEl,
  onComposerResize,
  onComposerHeightChange,
}) {
  if (!textareaEl) return;
  textareaEl.style.height = "0px";
  const nextHeight = Math.min(textareaEl.scrollHeight, MAX_TEXTAREA_HEIGHT);
  textareaEl.style.height = `${Math.max(MIN_TEXTAREA_HEIGHT, nextHeight)}px`;
  textareaEl.style.overflowY =
    textareaEl.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  onComposerResize?.();
  if (composerEl) {
    onComposerHeightChange?.(Number(composerEl.offsetHeight || 0));
  }
}

export function MessageComposer({
  activeChatId,
  isDesktop,
  handleSend,
  onComposerResize,
  replyTarget,
  onClearReply,
  editTarget,
  onClearEdit,
  pendingUploadFiles,
  pendingUploadType,
  pendingVoiceMessage,
  fileUploadEnabled,
  mediaInputRef,
  documentInputRef,
  onClearPendingUploads,
  onRemovePendingUpload,
  onUploadFilesSelected,
  onVoiceRecorded,
  onClearPendingVoiceMessage,
  uploadError,
  activeUploadProgress,
  messageMaxChars = null,
  onMessageInput,
  uploadBusy,
  showUploadMenu,
  setShowUploadMenu,
  uploadMenuRef,
  handleVideoThumbLoadedMetadata,
  onComposerHeightChange,
  onComposerFocusChange,
  composerInputRef,
  microphonePermissionStatus = "unknown",
  onRequestMicrophonePermission,
  onSendVideoNote = null,
  selfUser = null,
}) {
  const composerRef = useRef(null);
  const fallbackInputRef = useRef(null);
  const messageInputRef = composerInputRef || fallbackInputRef;
  const [focusKeeper] = useState(createFocusKeeper);
  const setMessageInput = useCallback(
    (node) => {
      messageInputRef.current = node;
      focusKeeper.setInput(node);
    },
    [messageInputRef, focusKeeper],
  );
  const previousEditIdRef = useRef(0);
  const appliedEditIdRef = useRef(0);
  const voiceHandoffSubmittedRef = useRef(false);
  const [messageValue, setMessageValue] = useState("");
  const [voiceHandoff, setVoiceHandoff] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const emojiRef = useRef(null);

  useEffect(() => {
    if (!showEmoji) return undefined;
    const onPointerDown = (event) => {
      if (emojiRef.current && !emojiRef.current.contains(event.target)) setShowEmoji(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showEmoji]);

  const openFilePicker = useCallback((inputRef) => {
    const input = inputRef?.current;
    if (!input || input.disabled) return;
    try {
      if (typeof input.showPicker === "function") {
        input.showPicker();
      } else {
        input.click();
      }
    } catch {
      try {
        input.click();
      } catch {
        // ignore
      }
    }
  }, []);

  const editBodyText = normalizeComposerBody(editTarget?.body);
  const composerHasPersian = hasPersian(messageValue);
  const editHasFiles = Array.isArray(editTarget?.files) && editTarget.files.length > 0;
  const editBodyLooksLikeFileSummary = isGeneratedFileSummary(editBodyText);

  // Any character at all, even a space, swaps the record button for Send and
  // hides the paperclip; a message of only spaces still cannot be submitted.
  const hasAnyText = messageValue.length > 0;
  const hasText = Boolean(String(messageValue || "").trim());
  const hasPendingUploads = Boolean(pendingUploadFiles?.length);
  const hasPendingVoice = Boolean(pendingVoiceMessage);
  const showPendingVoiceBar = hasPendingVoice && !voiceHandoff;
  const isEditMode = Boolean(editTarget);
  const showSend = hasAnyText || hasPendingUploads || hasPendingVoice || isEditMode;
  const recordDisabled = Boolean(uploadBusy) || !fileUploadEnabled || isEditMode;
  const canSubmitMessage = isEditMode
    ? hasText
    : hasText || hasPendingUploads || hasPendingVoice;

  // A voice message that is released (or sent from the lock / preview) goes to
  // the page as its pending voice message and the form is submitted straight
  // away. The pending bar stays hidden meanwhile so the composer does not jump.
  const handleVoiceReady = (payload) => {
    voiceHandoffSubmittedRef.current = false;
    setVoiceHandoff(true);
    onVoiceRecorded?.(payload);
  };

  const session = useRecordingSession({
    chatId: activeChatId,
    recordDisabled,
    microphonePermissionStatus,
    onRequestMicrophonePermission,
    onVoiceReady: handleVoiceReady,
    onSendVideoNote,
    onBeforeRecord: () => {
      setShowUploadMenu?.(false);
      setShowEmoji(false);
    },
  });
  const recordingActive = session.phase !== "idle";
  const attachVisible = !hasAnyText && !recordingActive;

  useEffect(() => {
    if (!voiceHandoff) return undefined;
    if (pendingVoiceMessage && !voiceHandoffSubmittedRef.current) {
      voiceHandoffSubmittedRef.current = true;
      composerRef.current?.requestSubmit();
    } else if (!pendingVoiceMessage && voiceHandoffSubmittedRef.current) {
      setVoiceHandoff(false); // it was sent
    }
    // Whatever happened (the page refused it, the send failed), the bar is back
    // after a moment so the message can still be seen and removed.
    const timer = setTimeout(() => setVoiceHandoff(false), 2000);
    return () => clearTimeout(timer);
  }, [voiceHandoff, pendingVoiceMessage]);

  // Warm the round-camera chunk so the first hold shows it without a gap.
  useEffect(() => {
    if (session.mode === "video") void loadVideoNoteRecorder();
  }, [session.mode]);

  // The popup menu belongs to a paperclip that is no longer there.
  useEffect(() => {
    if (!attachVisible && showUploadMenu) setShowUploadMenu?.(false);
  }, [attachVisible, showUploadMenu, setShowUploadMenu]);

  // First in line (capture on window), like the emoji picker: Escape closes the
  // attach menu and nothing else, in particular not the open chat.
  useEffect(() => {
    if (!showUploadMenu) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      setShowUploadMenu?.(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showUploadMenu, setShowUploadMenu]);

  const resize = useCallback(
    (textareaEl = messageInputRef.current) =>
      applyTextareaSize({
        textareaEl,
        composerEl: composerRef.current,
        onComposerResize,
        onComposerHeightChange,
      }),
    [messageInputRef, onComposerHeightChange, onComposerResize],
  );

  useEffect(() => {
    resize();
  }, [resize]);

  // Anything that adds or removes a strip above the input changes the height.
  const pendingCount = pendingUploadFiles?.length || 0;
  const hasUploadError = Boolean(uploadError);
  const isUploading = activeUploadProgress !== null;
  useEffect(() => {
    resize();
  }, [
    resize,
    editTarget,
    replyTarget,
    pendingCount,
    showPendingVoiceBar,
    hasUploadError,
    isUploading,
    recordingActive,
  ]);

  useEffect(() => {
    const nextEditId = String(editTarget?.id || "").trim();
    if (!nextEditId) return;
    if (appliedEditIdRef.current === nextEditId) return;
    const nextValue =
      editHasFiles && editBodyLooksLikeFileSummary ? "" : String(editBodyText || "");
    const frameId = requestAnimationFrame(() => {
      appliedEditIdRef.current = nextEditId;
      previousEditIdRef.current = nextEditId;
      setMessageValue(nextValue);
      if (typeof onMessageInput === "function") {
        onMessageInput(nextValue);
      }
      resize();
      focusKeeper.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    editBodyLooksLikeFileSummary,
    editBodyText,
    editHasFiles,
    editTarget?.id,
    focusKeeper,
    onMessageInput,
    resize,
  ]);

  useEffect(() => {
    if (editTarget) return;
    if (!previousEditIdRef.current) return;
    const frameId = requestAnimationFrame(() => {
      previousEditIdRef.current = 0;
      appliedEditIdRef.current = 0;
      setMessageValue("");
      if (typeof onMessageInput === "function") {
        onMessageInput("");
      }
      resize();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [editTarget, onMessageInput, resize]);

  // Gives a control the composer's focus rules: a press must not take the
  // cursor (and on phones the keyboard) out of the message, and when the action
  // is done the cursor goes back.
  const guard = (action) => ({
    onPointerDown: (event) => {
      focusKeeper.capture();
      if (!isDesktop) event.preventDefault();
    },
    onClick: (event) => {
      action?.(event);
      focusKeeper.restore();
    },
  });

  // The textarea is not mounted while recording; hand the cursor back after.
  useEffect(() => {
    if (!recordingActive) focusKeeper.restore();
  }, [recordingActive, focusKeeper]);

  useEffect(() => {
    const handleWindowFocus = () => focusKeeper.restore();
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [focusKeeper]);

  useEffect(() => {
    if (isDesktop || typeof window === "undefined") return undefined;
    const node = composerRef.current;
    if (!node) return undefined;

    // The composer must not drag the page behind it, but a long message and a
    // row of files scroll by themselves (they are marked data-touch-scroll).
    const blockComposerViewportScroll = (event) => {
      event.stopPropagation();
      if (event.target?.closest?.("[data-touch-scroll]")) return;
      event.preventDefault?.();
    };

    const handleTouchStart = (event) => {
      event.stopPropagation();
    };

    node.addEventListener("touchstart", handleTouchStart, { capture: true });
    node.addEventListener("touchmove", blockComposerViewportScroll, {
      capture: true,
      passive: false,
    });
    node.addEventListener("wheel", blockComposerViewportScroll, {
      capture: true,
      passive: false,
    });
    node.addEventListener("gesturestart", blockComposerViewportScroll, {
      capture: true,
      passive: false,
    });
    return () => {
      node.removeEventListener("touchstart", handleTouchStart, { capture: true });
      node.removeEventListener("touchmove", blockComposerViewportScroll, {
        capture: true,
      });
      node.removeEventListener("wheel", blockComposerViewportScroll, {
        capture: true,
      });
      node.removeEventListener("gesturestart", blockComposerViewportScroll, {
        capture: true,
      });
    };
  }, [isDesktop]);

  if (!activeChatId) return null;

  // Puts an emoji into the message where the cursor is. The picker stays open
  // so that several can be added in a row.
  const insertEmoji = (emoji) => {
    const el = messageInputRef.current;
    const start = el?.selectionStart ?? messageValue.length;
    const end = el?.selectionEnd ?? start;
    const next = messageValue.slice(0, start) + emoji + messageValue.slice(end);
    const limit = Number(messageMaxChars);
    if (messageMaxChars != null && Number.isFinite(limit) && limit > 0 && next.length > limit) return;
    setMessageValue(next);
    if (typeof onMessageInput === "function") onMessageInput(next);
    requestAnimationFrame(() => {
      const input = messageInputRef.current;
      if (!input) return;
      resize(input);
      focusKeeper.focus();
      const position = start + emoji.length;
      try {
        input.setSelectionRange(position, position);
      } catch (_) {
        // (an input that cannot hold a selection)
      }
    });
  };

  const holding = session.phase === "recording" && !session.locked;
  const sendingVideo = session.phase === "sending";
  const variant = sendingVideo
    ? "sending"
    : recordingActive
      ? holding
        ? "record"
        : "sendRecording"
      : showSend
        ? isEditMode
          ? "save"
          : "send"
        : "record";
  const recordLabel =
    session.mode === "video"
      ? "Record video message. Tap to switch to voice message"
      : session.videoAvailable
        ? "Record voice message. Tap to switch to video message"
        : "Record voice message";
  const ariaLabel =
    variant === "sending"
      ? "Sending video message"
      : variant === "sendRecording"
        ? `Send ${session.kind === "video" ? "video" : "voice"} message`
        : variant === "record"
          ? holding
            ? `Recording ${session.kind} message. Release to send, slide left to cancel, slide up to lock`
            : recordLabel
          : variant === "save"
            ? "Save edit"
            : "Send message";
  const primaryDisabled =
    variant === "sending"
      ? true
      : variant === "record" && !holding
        ? recordDisabled
        : variant === "send" || variant === "save"
          ? !canSubmitMessage
          : false;

  const recordProps = {
    ...session.recordButtonProps,
    onPointerDown: (event) => {
      focusKeeper.capture();
      if (!isDesktop) event.preventDefault();
      session.recordButtonProps.onPointerDown(event);
    },
    onMouseDown: (event) => {
      if (!isDesktop) event.preventDefault();
    },
  };

  const voicePreview = session.voicePreview;
  const clipMs = session.videoClip?.durationMs || 0;

  return (
    <form
      ref={composerRef}
      className="sticky bottom-0 z-30 flex shrink-0 flex-col gap-1.5 border-t border-slate-300/80 bg-white px-2 pt-[3px] dark:border-emerald-500/20 dark:bg-slate-900 sm:px-3 md:relative md:mt-auto"
      style={{
        paddingBottom: isDesktop ? "3px" : "max(3px, env(safe-area-inset-bottom))",
        overscrollBehaviorY: isDesktop ? undefined : "none",
        touchAction: isDesktop ? undefined : "none",
      }}
      onSubmit={(event) => {
        if (!canSubmitMessage) {
          event.preventDefault();
          return;
        }
        handleSend(event);
        requestAnimationFrame(() => {
          if (!editTarget) {
            setMessageValue("");
          }
          resize();
          if (!isDesktop) {
            focusKeeper.focus();
          }
        });
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing)
          return;
        if (!pendingUploadFiles?.length) return;
        if (!isDesktop) return;
        const activeEl = document.activeElement;
        if (activeEl === messageInputRef.current) return;
        // The record button treats Enter as its own press (tap / hold).
        if (activeEl?.closest?.("[data-record-mode]")) return;
        event.preventDefault();
        event.currentTarget?.requestSubmit?.();
      }}
    >
      {session.kind === "video" && recordingActive ? (
        <Suspense fallback={null}>
          <VideoNoteRecorder
            session={session}
            isDesktop={isDesktop}
            chatId={activeChatId}
            selfUser={selfUser}
          />
        </Suspense>
      ) : null}
      {/* "Hold to record..." makes no sense once typing has swapped the record button for Send. */}
      {session.hint && (session.hint.tone === "error" || (variant !== "send" && variant !== "save")) ? (
        <p
          key={session.hint.id}
          role={session.hint.tone === "error" ? "alert" : "status"}
          className={`aurelle-hint-in pointer-events-none absolute bottom-full right-2 z-40 mb-2 max-w-[min(22rem,calc(100%-1rem))] rounded-xl px-3 py-1.5 text-xs font-medium text-white shadow-lg ${
            session.hint.tone === "error" ? "bg-rose-600" : "bg-slate-900/90 dark:bg-slate-700"
          }`}
        >
          {session.hint.text}
        </p>
      ) : null}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {session.announcement.text}
      </div>

      {editTarget ? (
        <EditBar editTarget={editTarget} onCancel={onClearEdit} guard={guard} />
      ) : replyTarget ? (
        <ReplyBar replyTarget={replyTarget} onCancel={onClearReply} guard={guard} />
      ) : null}
      {showPendingVoiceBar ? (
        <PendingVoiceBar
          pendingVoiceMessage={pendingVoiceMessage}
          onCancel={onClearPendingVoiceMessage}
          guard={guard}
        />
      ) : null}
      {pendingUploadFiles?.length ? (
        <PendingUploads
          files={pendingUploadFiles}
          type={pendingUploadType}
          fileUploadEnabled={fileUploadEnabled}
          onAdd={() => openFilePicker(pendingUploadType === "media" ? mediaInputRef : documentInputRef)}
          onClear={onClearPendingUploads}
          onRemove={onRemovePendingUpload}
          onThumbLoaded={handleVideoThumbLoadedMetadata}
          guard={guard}
        />
      ) : null}
      {uploadError ? (
        <p className="text-xs text-rose-600 dark:text-rose-300">{uploadError}</p>
      ) : null}
      {activeUploadProgress !== null ? <UploadProgressBar percent={activeUploadProgress} /> : null}

      <div className="flex flex-row items-end gap-1.5">
        {recordingActive ? (
          session.phase === "recording" ? (
            <RecordingBar
              kind={session.kind}
              locked={session.locked}
              voice={session.voice}
              elapsedMs={session.video.elapsedMs}
              progress={session.progress}
              onDelete={session.actions.discard}
              onStop={session.actions.stop}
            />
          ) : (
            <PreviewBar
              kind={session.kind}
              voicePreview={voicePreview}
              durationMs={clipMs}
              busy={sendingVideo}
              onDelete={session.actions.discard}
            />
          )
        ) : (
          <div className="flex min-h-10 min-w-0 flex-1 items-end gap-0.5 rounded-[20px] border border-emerald-200 bg-white px-1 transition focus-within:border-emerald-400 focus-within:ring-2 focus-within:ring-emerald-300/60 dark:border-emerald-500/30 dark:bg-slate-900">
            <div className="relative mb-px flex shrink-0" ref={emojiRef}>
              <button
                type="button"
                {...guard(() => setShowEmoji((open) => !open))}
                aria-label="Emoji"
                aria-expanded={showEmoji}
                title="Emoji"
                className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-emerald-700 transition after:absolute after:-inset-0.5 after:content-[''] hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-500/10"
              >
                <Smile size={20} className="icon-anim-sway" />
              </button>
              {showEmoji ? (
                <div
                  className="absolute bottom-full left-0 z-40 mb-2"
                  // Clicking the picker must not take the cursor out of the message.
                  onPointerDown={(event) => {
                    if (event.target.tagName !== "INPUT") event.preventDefault();
                  }}
                >
                  <Suspense fallback={null}>
                    <EmojiPicker
                      onSelect={insertEmoji}
                      onClose={() => {
                        setShowEmoji(false);
                        focusKeeper.restore();
                      }}
                      autoFocusSearch={isDesktop}
                    />
                  </Suspense>
                </div>
              ) : null}
            </div>
            <textarea
              ref={setMessageInput}
              name="message"
              rows={1}
              data-touch-scroll=""
              placeholder="Type a message"
              aria-label={
                editTarget
                  ? "Edit message"
                  : replyTarget
                  ? `Reply to ${replyTarget.displayName || replyTarget.username || "message"}`
                  : "Type a message"
              }
              value={messageValue}
              maxLength={
                Number.isFinite(Number(messageMaxChars))
                  ? messageMaxChars
                  : undefined
              }
              lang={composerHasPersian ? "fa" : "en"}
              dir="auto"
              onInput={(event) => {
                const value = event.currentTarget.value || "";
                setMessageValue(value);
                resize(event.currentTarget);
                if (typeof onMessageInput === "function") {
                  onMessageInput(value);
                }
              }}
              onFocus={() => onComposerFocusChange?.(true)}
              onBlur={() => onComposerFocusChange?.(false)}
              onKeyDown={(event) => {
                if (!isDesktop) return;
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.isComposing
                )
                  return;
                if (!canSubmitMessage) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
              className={`chat-scroll block min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-base leading-[22px] text-slate-700 outline-hidden placeholder:text-slate-400 dark:text-slate-100 ${
                composerHasPersian ? "font-fa" : ""
              }`}
              style={{
                minHeight: `${MIN_TEXTAREA_HEIGHT}px`,
                maxHeight: `${MAX_TEXTAREA_HEIGHT}px`,
                unicodeBidi: "plaintext",
                whiteSpace: "pre-wrap",
                wordBreak: "normal",
                overflowWrap: "break-word",
                overflowX: "hidden",
                textAlign: "start",
              }}
            />
            <AttachButton
              visible={attachVisible}
              disabled={Boolean(uploadBusy)}
              menuOpen={Boolean(showUploadMenu)}
              menuRef={uploadMenuRef}
              guard={guard}
              onToggleMenu={() => {
                if (uploadBusy) return;
                setShowUploadMenu((prev) => !prev);
              }}
              onPickMedia={() => {
                openFilePicker(mediaInputRef);
                setShowUploadMenu(false);
              }}
              onPickDocument={() => {
                openFilePicker(documentInputRef);
                setShowUploadMenu(false);
              }}
            />
          </div>
        )}
        <PrimaryButton
          variant={variant}
          mode={session.mode}
          holding={holding}
          disabled={primaryDisabled}
          ariaLabel={ariaLabel}
          recordProps={recordProps}
          progress={session.progress}
          onClick={variant === "sendRecording" ? session.actions.send : undefined}
          onPointerDown={(event) => {
            focusKeeper.capture();
            if (!isDesktop) event.preventDefault();
          }}
          onMouseDown={(event) => {
            if (!isDesktop) event.preventDefault();
          }}
        />
        <input
          ref={mediaInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          disabled={uploadBusy}
          onChange={(event) => {
            onUploadFilesSelected(
              event.target.files,
              "media",
              pendingUploadType === "media",
            );
            event.target.value = "";
            focusKeeper.restore();
          }}
        />
        <input
          ref={documentInputRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          disabled={uploadBusy}
          onChange={(event) => {
            onUploadFilesSelected(
              event.target.files,
              "document",
              pendingUploadType === "document",
            );
            event.target.value = "";
            focusKeeper.restore();
          }}
        />
      </div>
    </form>
  );
}

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { computeMessageRuns } from "../../../utils/messageRuns.js";
import { OfflineHistoryBanner } from "./MessageList.jsx";

const BOTTOM_STRETCH_MAX_PX = 84;
const BOTTOM_STRETCH_GAIN = 0.2;
const BOTTOM_STRETCH_RELEASE_MS = 320;
const BUILD_UP_OFFSET_PX = 18;
const BUILD_UP_DURATION_MS = 260;
const BUILD_UP_ARM_DELAY_MS = 700;
const TIMELINE_TOP_SPACER_PX = 12;

export function MessageTimeline({
  activeChatId,
  loadingMessages,
  messages,
  groupedMessages,
  loadingOlderMessages,
  hasOlderMessages = false,
  isOffline = false,
  handleGroupChipClick,
  renderMessageItem,
  chatScrollRef,
  handlePanelScroll,
  handleScrollIntent,
  chatScrollStyle,
  timelineBottomSpacerPx,
}) {
  const scrollContainerRef = useRef(null);
  const [bottomStretchPx, setBottomStretchPx] = useState(0);
  const [isReleasingStretch, setIsReleasingStretch] = useState(false);
  const [buildUpOffsetPx, setBuildUpOffsetPx] = useState(0);
  const [animateRowKey, setAnimateRowKey] = useState("");
  const bottomStretchRef = useRef(0);
  const releaseTimerRef = useRef(null);
  const buildUpTimerRef = useRef(null);
  const activationTimerRef = useRef(null);
  const animationReadyRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const previousLastMessageKeyRef = useRef("");
  const latestMessageCountRef = useRef(0);
  const latestLastMessageKeyRef = useRef("");

  const timelineRows = useMemo(() => {
    const rows = [];
    groupedMessages.forEach((group, groupIndex) => {
      const dayKey = group?.dayKey || `group-${groupIndex}`;
      rows.push({
        type: "day",
        key: `day-${dayKey}`,
        dayKey,
        dayLabel: group?.dayLabel || "",
      });
      const dayItems = group?.items || [];
      // Which bubbles start and end a run of one sender (name on the first,
      // avatar on the last, tight spacing inside the run).
      const runs = computeMessageRuns(dayItems);
      dayItems.forEach((msg, messageIndex) => {
        const stableKey =
          msg?._clientId ??
          msg?._serverId ??
          msg?.id ??
          `msg-${groupIndex}-${messageIndex}`;
        rows.push({
          type: "message",
          key: `message-${stableKey}`,
          msg,
          isFirstInGroup: messageIndex === 0,
          isRunStart: runs[messageIndex].isRunStart,
          isRunEnd: runs[messageIndex].isRunEnd,
        });
      });
    });
    return rows;
  }, [groupedMessages]);

  const clearReleaseTimer = useCallback(() => {
    if (!releaseTimerRef.current) return;
    window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
  }, []);

  const releaseBottomStretch = useCallback(() => {
    clearReleaseTimer();
    if (bottomStretchRef.current <= 0) return;
    setIsReleasingStretch(true);
    bottomStretchRef.current = 0;
    setBottomStretchPx(0);
  }, [clearReleaseTimer]);

  const scheduleStretchRelease = useCallback(() => {
    clearReleaseTimer();
    releaseTimerRef.current = window.setTimeout(() => {
      releaseBottomStretch();
    }, 90);
  }, [clearReleaseTimer, releaseBottomStretch]);

  useEffect(
    () => () => {
      clearReleaseTimer();
      if (activationTimerRef.current) {
        window.clearTimeout(activationTimerRef.current);
        activationTimerRef.current = null;
      }
      if (buildUpTimerRef.current) {
        window.clearTimeout(buildUpTimerRef.current);
        buildUpTimerRef.current = null;
      }
    },
    [clearReleaseTimer],
  );

  useEffect(() => {
    if (messages.length) return;
    releaseBottomStretch();
  }, [messages.length, releaseBottomStretch]);

  useEffect(() => {
    latestMessageCountRef.current = messages.length;
    latestLastMessageKeyRef.current = String(
      messages[messages.length - 1]?._clientId ??
        messages[messages.length - 1]?._serverId ??
        messages[messages.length - 1]?.id ??
        "",
    );
  }, [messages]);

  useEffect(() => {
    animationReadyRef.current = false;
    previousMessageCountRef.current = latestMessageCountRef.current;
    previousLastMessageKeyRef.current = latestLastMessageKeyRef.current;
    setAnimateRowKey("");
    setBuildUpOffsetPx(0);
    if (activationTimerRef.current) {
      window.clearTimeout(activationTimerRef.current);
      activationTimerRef.current = null;
    }
  }, [activeChatId, loadingMessages]);

  useEffect(() => {
    if (!activeChatId || loadingMessages || animationReadyRef.current) {
      return;
    }
    previousMessageCountRef.current = messages.length;
    previousLastMessageKeyRef.current = String(
      messages[messages.length - 1]?._clientId ??
        messages[messages.length - 1]?._serverId ??
        messages[messages.length - 1]?.id ??
        "",
    );
    if (activationTimerRef.current) {
      window.clearTimeout(activationTimerRef.current);
    }
    activationTimerRef.current = window.setTimeout(() => {
      animationReadyRef.current = true;
      activationTimerRef.current = null;
      previousMessageCountRef.current = messages.length;
      previousLastMessageKeyRef.current = String(
        messages[messages.length - 1]?._clientId ??
          messages[messages.length - 1]?._serverId ??
          messages[messages.length - 1]?.id ??
          "",
      );
    }, BUILD_UP_ARM_DELAY_MS);
  }, [activeChatId, loadingMessages, messages]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1] || null;
    const lastMessageKey = String(
      lastMessage?._clientId ?? lastMessage?._serverId ?? lastMessage?.id ?? "",
    );
    if (loadingMessages || !animationReadyRef.current) {
      previousMessageCountRef.current = messages.length;
      previousLastMessageKeyRef.current = lastMessageKey;
      return;
    }
    const appendedLatestMessage =
      messages.length > previousMessageCountRef.current &&
      Boolean(lastMessageKey) &&
      lastMessageKey !== previousLastMessageKeyRef.current;

    if (appendedLatestMessage) {
      if (buildUpTimerRef.current) {
        window.clearTimeout(buildUpTimerRef.current);
      }
      setAnimateRowKey(`message-${lastMessageKey}`);
      setBuildUpOffsetPx(BUILD_UP_OFFSET_PX);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setBuildUpOffsetPx(0);
        });
      });
      buildUpTimerRef.current = window.setTimeout(() => {
        setAnimateRowKey("");
        buildUpTimerRef.current = null;
      }, BUILD_UP_DURATION_MS + 80);
    }
    previousMessageCountRef.current = messages.length;
    previousLastMessageKeyRef.current = lastMessageKey;
  }, [loadingMessages, messages]);

  const handleTimelineScroll = useCallback(
    (event) => {
      const target = event?.currentTarget;
      if (!target) return;
      const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
      const atBottom = target.scrollTop >= maxScrollTop - 2;
      if (!atBottom && bottomStretchRef.current > 0) {
        releaseBottomStretch();
      }
      handlePanelScroll(event);
    },
    [handlePanelScroll, releaseBottomStretch],
  );

  const handleTimelineWheel = useCallback(
    (event) => {
      const target = event?.currentTarget;
      if (!target) return;
      const deltaY = Number(event.deltaY || 0);
      if (!Number.isFinite(deltaY) || deltaY === 0) return;
      if (deltaY < 0 && bottomStretchRef.current > 0) {
        const reduced = Math.max(0, bottomStretchRef.current + deltaY * 0.7);
        setIsReleasingStretch(false);
        bottomStretchRef.current = reduced;
        setBottomStretchPx(reduced);
        if (reduced <= 0) {
          scheduleStretchRelease();
        }
        return;
      }
      if (deltaY <= 0) return;
      const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
      const atBottom = target.scrollTop >= maxScrollTop - 2;
      if (!atBottom && bottomStretchRef.current <= 0) return;
      event.preventDefault();
      handleScrollIntent?.();
      const deltaScale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 96 : 1;
      const normalizedDelta = Math.max(0, deltaY * deltaScale);
      const nextStretch = Math.min(
        BOTTOM_STRETCH_MAX_PX,
        bottomStretchRef.current + normalizedDelta * BOTTOM_STRETCH_GAIN,
      );
      setIsReleasingStretch(false);
      bottomStretchRef.current = nextStretch;
      setBottomStretchPx(nextStretch);
      scheduleStretchRelease();
    },
    [handleScrollIntent, scheduleStretchRelease],
  );

  // The scroll area keeps a strip on each side for its scrollbar. A right click
  // there (or anywhere else that is not inside a row) is handed to the message
  // row at the same height, so the whole width of the chat opens the menu.
  const handleTimelineContextMenu = useCallback((event) => {
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    const rows = event.currentTarget.querySelectorAll("[data-message-row]");
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (event.clientY < rect.top || event.clientY > rect.bottom) continue;
      event.preventDefault();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
      return;
    }
  }, []);

  // A click on empty chat space drops a text selection, like in Telegram. The
  // rows and the gutters cannot be selected, so the browser would keep it.
  const handleTimelineMouseDown = useCallback((event) => {
    if (event.button !== 0) return;
    const container = event.currentTarget;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // A press on the scrollbar (right of the area the rows fill) is not a click on the chat.
    const { left } = container.getBoundingClientRect();
    if (event.clientX > left + container.clientLeft + container.clientWidth) return;
    // A press inside a bubble starts (or keeps) a selection of its own. A double
    // or triple click on what cannot be selected (the time, a button, the gutter)
    // would still select hidden text around it, so it does nothing.
    if (target.closest("[data-message-bubble]")) {
      if (event.detail > 1 && target.closest("[data-no-select], button")) {
        event.preventDefault();
      }
      return;
    }
    if (event.detail > 1) event.preventDefault();
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !container.contains(selection.anchorNode)) return;
    selection.removeAllRanges();
  }, []);

  // renderMessageItem builds the MessageItem; the run info is added to it here
  // unless the caller already passed it on.
  const renderRowMessage = (row) => {
    const element = renderMessageItem(row.msg, {
      isFirstInGroup: row.isFirstInGroup,
      isRunStart: row.isRunStart,
      isRunEnd: row.isRunEnd,
    });
    if (isValidElement(element) && element.props.isRunStart === undefined) {
      return cloneElement(element, {
        isRunStart: row.isRunStart,
        isRunEnd: row.isRunEnd,
      });
    }
    return element;
  };

  const setScrollRef = useCallback(
    (node) => {
      scrollContainerRef.current = node;
      if (!chatScrollRef) return;
      if (typeof chatScrollRef === "function") {
        chatScrollRef(node);
        return;
      }
      chatScrollRef.current = node;
    },
    [chatScrollRef],
  );

  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) return undefined;
    const nativeWheelHandler = (event) => {
      handleTimelineWheel(event);
    };
    node.addEventListener("wheel", nativeWheelHandler, { passive: false });
    return () => {
      node.removeEventListener("wheel", nativeWheelHandler, { passive: false });
    };
  }, [handleTimelineWheel]);

  const timelineContentStyle = {
    transform: `translateY(${buildUpOffsetPx - bottomStretchPx}px)`,
    transition:
      isReleasingStretch || Boolean(animateRowKey)
        ? `transform ${
            isReleasingStretch
              ? BOTTOM_STRETCH_RELEASE_MS
              : BUILD_UP_DURATION_MS
          }ms cubic-bezier(0.22, 0.61, 0.36, 1)`
        : "none",
    willChange:
      bottomStretchPx > 0 || Boolean(animateRowKey) ? "transform" : "auto",
  };

  if (loadingMessages) {
    return (
      <div
        ref={setScrollRef}
        className="chat-scroll h-full space-y-3 overflow-y-auto overflow-x-hidden px-6 py-6"
        onScroll={handleTimelineScroll}
        style={chatScrollStyle}
      >
        {Array.from({ length: 7 }).map((_, index) => {
          const own = index % 2 === 0;
          return (
            <div
              key={`message-skeleton-${index}`}
              className={`flex ${own ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`animate-pulse rounded-2xl ${
                  own
                    ? "h-12 w-40 bg-emerald-300/70 dark:bg-emerald-700/60"
                    : "h-14 w-52 bg-white/80 dark:bg-slate-800/80"
                }`}
              />
            </div>
          );
        })}
      </div>
    );
  }

  if (messages.length) {
    return (
      <div
        ref={setScrollRef}
        onScroll={handleTimelineScroll}
        onContextMenu={handleTimelineContextMenu}
        onMouseDown={handleTimelineMouseDown}
        onTouchStartCapture={handleScrollIntent}
        onTouchMoveCapture={handleScrollIntent}
        onWheelCapture={handleScrollIntent}
        role="log"
        aria-live="polite"
        aria-label="Messages"
        aria-relevant="additions"
        className="chat-scroll h-full overflow-y-auto overflow-x-hidden px-0 pb-2 pt-1"
        style={chatScrollStyle}
      >
        <div className="flex min-h-full flex-col justify-end">
          <div style={timelineContentStyle}>
            <div style={{ height: `${TIMELINE_TOP_SPACER_PX}px` }} />
            {loadingOlderMessages ? (
              <div className="px-3 pb-3 pt-1 md:px-0">
                <div className="mx-auto h-10 w-40 animate-pulse rounded-2xl bg-white/80 dark:bg-slate-800/80" />
              </div>
            ) : (
              <OfflineHistoryBanner
                isOffline={isOffline}
                hasOlderMessages={hasOlderMessages}
                loadingOlderMessages={loadingOlderMessages}
              />
            )}
            {timelineRows.map((row) => (
              <div
                id={row.type === "day" ? `day-group-${row.dayKey}` : undefined}
                key={row.key}
                className={
                  row.type === "message" && row.key === animateRowKey
                    ? "sb-message-build-in"
                    : undefined
                }
              >
                {row.type === "day" ? (
                  <div className="flex justify-center py-1">
                    <button
                      type="button"
                      onClick={() => handleGroupChipClick(row.dayKey)}
                      aria-label={`Jump to messages from ${row.dayLabel || row.dayKey}`}
                      className="inline-flex w-max items-center justify-center rounded-full border border-emerald-200/60 bg-white/90 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 shadow-xs transition hover:border-emerald-300 hover:shadow-md dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200"
                    >
                      <span
                        data-day-chip={row.dayLabel || ""}
                        className="leading-none"
                      >
                        {row.dayLabel || ""}
                      </span>
                    </button>
                  </div>
                ) : (
                  <div>{renderRowMessage(row)}</div>
                )}
              </div>
            ))}
            <div style={{ height: `${timelineBottomSpacerPx}px` }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setScrollRef}
      className="chat-scroll flex h-full items-center justify-center overflow-y-auto overflow-x-hidden px-6 py-6"
      onScroll={handleTimelineScroll}
      style={chatScrollStyle}
    >
      <div className="rounded-full border border-emerald-200 bg-white/80 px-4 py-2 text-sm font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200">
        Say something to start
      </div>
    </div>
  );
}

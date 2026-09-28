import { useEffect, useMemo, useRef, useState } from "react";
import { ChatMessage, ModelProvider } from "../lib/modelProvider";
import { buildFileTree } from "../lib/fileSystem";
import { ATTACHMENT_PREFIX, attachmentSummaryLine } from "../lib/contextBuilder";
import { AgentPhase, TaskStatus } from "../lib/taskSupervisor";
import { useI18n, type TranslationKey } from "../lib/i18n";

export interface SessionSummary {
  id: string;
  title: string;
  usd: number;
  thb: number;
}

const FENCED_CODE_BLOCK = /```([\w+-]*)\n([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;

// Matches a devtopflow:* tool directive fence — either fully closed, or still
// streaming in (no closing ``` yet, runs to end of string). Captured
// separately from FENCED_CODE_BLOCK above (whose language group can't contain
// the ":" in "devtopflow:file", so these never matched it anyway and used to
// fall through to plain text, dumping the raw path="…" header and full file
// body straight into the bubble).
const DIRECTIVE_BLOCK = /```devtopflow:(file|read|image|draw)([^\n]*)\n([\s\S]*?)(?:```|$)/g;

const DIRECTIVE_ICON: Record<string, string> = {
  file: "📄",
  read: "🔍",
  image: "🎨",
  draw: "🖌",
};

const DIRECTIVE_VERB_KEY: Record<string, TranslationKey> = {
  file: "directive.file",
  read: "directive.read",
  image: "directive.image",
  draw: "directive.draw",
};

/** Renders `single-backtick` spans within plain text as inline code pills. */
function renderInline(text: string, keyPrefix: string): (string | JSX.Element)[] {
  const nodes: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let i = 0;
  let match: RegExpExecArray | null;
  INLINE_CODE.lastIndex = 0;
  while ((match = INLINE_CODE.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    nodes.push(
      <code className="inline-code" key={`${keyPrefix}-${i++}`}>
        {match[1]}
      </code>
    );
    lastIndex = INLINE_CODE.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

const PHASE_LABEL_KEY: Record<AgentPhase, TranslationKey> = {
  connecting: "phase.connecting",
  waiting: "phase.waiting",
  thinking: "phase.thinking",
  streaming: "phase.streaming",
  reading: "phase.reading",
  writing: "phase.writing",
  imaging: "phase.imaging",
};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Re-renders every `intervalMs` while mounted — for wall-clock readouts. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Live status of the running task, pinned just above the input so it's
 * visible no matter where the transcript is scrolled. Everything shown comes
 * from real stream signals (see TaskStatus) — the phase, the output size, and
 * how long it's been since the model last sent anything when that gets long.
 */
function AgentStatusBar({ status, onStop }: { status: TaskStatus; onStop: () => void }) {
  const { t } = useI18n();
  const now = useNow(250);
  const stalled = status.stalledSince !== undefined;
  const label = stalled
    ? t("phase.stalled", {
        idle: formatElapsed(now - status.stalledSince! + status.timeoutMs * 0.25),
        limit: formatElapsed(status.timeoutMs),
      })
    : t(PHASE_LABEL_KEY[status.phase]);
  return (
    <div className={`agent-status ${stalled ? "stalled" : ""}`} role="status" aria-live="polite">
      <span className={`agent-status-spinner phase-${status.phase}`} />
      <span className="agent-status-text">
        <span className="agent-status-label">{label}</span>
        {status.detail && !stalled && <span className="agent-status-detail">{status.detail}</span>}
      </span>
      <span className="agent-status-meta">
        {status.turn > 1 && <span title={t("status.turnTooltip")}>{t("status.turn", { n: status.turn })}</span>}
        {status.outputTokens > 0 && <span>~{status.outputTokens.toLocaleString()} tok</span>}
        <span>{formatElapsed(now - status.startedAt)}</span>
      </span>
      <button className="agent-status-stop" onClick={onStop} title={t("chat.stopTitle")}>
        {t("chat.stop")}
      </button>
    </div>
  );
}

/**
 * Splits plain text (no devtopflow:* directives left in it) into segments and
 * fenced code blocks, rendering the latter as real code blocks instead of
 * literal ```lang text. `nextKey` is a single counter shared across the whole
 * message (see MessageContent) — every call anywhere in the tree draws from
 * it, so two elements can never end up with the same key regardless of how
 * many directive/text segments the message happens to split into.
 */
function renderTextWithCode(content: string, nextKey: () => number, copyLabel: string): JSX.Element[] {
  const parts: JSX.Element[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  FENCED_CODE_BLOCK.lastIndex = 0;
  while ((match = FENCED_CODE_BLOCK.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const k = nextKey();
      parts.push(<span key={k}>{renderInline(content.slice(lastIndex, match.index), `t${k}`)}</span>);
    }
    const lang = match[1] || "text";
    const code = match[2].replace(/\n$/, "");
    parts.push(
      <div className="code-block" key={nextKey()}>
        <div className="code-block-header">
          <span>{lang}</span>
          <button className="code-block-copy" onClick={() => navigator.clipboard.writeText(code)}>
            {copyLabel}
          </button>
        </div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
    lastIndex = FENCED_CODE_BLOCK.lastIndex;
  }
  if (lastIndex < content.length) {
    const k = nextKey();
    parts.push(<span key={k}>{renderInline(content.slice(lastIndex), `t${k}`)}</span>);
  }
  return parts;
}

/**
 * Splits a message into plain-text segments and devtopflow:* tool directives,
 * rendering the latter as a short "📄 Writing `path`…" status line instead of
 * the full file/prompt body — the content is already being written straight
 * to disk (agentTools.ts), so echoing it back in the chat bubble too was pure
 * noise (and, mid-stream, a wall of code the user had to scroll past before
 * the "✅ Created" summary even showed up).
 */
function MessageContent({ content }: { content: string }) {
  const { t } = useI18n();
  const parts: JSX.Element[] = [];
  let lastIndex = 0;
  let n = 0;
  const nextKey = () => n++;
  const copyLabel = t("chat.copy");
  let match: RegExpExecArray | null;
  DIRECTIVE_BLOCK.lastIndex = 0;
  while ((match = DIRECTIVE_BLOCK.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...renderTextWithCode(content.slice(lastIndex, match.index), nextKey, copyLabel));
    }
    const icon = DIRECTIVE_ICON[match[1]] ?? "⚙️";
    const verb = t(DIRECTIVE_VERB_KEY[match[1]] ?? "directive.fallback");
    const path = /path="([^"]*)"/.exec(match[2])?.[1] ?? "file";
    parts.push(
      <div className="directive-chip" key={nextKey()}>
        {icon} {verb} <code className="inline-code">{path}</code>…
      </div>
    );
    lastIndex = DIRECTIVE_BLOCK.lastIndex;
  }
  if (lastIndex < content.length) {
    parts.push(...renderTextWithCode(content.slice(lastIndex), nextKey, copyLabel));
  }
  return <>{parts}</>;
}

interface ChatPanelProps {
  /** Status of the task running in this chat, if any. */
  taskStatus?: TaskStatus;
  providers: ModelProvider[];
  activeProviderId?: string;
  onSelectProvider: (id: string) => void;
  onSend: (text: string) => void;
  messages: ChatMessage[];
  messageCosts?: Record<number, string>;
  sessionCost?: { usd: number; thb: number };
  pendingAttachments: string[];
  onAttachContext: () => void;
  onAttachFromDisk: () => void;
  onAttachImageData: (dataUrl: string) => void;
  onRemoveAttachment: (index: number) => void;
  onStop: () => void;
  onNewChat: () => void;
  estimatedTokens?: number;
  sessions: SessionSummary[];
  activeSessionId: string;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  projectRoot?: string;
  overContextLimit?: boolean;
  contextLimit?: number;
  supervisorWarningText?: string;
  supervisorCanRetry?: boolean;
  onResumeAnyway: () => void;
  onDismissWarning: () => void;
}

export default function ChatPanel({
  providers,
  activeProviderId,
  onSelectProvider,
  onSend,
  messages,
  messageCosts,
  sessionCost,
  pendingAttachments,
  onAttachContext,
  onAttachFromDisk,
  onAttachImageData,
  onRemoveAttachment,
  taskStatus,
  onStop,
  onNewChat,
  estimatedTokens,
  sessions,
  activeSessionId,
  onSwitchSession,
  onDeleteSession,
  projectRoot,
  overContextLimit,
  contextLimit,
  supervisorWarningText,
  supervisorCanRetry,
  onResumeAnyway,
  onDismissWarning,
}: ChatPanelProps) {
  const { t } = useI18n();
  const isSending = !!taskStatus;
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);

  // @see: lets the user verify exactly what the agent can see, on demand —
  // the same file tree that actually gets sent as context (src/lib/agentTools.ts).
  const [seeOpen, setSeeOpen] = useState(false);
  const [seeTree, setSeeTree] = useState<string>();
  const [seeLoading, setSeeLoading] = useState(false);

  const toggleSee = async () => {
    const opening = !seeOpen;
    setSeeOpen(opening);
    if (opening && projectRoot) {
      setSeeLoading(true);
      try {
        setSeeTree(await buildFileTree(projectRoot));
      } finally {
        setSeeLoading(false);
      }
    }
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to the latest message so the user isn't left scrolling down
  // manually — but don't yank them back down if they've scrolled up to read
  // earlier messages while a response streams in.
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const handleMessagesScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = messagesRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isSending]);

  useEffect(() => {
    stickToBottomRef.current = true;
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeSessionId]);

  // Up/Down recall of this chat's own past messages, like shell history.
  const sentHistory = useMemo(
    () => messages.filter((m) => m.role === "user").map((m) => m.content).reverse(),
    [messages]
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [pendingDraft, setPendingDraft] = useState("");

  useEffect(() => {
    setHistoryIndex(-1);
    setPendingDraft("");
  }, [activeSessionId]);

  useEffect(() => {
    if (historyIndex !== -1 && textareaRef.current) {
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [historyIndex]);

  const submit = () => {
    if (!draft.trim()) return;
    // A local command, not a real chat message — forces every step of the
    // current task to stop instead of being sent to the model.
    if (draft.trim().toLowerCase() === "@stop") {
      onStop();
      setDraft("");
      setHistoryIndex(-1);
      setPendingDraft("");
      return;
    }
    // One task per chat at a time — the draft stays put until this one ends.
    if (isSending) return;
    onSend(draft);
    setDraft("");
    setHistoryIndex(-1);
    setPendingDraft("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && isSending) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }

    const el = e.currentTarget;
    if (e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0) {
      if (sentHistory.length === 0) return;
      e.preventDefault();
      if (historyIndex === -1) setPendingDraft(draft);
      const nextIndex = Math.min(historyIndex + 1, sentHistory.length - 1);
      setHistoryIndex(nextIndex);
      setDraft(sentHistory[nextIndex]);
    } else if (e.key === "ArrowDown" && historyIndex !== -1 && el.selectionStart === el.value.length) {
      e.preventDefault();
      const nextIndex = historyIndex - 1;
      if (nextIndex === -1) {
        setHistoryIndex(-1);
        setDraft(pendingDraft);
      } else {
        setHistoryIndex(nextIndex);
        setDraft(sentHistory[nextIndex]);
      }
    }
  };

  // Cmd+V / Ctrl+V a copied image (e.g. a screenshot of a design) straight
  // into the chat — attaches it the same way as browsing for a file, without
  // needing to save it to disk first.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = [...e.clipboardData.items].find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") onAttachImageData(reader.result);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <button className="text-btn" onClick={() => setHistoryOpen((v) => !v)} title={t("chat.historyTitle")}>
          🕘 {sessions.length > 1 ? t("chat.historyMulti", { n: sessions.length }) : t("chat.historySingle")}
        </button>
        <span className="session-cost" title={t("chat.sessionCostTooltip")}>
          {sessionCost && sessionCost.usd > 0 && `$${sessionCost.usd.toFixed(4)} · ฿${sessionCost.thb.toFixed(2)}`}
        </span>
        <button className="text-btn" onClick={onNewChat} title={t("chat.newChatTitle")}>
          {t("chat.newChat")}
        </button>
      </div>

      {supervisorWarningText && (
        <div className="supervisor-warning">
          <span>{supervisorWarningText}</span>
          <button className="text-btn" onClick={onResumeAnyway}>
            {supervisorCanRetry ? t("chat.retry") : t("chat.resumeAnyway")}
          </button>
          <button className="text-btn" onClick={onDismissWarning}>
            ✕
          </button>
        </div>
      )}

      {historyOpen && (
        <div className="history-panel">
          {sessions.map((s) => (
            <div key={s.id} className={`history-row ${s.id === activeSessionId ? "active" : ""}`}>
              <span
                className="history-row-title"
                onClick={() => {
                  onSwitchSession(s.id);
                  setHistoryOpen(false);
                }}
                title={s.title}
              >
                {s.title}
                {s.usd > 0 && <span className="history-row-cost"> · ${s.usd.toFixed(4)}</span>}
              </span>
              <button
                className="tab-close"
                title={t("chat.deleteChatTitle")}
                onClick={() => onDeleteSession(s.id)}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}

      {pendingAttachments.length > 0 && (
        <div className="context-chip-row">
          {pendingAttachments.map((label, i) => (
            <div className="context-chip" key={i}>
              📎 {label}
              <button className="context-chip-remove" title={t("chat.removeAttachment")} onClick={() => onRemoveAttachment(i)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {!!estimatedTokens && <div className="cost-chip">{t("chat.estTokens", { n: estimatedTokens })}</div>}
      {overContextLimit && (
        <div className="cost-chip over-limit" title={t("chat.overContextLimitTooltip")}>
          {t("chat.overContextLimit", { limit: contextLimit?.toLocaleString() ?? "" })}
        </div>
      )}

      <div className="chat-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        {messages.map((m, i) => {
          const isAttachment = m.role === "user" && m.content.startsWith(ATTACHMENT_PREFIX);
          const isLast = i === messages.length - 1;
          const isLive = isSending && isLast && m.role === "assistant" && !m.meta;
          const isPending = isLive && m.content === "";
          // A stopped request can leave an empty assistant turn behind — nothing to show.
          if (!isLive && m.role === "assistant" && !m.content.trim()) return null;
          return (
            <div
              key={i}
              className={[
                "chat-bubble",
                m.role === "user" ? "user" : "assistant",
                isAttachment ? "attachment" : "",
                m.meta ? `meta meta-${m.meta}` : "",
                isLive && !isPending ? "streaming" : "",
              ].join(" ")}
            >
              {isPending ? (
                <span className="typing-dots" aria-label={t(PHASE_LABEL_KEY[taskStatus!.phase])}>
                  <span />
                  <span />
                  <span />
                </span>
              ) : isAttachment ? (
                <>
                  {m.image && (
                    <img
                      className="attachment-thumb"
                      src={`data:${m.image.mimeType};base64,${m.image.dataBase64}`}
                      alt=""
                    />
                  )}
                  {attachmentSummaryLine(m.content)}
                </>
              ) : (
                <MessageContent content={m.content} />
              )}
              {messageCosts?.[i] && <div className="usage-line">{messageCosts[i]}</div>}
            </div>
          );
        })}
      </div>

      {taskStatus && <AgentStatusBar status={taskStatus} onStop={onStop} />}

      <div className="chat-input">
        <div className="chat-input-toolbar">
          <span className="attach-menu-wrap">
            <button className="text-btn" onClick={() => setAttachMenuOpen((v) => !v)} title={t("chat.attachTitle")}>
              {t("chat.attach")}
            </button>
            {attachMenuOpen && (
              <div className="attach-menu">
                <button
                  className="attach-menu-item"
                  onClick={() => {
                    onAttachContext();
                    setAttachMenuOpen(false);
                  }}
                >
                  {t("chat.attachActiveFile")}
                </button>
                <button
                  className="attach-menu-item"
                  onClick={() => {
                    onAttachFromDisk();
                    setAttachMenuOpen(false);
                  }}
                >
                  {t("chat.attachBrowse")}
                </button>
              </div>
            )}
          </span>
          <select
            className="model-select-compact"
            value={activeProviderId ?? ""}
            onChange={(e) => onSelectProvider(e.target.value)}
            disabled={providers.length === 0}
            title={t("chat.modelTooltip")}
          >
            {providers.length === 0 && <option value="">{t("chat.noModelConfigured")}</option>}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.kind === "local" ? "🖥️ " : "☁️ "}
                {p.label}
              </option>
            ))}
          </select>
          <span className="attach-menu-wrap">
            <button
              className={`text-btn see-chip ${projectRoot ? "" : "see-chip-off"}`}
              onClick={toggleSee}
              title={t("chat.seeTitle")}
            >
              {t("chat.see")}
            </button>
            {seeOpen && (
              <div className="see-panel see-panel-right">
                {!projectRoot ? (
                  <div className="see-panel-empty">{t("chat.seeEmptyNoFolder")}</div>
                ) : seeLoading ? (
                  <div className="see-panel-empty">{t("chat.seeLoading")}</div>
                ) : (
                  <>
                    <div className="see-panel-title" title={projectRoot}>
                      {projectRoot}
                    </div>
                    <pre className="see-panel-tree">{seeTree || t("chat.seeEmptyFolder")}</pre>
                  </>
                )}
              </div>
            )}
          </span>
        </div>
        <div className="chat-compose">
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            rows={3}
            placeholder={isSending ? t("chat.placeholderSending") : t("chat.placeholderIdle")}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (historyIndex !== -1) setHistoryIndex(-1);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          {isSending ? (
            <button className="chat-send-btn stop" onClick={onStop} title={t("chat.stopTitle")}>
              ■
            </button>
          ) : (
            <button
              className="chat-send-btn"
              onClick={submit}
              disabled={!draft.trim() || providers.length === 0}
              title={t("chat.sendTitle")}
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

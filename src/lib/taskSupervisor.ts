// Runaway / overrun protection (agent-control-panel-prompt.md §2) and the
// live task status the chat panel shows while a prompt is in flight. Status
// is driven only by real signals from the provider stream (headers received,
// thinking deltas, text deltas, keep-alive pings) — never by a timer that
// pretends to make progress.

export type AgentPhase =
  | "connecting" // request sent, no response headers yet
  | "waiting" // connected, model hasn't produced anything visible yet
  | "thinking" // extended-thinking / reasoning tokens arriving
  | "streaming" // answer text arriving
  | "reading" // agent reading project files between turns
  | "writing" // writing files the model produced
  | "imaging"; // rendering / generating images

export interface TaskStatus {
  phase: AgentPhase;
  startedAt: number;
  /** 1-based model turn within this task (file-read round trips add turns). */
  turn: number;
  /** Rough output size so far (chars/4 until the provider reports real usage). */
  outputTokens: number;
  /** Extra context for the phase — e.g. which files are being read/written. */
  detail?: string;
  /** Set while no stream activity has arrived for a while; cleared when activity resumes. */
  stalledSince?: number;
  /** The per-turn no-activity timeout, so the UI can say how long it will keep waiting. */
  timeoutMs: number;
}

export type SupervisorStopReason =
  | { kind: "manual" }
  | { kind: "turn-stall" }
  | { kind: "request-failed" }
  | { kind: "loop-detected" }
  | { kind: "max-turns" }
  | { kind: "max-tool-calls" };

/** Translation key for each stop reason's message — the actual strings live in lib/i18n.tsx. */
export function supervisorStopMessageKey(reason: SupervisorStopReason) {
  switch (reason.kind) {
    case "manual":
      return "supervisor.manual" as const;
    case "turn-stall":
      return "supervisor.turnStall" as const;
    case "request-failed":
      return "supervisor.requestFailed" as const;
    case "loop-detected":
      return "supervisor.loopDetected" as const;
    case "max-turns":
      return "supervisor.maxTurns" as const;
    case "max-tool-calls":
      return "supervisor.maxToolCalls" as const;
  }
}

/** Only non-manual stops offer a way to continue — the user explicitly asked to stop in the manual case. */
export function isResumable(reason: SupervisorStopReason): boolean {
  return reason.kind !== "manual";
}

/** Failures (no response, request error) get a plain "Retry"; supervisor limits get "Resume anyway". */
export function isRetryable(reason: SupervisorStopReason): boolean {
  return reason.kind === "turn-stall" || reason.kind === "request-failed";
}

/**
 * Watches for stream activity and fires a two-stage warning: `onWarn` once
 * nothing has arrived for `warnAtRatio` of the budget, then `onTimeout` if
 * nothing arrives before the deadline. `ping()` resets the clock and clears
 * any warning once activity resumes.
 */
export function createStallWatcher(opts: {
  timeoutMs: number;
  warnAtRatio?: number;
  onWarn: () => void;
  onRecovered: () => void;
  onTimeout: () => void;
}) {
  const warnAtRatio = opts.warnAtRatio ?? 0.25;
  let lastActivity = Date.now();
  let warned = false;
  let stopped = false;

  const checkId = setInterval(() => {
    if (stopped) return;
    const idle = Date.now() - lastActivity;
    if (idle >= opts.timeoutMs) {
      stopped = true;
      clearInterval(checkId);
      opts.onTimeout();
      return;
    }
    if (idle > opts.timeoutMs * warnAtRatio && !warned) {
      warned = true;
      opts.onWarn();
    }
  }, 500);

  return {
    ping() {
      lastActivity = Date.now();
      if (warned) {
        warned = false;
        opts.onRecovered();
      }
    },
    stop() {
      stopped = true;
      clearInterval(checkId);
    },
  };
}

/** Stable key for a set of requested read paths, order-independent — used to detect the model re-requesting the exact same file(s) with no new progress. */
export function hashReadPaths(paths: string[]): string {
  return [...paths].sort().join("|");
}

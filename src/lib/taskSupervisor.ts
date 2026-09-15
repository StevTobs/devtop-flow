// Runaway / overrun protection (agent-control-panel-prompt.md §2) and the
// phase-based progress model (§3) that reads off the same real signals —
// a stalled task shows as stalled, not as a bar quietly faking its way to 100%.

export type AgentPhase = "idle" | "parsing" | "waiting" | "streaming" | "applying" | "finalizing" | "stalled";

export type SupervisorStopReason =
  | { kind: "manual" }
  | { kind: "absolute-timeout" }
  | { kind: "turn-stall" }
  | { kind: "loop-detected" }
  | { kind: "max-turns" }
  | { kind: "max-tool-calls" };

/** Translation key for each stop reason's message — kept as a lookup here so callers (App.tsx, ChatPanel.tsx) share one mapping instead of duplicating it. The actual strings live in lib/i18n.tsx. */
export function supervisorStopMessageKey(reason: SupervisorStopReason) {
  switch (reason.kind) {
    case "manual":
      return "supervisor.manual" as const;
    case "absolute-timeout":
      return "supervisor.absoluteTimeout" as const;
    case "turn-stall":
      return "supervisor.turnStall" as const;
    case "loop-detected":
      return "supervisor.loopDetected" as const;
    case "max-turns":
      return "supervisor.maxTurns" as const;
    case "max-tool-calls":
      return "supervisor.maxToolCalls" as const;
  }
}

/** Only supervisor-triggered stops (not a manual stop) offer a way to continue — the user explicitly asked to stop in the manual case. */
export function isResumable(reason: SupervisorStopReason): boolean {
  return reason.kind !== "manual";
}

/** A no-response/stall/timeout is a plain "it failed, try again" — bypassing supervisor limits (the other reasons: loop/max-turns/max-tool-calls) isn't the right mental model for it, so it gets its own "Retry" wording instead of "Resume anyway". */
export function isRetryable(reason: SupervisorStopReason): boolean {
  return reason.kind === "turn-stall" || reason.kind === "absolute-timeout";
}

/**
 * Watches for stream activity (token or tool-call progress) and fires a
 * two-stage warning: `onWarn` partway through the budget (surfaced as the
 * "stalled" phase so the UI can show a distinct warning state before the
 * hard cutoff), then `onTimeout` if nothing arrives before the deadline.
 * `ping()` resets the clock and clears any warning once activity resumes.
 */
export function createStallWatcher(opts: {
  timeoutMs: number;
  warnAtRatio?: number;
  onWarn: () => void;
  onRecovered: () => void;
  onTimeout: () => void;
}) {
  // Was 0.6 (54s of dead air on the 90s default before any visible warning) —
  // a real no-response case left the UI showing a plain "SYNCHRONIZING" with
  // no hint anything was wrong for the whole first minute. 0.3 surfaces the
  // "stalled" phase in ~27s instead, well before most users would conclude
  // it's broken and give up on their own.
  const warnAtRatio = opts.warnAtRatio ?? 0.3;
  let lastActivity = Date.now();
  let warned = false;
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout>;

  const arm = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      if (!stopped) opts.onTimeout();
    }, opts.timeoutMs);
  };

  const checkId = setInterval(() => {
    if (stopped) return;
    const idle = Date.now() - lastActivity;
    if (idle > opts.timeoutMs * warnAtRatio && !warned) {
      warned = true;
      opts.onWarn();
    }
  }, 400);

  arm();

  return {
    ping() {
      lastActivity = Date.now();
      if (warned) {
        warned = false;
        opts.onRecovered();
      }
      arm();
    },
    stop() {
      stopped = true;
      clearTimeout(timeoutId);
      clearInterval(checkId);
    },
  };
}

/** Phase-based progress estimate, weighted by expected cost/time per phase. */
export function estimateProgress(phase: AgentPhase, tokensReceived: number, estimatedMaxTokens: number): number {
  switch (phase) {
    case "idle":
      return 0;
    case "parsing":
      return 0.05;
    case "waiting":
    case "stalled":
      return 0.1;
    case "streaming": {
      const ratio = estimatedMaxTokens > 0 ? tokensReceived / estimatedMaxTokens : 0;
      return 0.15 + Math.min(ratio, 1) * 0.75;
    }
    case "applying":
      return 0.92;
    case "finalizing":
      return 1.0;
  }
}

/** Stable key for a set of requested read paths, order-independent — used to detect the model re-requesting the exact same file(s) with no new progress. */
export function hashReadPaths(paths: string[]): string {
  return [...paths].sort().join("|");
}

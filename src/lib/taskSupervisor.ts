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

export function supervisorStopMessage(reason: SupervisorStopReason): string {
  switch (reason.kind) {
    case "manual":
      return "⏹ Stopped.";
    case "absolute-timeout":
      return "⏱ Timed out — stopped automatically with no response. The provider may be overloaded, or the request may be taking unusually long.";
    case "turn-stall":
      return "⚠️ Stopped: no activity for a while — the request may have stalled.";
    case "loop-detected":
      return "⚠️ Stopped: possible loop detected (the model kept requesting the same file with no new progress).";
    case "max-turns":
      return "⚠️ Stopped: this task used its maximum turns without finishing — it may be stuck.";
    case "max-tool-calls":
      return "⚠️ Stopped: a single turn tried to use more tool calls than allowed.";
  }
}

/** Only supervisor-triggered stops (not a manual stop) offer "Resume anyway" — the user explicitly asked to stop in the manual case. */
export function isResumable(reason: SupervisorStopReason): boolean {
  return reason.kind !== "manual";
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
  const warnAtRatio = opts.warnAtRatio ?? 0.6;
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

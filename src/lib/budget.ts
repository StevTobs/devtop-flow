// Budget monitoring (build plan §8 "Token/cost estimator"): tracks total
// spend across every folder/chat, not just the active session, against an
// optional user-set limit.

export interface BudgetState {
  totalUsd: number;
  totalThb: number;
  /** 0 = no limit set. */
  limitUsd: number;
}

const KEY = "devtopflow.budget.v1";

const DEFAULT_BUDGET: BudgetState = { totalUsd: 0, totalThb: 0, limitUsd: 0 };

export function loadBudget(): BudgetState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_BUDGET, ...JSON.parse(raw) };
  } catch {
    // ignore, fall through to default
  }
  return { ...DEFAULT_BUDGET };
}

export function saveBudget(state: BudgetState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // best-effort
  }
}

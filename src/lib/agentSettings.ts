import { createFile, readFile } from "./fileSystem";
import type { ThinkingMode } from "./modelProvider";

// Agent Control Panel (agent-control-panel-prompt.md §1): every knob that
// shapes how a task actually runs — context, reasoning effort, response
// limits, custom instructions — collected in one place instead of being
// scattered constants. Defaults are persisted globally; a project folder
// gets its own on-disk copy (like chat history) so they travel with the
// project, and any single chat can override the effective settings for
// just that conversation.

export interface AgentSettings {
  contextLimit: number;
  includeOpenFile: boolean;
  includeWorkspaceTree: boolean;
  maxAutoAttachFiles: number;
  thinkingMode: ThinkingMode;
  maxThinkingTokens: number;
  temperature: number;
  maxOutputTokens: number;
  maxToolCallsPerTurn: number;
  maxTurnsPerTask: number;
  /** Wall-clock stall timeout per turn (ms) — aborts if no stream activity for this long. */
  turnTimeoutMs: number;
  systemPromptOverride: string;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  contextLimit: 100_000,
  includeOpenFile: true,
  includeWorkspaceTree: true,
  maxAutoAttachFiles: 5,
  thinkingMode: "off",
  maxThinkingTokens: 4000,
  temperature: 0.5,
  maxOutputTokens: 8192,
  maxToolCallsPerTurn: 8,
  maxTurnsPerTask: 4,
  // Time-to-first-token, not total response time — every provider call
  // still pings this on each streamed chunk, so a long *streaming* response
  // never trips it. Attached images get an automatic 2x grace window on top
  // of this (see runAgentTask) since upload + vision processing is slower.
  turnTimeoutMs: 90_000,
  systemPromptOverride: "",
};

export const BUILTIN_PRESETS: Record<string, AgentSettings> = {
  Fast: {
    ...DEFAULT_AGENT_SETTINGS,
    contextLimit: 32_000,
    maxAutoAttachFiles: 3,
    thinkingMode: "off",
    temperature: 0.3,
    maxOutputTokens: 4096,
    maxToolCallsPerTurn: 4,
    maxTurnsPerTask: 2,
    turnTimeoutMs: 60_000,
  },
  Balanced: { ...DEFAULT_AGENT_SETTINGS },
  "Deep Reasoning": {
    ...DEFAULT_AGENT_SETTINGS,
    contextLimit: 200_000,
    maxAutoAttachFiles: 8,
    thinkingMode: "high",
    maxThinkingTokens: 8000,
    temperature: 0.7,
    maxOutputTokens: 8192,
    maxToolCallsPerTurn: 12,
    maxTurnsPerTask: 8,
    turnTimeoutMs: 120_000,
  },
};

const GLOBAL_KEY = "devtopflow.agentSettings";
const CUSTOM_PRESETS_KEY = "devtopflow.agentPresets";
const SETTINGS_SUBPATH = ".devtopflow/settings.json";

function settingsPath(projectRoot: string): string {
  const sep = projectRoot.includes("\\") ? "\\" : "/";
  return `${projectRoot.replace(/[\\/]+$/, "")}${sep}${SETTINGS_SUBPATH.replace(/\//g, sep)}`;
}

export function loadGlobalAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (raw) return { ...DEFAULT_AGENT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // ignore, fall through to defaults
  }
  return { ...DEFAULT_AGENT_SETTINGS };
}

export function saveGlobalAgentSettings(settings: AgentSettings): void {
  try {
    localStorage.setItem(GLOBAL_KEY, JSON.stringify(settings));
  } catch {
    // best-effort
  }
}

/** Per-project copy, so settings travel with a project the same way chat history does. Falls back silently if the folder isn't writable — the global/localStorage copy still applies. */
export async function loadProjectAgentSettings(projectRoot: string | undefined): Promise<AgentSettings | undefined> {
  if (!projectRoot) return undefined;
  try {
    const raw = await readFile(settingsPath(projectRoot));
    return { ...DEFAULT_AGENT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return undefined;
  }
}

export async function saveProjectAgentSettings(projectRoot: string | undefined, settings: AgentSettings): Promise<void> {
  if (!projectRoot) return;
  try {
    await createFile(settingsPath(projectRoot), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error(`DevTop Flow: couldn't save agent settings to ${settingsPath(projectRoot)}.`, e);
  }
}

export function loadCustomPresets(): Record<string, AgentSettings> {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

export function saveCustomPreset(name: string, settings: AgentSettings): Record<string, AgentSettings> {
  const next = { ...loadCustomPresets(), [name]: settings };
  try {
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
  return next;
}

export function deleteCustomPreset(name: string): Record<string, AgentSettings> {
  const next = loadCustomPresets();
  delete next[name];
  try {
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
  return next;
}

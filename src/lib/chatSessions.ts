import { ChatMessage } from "./modelProvider";
import { createFile, readFile } from "./fileSystem";
import { AgentSettings } from "./agentSettings";

// Multiple chat threads, like ChatGPT/Claude's sidebar history — "New Chat"
// starts a fresh thread without touching earlier ones. Deleting a thread is
// a separate, explicit, confirmed action (see App.tsx deleteSession).
//
// When a project folder is open, history is saved *inside that folder*
// (.devtopflow/chat-history.json) rather than only in the app's own
// storage — so it travels with the project, and so the same conversation
// prefix gets resent verbatim on the next turn. Resending an identical
// prefix is what lets the provider serve it from its prompt cache instead
// of reprocessing it — recalled history should show up as Cache Hit, not
// Cache Miss, in the usage line under each response.
//
// With no folder open, history falls back to the app's own local storage.

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: ChatMessage[];
  messageCosts: Record<number, string>;
  sessionCost: { usd: number; thb: number };
  /** Agent Settings overridden for just this chat — undefined means "use the global default". */
  settingsOverride?: Partial<AgentSettings>;
}

const HISTORY_SUBPATH = ".devtopflow/chat-history.json";
const NO_FOLDER_STORAGE_KEY = "devtopflow.sessions.no-folder";
const OLD_GLOBAL_KEY = "devtopflow.sessions.v1"; // pre-per-folder format
const OLD_PER_FOLDER_PREFIX = "devtopflow.sessions."; // brief localStorage-per-folder format, migrated once below

export const WELCOME_MESSAGE: ChatMessage = {
  role: "assistant",
  content: "Hi — I'm DevTop Flow. Set an API key (⚙ in the sidebar) or run Ollama locally, then ask away.",
};

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newSession(): ChatSession {
  return {
    id: makeId(),
    title: "New Chat",
    createdAt: Date.now(),
    messages: [WELCOME_MESSAGE],
    messageCosts: {},
    sessionCost: { usd: 0, thb: 0 },
  };
}

/** Derives a short label from the first user message, like ChatGPT's thread titles. */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New Chat";
  const text = firstUser.content.trim().replace(/\s+/g, " ");
  return text.length > 42 ? `${text.slice(0, 42)}…` : text || "New Chat";
}

function historyPath(projectRoot: string): string {
  const sep = projectRoot.includes("\\") ? "\\" : "/";
  return `${projectRoot.replace(/[\\/]+$/, "")}${sep}${HISTORY_SUBPATH.replace(/\//g, sep)}`;
}

function parseStored(raw: string): { sessions: ChatSession[]; activeId: string } | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
      return { sessions: parsed.sessions, activeId: parsed.activeId ?? parsed.sessions[0].id };
    }
  } catch {
    // fall through
  }
  return undefined;
}

export async function loadSessions(projectRoot: string | undefined): Promise<{ sessions: ChatSession[]; activeId: string }> {
  if (projectRoot) {
    try {
      const found = parseStored(await readFile(historyPath(projectRoot)));
      if (found) return found;
    } catch {
      // no history file yet for this folder — fall through to migration/fresh start
    }

    // One-time migration from the brief localStorage-per-folder format this
    // app used just before switching to in-folder storage.
    try {
      const raw = localStorage.getItem(OLD_PER_FOLDER_PREFIX + projectRoot);
      if (raw) {
        const found = parseStored(raw);
        if (found) {
          localStorage.removeItem(OLD_PER_FOLDER_PREFIX + projectRoot);
          await saveSessions(projectRoot, found.sessions, found.activeId);
          return found;
        }
      }
    } catch {
      // ignore, fall through
    }
  } else {
    try {
      const raw = localStorage.getItem(NO_FOLDER_STORAGE_KEY);
      if (raw) {
        const found = parseStored(raw);
        if (found) return found;
      }
    } catch {
      // fall through
    }
  }

  // One-time migration from the earliest global (non-per-folder) format.
  try {
    const oldRaw = localStorage.getItem(OLD_GLOBAL_KEY);
    if (oldRaw) {
      localStorage.removeItem(OLD_GLOBAL_KEY);
      const found = parseStored(oldRaw);
      if (found) {
        await saveSessions(projectRoot, found.sessions, found.activeId);
        return found;
      }
    }
  } catch {
    // ignore, fall through to fresh start
  }

  const fresh = newSession();
  return { sessions: [fresh], activeId: fresh.id };
}

export async function saveSessions(projectRoot: string | undefined, sessions: ChatSession[], activeId: string): Promise<void> {
  const payload = JSON.stringify({ sessions, activeId });
  if (projectRoot) {
    try {
      await createFile(historyPath(projectRoot), payload);
      return;
    } catch (e) {
      // Folder became unwritable/unmounted — fall back to local storage
      // under this folder's key so the conversation isn't lost outright.
      console.error(`DevTop Flow: couldn't save chat history to ${historyPath(projectRoot)}, falling back to local storage.`, e);
    }
  }
  try {
    localStorage.setItem(projectRoot ? OLD_PER_FOLDER_PREFIX + projectRoot : NO_FOLDER_STORAGE_KEY, payload);
  } catch {
    // best-effort — storage may be unavailable in some webview contexts
  }
}

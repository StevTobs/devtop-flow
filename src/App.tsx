import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import EditorPane, { EditorTab } from "./components/EditorPane";
import ChatPanel from "./components/ChatPanel";
const TerminalPanel = lazy(() => import("./components/TerminalPanel"));
import Settings from "./components/Settings";
import PrivacyNotice from "./components/PrivacyNotice";
import AgentSettingsPanel from "./components/AgentSettingsPanel";
import {
  ChatMessage,
  StreamChunk,
  toRequestMessages,
  buildProviderRegistry,
  checkOllamaStatus,
  listAnthropicModels,
  listOpenAICompatibleModels,
  loadManualOllamaModels,
  saveManualOllamaModels,
  loadOllamaBaseUrl,
  saveOllamaBaseUrl,
} from "./lib/modelProvider";
import { save } from "@tauri-apps/plugin-dialog";
import { ApiKeyProvider, loadAllApiKeys } from "./lib/secrets";
import {
  base64ToBytes,
  buildFileTree,
  createBinaryFile,
  createFile,
  isRasterImagePath,
  isSameOrDescendant,
  languageFromPath,
  listDir,
  pickAnyFiles,
  pickProjectFolder,
  readFile,
  readImageAsDataUrl,
  rebasePath,
  writeFile,
} from "./lib/fileSystem";
import { buildFileContextMessage, buildImageAttachmentMessage, estimateTokens } from "./lib/contextBuilder";
import {
  applyFileDirectives,
  applyImageDirectives,
  buildReadResultsMessage,
  buildToolCapabilityMessage,
  extractFileDirectives,
  extractReadRequests,
} from "./lib/agentTools";
import { formatFromPath, renderBlankImage } from "./lib/imageGen";
import { estimateCost, estimateImageCost, formatCost } from "./lib/pricing";
import { ChatSession, deriveTitle, loadSessions, newSession, saveSessions } from "./lib/chatSessions";
import { BudgetState, loadBudget, saveBudget } from "./lib/budget";
import { buildAppMenu } from "./lib/appMenu";
import {
  AgentSettings,
  loadGlobalAgentSettings,
  loadProjectAgentSettings,
  saveGlobalAgentSettings,
  saveProjectAgentSettings,
} from "./lib/agentSettings";
import {
  AgentPhase,
  SupervisorStopReason,
  TaskStatus,
  createStallWatcher,
  hashReadPaths,
  isResumable,
  isRetryable,
  supervisorStopMessageKey,
} from "./lib/taskSupervisor";
import logo from "./assets/logo.png";
import { useI18n } from "./lib/i18n";
import { Theme, loadTheme, saveTheme } from "./lib/uiPrefs";

const PROJECT_ROOT_KEY = "devtopflow.projectRoot";
const ACTIVE_PROVIDER_KEY = "devtopflow.activeProviderId";
const PRIVACY_CONSENTED_KEY = "devtopflow.privacyConsentedFolders";

const PANEL_WIDTHS_KEY = "devtopflow.panelWidths";
const TERMINAL_HEIGHT_KEY = "devtopflow.terminalHeight";
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export default function App() {
  // Read synchronously so the very first render already knows which folder's
  // chat history to load — avoids a flash of the wrong (or "no folder")
  // session list before the async listDir() for rootEntries resolves.
  const [projectRoot, setProjectRoot] = useState<string | undefined>(
    () => localStorage.getItem(PROJECT_ROOT_KEY) ?? undefined
  );
  // Bumped whenever files may have changed on disk — the Explorer re-lists
  // the root and every expanded folder in response.
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  // Cached separately from rootEntries (which is just the top level, for the
  // sidebar) — this is the full recursive tree text sent to the model, built
  // once per folder-open/refresh instead of on every single model turn.
  const [cachedFileTree, setCachedFileTree] = useState("");

  // Draggable panel widths, like VS Code's sidebar/panel splitters.
  const loadPanelWidths = (): { sidebar: number; chat: number } => {
    try {
      const raw = localStorage.getItem(PANEL_WIDTHS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore, fall through to defaults
    }
    return { sidebar: 240, chat: 320 };
  };
  const initialPanelWidths = useMemo(loadPanelWidths, []);
  const [sidebarWidth, setSidebarWidth] = useState(initialPanelWidths.sidebar);
  const [chatWidth, setChatWidth] = useState(initialPanelWidths.chat);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const panelWidthsRef = useRef({ sidebar: sidebarWidth, chat: chatWidth });
  panelWidthsRef.current = { sidebar: sidebarWidth, chat: chatWidth };

  // Same 3-column grid as before (sidebar | editor | chat) — dragging just
  // changes the pixel widths in that template; it doesn't add extra tracks.
  const effectiveSidebarWidth = sidebarCollapsed ? 0 : sidebarWidth;
  const effectiveChatWidth = chatCollapsed ? 0 : chatWidth;

  const startResize = (which: "sidebar" | "chat") => (e: React.MouseEvent) => {
    e.preventDefault();
    if (which === "sidebar" && sidebarCollapsed) return;
    if (which === "chat" && chatCollapsed) return;
    const startX = e.clientX;
    const startSidebar = sidebarWidth;
    const startChat = chatWidth;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      if (which === "sidebar") {
        setSidebarWidth(clamp(startSidebar + delta, 180, 480));
      } else {
        setChatWidth(clamp(startChat - delta, 240, 600));
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(panelWidthsRef.current));
      } catch {
        // best-effort
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Integrated terminal (VS Code-style): hideable panel below the editor,
  // its own PTY session that survives show/hide toggles.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalStarted, setTerminalStarted] = useState(false);
  useEffect(() => {
    if (terminalOpen) setTerminalStarted(true);
  }, [terminalOpen]);
  const [terminalHeight, setTerminalHeight] = useState<number>(() => {
    const raw = localStorage.getItem(TERMINAL_HEIGHT_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : 240;
  });
  const terminalHeightRef = useRef(terminalHeight);
  terminalHeightRef.current = terminalHeight;

  const startTerminalResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = terminalHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY; // dragging up (negative deltaY) grows the panel
      setTerminalHeight(clamp(startHeight + delta, 120, 600));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      localStorage.setItem(TERMINAL_HEIGHT_KEY, String(terminalHeightRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  interface OpenTab {
    path: string;
    content: string;
    savedContent: string;
    /** Raster images (jpg/png/gif/…) are view-only — no Monaco, no editing, no saving. */
    imageSrc?: string;
  }
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string>();
  const [selection, setSelection] = useState("");

  const activeTab = openTabs.find((t) => t.path === activeTabPath);
  const openPath = activeTab?.path;
  const editorValue = activeTab?.content ?? "";

  const [apiKeys, setApiKeys] = useState<Record<ApiKeyProvider, string | undefined>>({
    anthropic: undefined,
    openai: undefined,
    deepseek: undefined,
  });
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  // null = not checked yet; the panel shows "checking…" rather than a false "not running".
  const [ollamaRunning, setOllamaRunning] = useState<boolean | null>(null);
  const [ollamaError, setOllamaError] = useState<string | undefined>(undefined);
  const [ollamaBaseUrl, setOllamaBaseUrlState] = useState<string>(loadOllamaBaseUrl);
  // Auto-detection only runs once at launch and misses Ollama started (or a
  // model pulled) afterward — this manual list, entered in the API Keys
  // panel, is the reliable fallback and is merged with whatever gets detected.
  const [manualOllamaModels, setManualOllamaModels] = useState<string[]>(loadManualOllamaModels);
  const effectiveOllamaModels = useMemo(
    () => Array.from(new Set([...ollamaModels, ...manualOllamaModels])),
    [ollamaModels, manualOllamaModels]
  );
  const addManualOllamaModel = (model: string) => {
    setManualOllamaModels((prev) => {
      if (prev.includes(model)) return prev;
      const next = [...prev, model];
      saveManualOllamaModels(next);
      return next;
    });
  };
  const refreshOllamaModels = (baseUrl = ollamaBaseUrl) =>
    checkOllamaStatus(baseUrl).then(({ running, models, error }) => {
      setOllamaRunning(running);
      setOllamaModels(models);
      setOllamaError(error);
    });
  const changeOllamaBaseUrl = (baseUrl: string) => {
    setOllamaBaseUrlState(baseUrl);
    saveOllamaBaseUrl(baseUrl);
    refreshOllamaModels(baseUrl);
  };
  const removeManualOllamaModel = (model: string) => {
    setManualOllamaModels((prev) => {
      const next = prev.filter((m) => m !== model);
      saveManualOllamaModels(next);
      return next;
    });
  };
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Appearance: theme applied via a data-theme attribute (styles.css keys its
  // light-mode variable overrides off it) so plain CSS handles the repaint —
  // no per-component theme prop threading needed. Language switching is a
  // separate concern (lib/i18n.tsx's I18nProvider), read here only to hand
  // Monaco/the editor pane whichever theme it should render its own chrome in.
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    saveTheme(next);
  };
  const { locale, setLocale, t } = useI18n();
  const toggleLocale = () => setLocale(locale === "en" ? "th" : "en");
  // One running task per chat (keyed by session id), covering the entire
  // task — every model turn, agentic read round trip, and file-writing pass —
  // not just the gap before the first token. Per chat rather than global, so
  // switching chats mid-task never shows one chat's status in another.
  const [tasks, setTasks] = useState<Record<string, TaskStatus>>({});
  const taskControllersRef = useRef(new Map<string, AbortController>());
  const patchTask = (sessionId: string, patch: Partial<TaskStatus>) =>
    setTasks((prev) => (prev[sessionId] ? { ...prev, [sessionId]: { ...prev[sessionId], ...patch } } : prev));
  const stopTask = (sessionId: string) => taskControllersRef.current.get(sessionId)?.abort();

  // Agent Control Panel (agent-control-panel-prompt.md): the global default
  // lives in localStorage; a project folder gets its own on-disk copy (like
  // chat history) that takes precedence while that folder is open; a single
  // chat can additionally override the effective settings for itself alone.
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [baseAgentSettings, setBaseAgentSettings] = useState<AgentSettings>(loadGlobalAgentSettings);
  const [settingsScope, setSettingsScope] = useState<"global" | "chat">("global");

  // The runaway/overrun supervisor's warning banner (agent-control-panel-prompt.md
  // §2) when a task ends for a reason other than the user asking it to stop.
  const [supervisorWarning, setSupervisorWarning] = useState<{ reason: SupervisorStopReason; sessionId: string }>();

  // Privacy disclosure: shown automatically the first time a given folder is
  // opened (so folder access is never silent), and reopenable any time via
  // ⌘⇧P or the Home menu.
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const loadConsentedFolders = (): Set<string> => {
    try {
      const raw = localStorage.getItem(PRIVACY_CONSENTED_KEY);
      if (raw) return new Set(JSON.parse(raw));
    } catch {
      // ignore, fall through to empty set
    }
    return new Set();
  };
  const markFolderConsented = (folder: string) => {
    const set = loadConsentedFolders();
    set.add(folder);
    localStorage.setItem(PRIVACY_CONSENTED_KEY, JSON.stringify([...set]));
  };
  const [budgetPanelOpen, setBudgetPanelOpen] = useState(false);

  const [discoveredModels, setDiscoveredModels] = useState<{
    anthropic: string[];
    openai: string[];
    deepseek: string[];
  }>({ anthropic: [], openai: [], deepseek: [] });
  const [modelsLoading, setModelsLoading] = useState(false);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);

  // Once a key is present, ask that provider what models it actually has
  // (build plan §4.4) instead of assuming a single hardcoded model id.
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    Promise.all([
      apiKeys.anthropic ? listAnthropicModels(apiKeys.anthropic) : Promise.resolve([]),
      apiKeys.openai ? listOpenAICompatibleModels("https://api.openai.com/v1", apiKeys.openai) : Promise.resolve([]),
      apiKeys.deepseek ? listOpenAICompatibleModels("https://api.deepseek.com/v1", apiKeys.deepseek) : Promise.resolve([]),
    ]).then(([anthropic, openai, deepseek]) => {
      if (cancelled) return;
      setDiscoveredModels({ anthropic, openai, deepseek });
      setModelsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [apiKeys.anthropic, apiKeys.openai, apiKeys.deepseek]);

  const providers = useMemo(
    () =>
      buildProviderRegistry({
        anthropicKey: apiKeys.anthropic,
        anthropicModels: discoveredModels.anthropic,
        openaiKey: apiKeys.openai,
        openaiModels: discoveredModels.openai,
        deepseekKey: apiKeys.deepseek,
        deepseekModels: discoveredModels.deepseek,
        ollamaModels: effectiveOllamaModels,
        ollamaBaseUrl,
      }),
    [apiKeys, discoveredModels, effectiveOllamaModels, ollamaBaseUrl]
  );
  const [activeProviderId, setActiveProviderId] = useState<string | undefined>(
    () => localStorage.getItem(ACTIVE_PROVIDER_KEY) ?? undefined
  );
  const activeProvider = providers.find((p) => p.id === activeProviderId) ?? providers[0];

  const selectProvider = (id: string) => {
    setActiveProviderId(id);
    localStorage.setItem(ACTIVE_PROVIDER_KEY, id);
  };

  // Chat threads (build plan §7 "project-level AI memory" adjacent — here it's
  // conversation memory), scoped per project folder: opening a different
  // folder shows that folder's own history, not whatever was open before, and
  // is saved *inside that folder* (.devtopflow/chat-history.json) so it
  // travels with the project. "New Chat" starts a fresh thread without
  // deleting earlier ones; deleting a thread is a separate, confirmed action.
  const placeholderSession = useMemo(newSession, []);
  const [sessions, setSessions] = useState<ChatSession[]>([placeholderSession]);
  const [activeSessionId, setActiveSessionId] = useState<string>(placeholderSession.id);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const sessionsRootRef = useRef<string | undefined>(undefined);

  interface PendingAttachment {
    message: ChatMessage;
    label: string;
  }
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const addPendingAttachment = (message: ChatMessage, label: string) =>
    setPendingAttachments((prev) => [...prev, { message, label }]);
  const removePendingAttachment = (index: number) =>
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));

  const messages = activeSession.messages;
  const activeTask = tasks[activeSessionId];
  const isSending = !!activeTask;
  const anyTaskRunning = Object.keys(tasks).length > 0;
  /** Forces every in-flight step of this chat's task to stop — the model turn, any read round trip, file writes. Wired to the Stop control, Esc, ⌘C, and the @stop chat command. */
  const stopCurrentTask = () => stopTask(activeSessionId);
  const messageCosts = activeSession.messageCosts;
  const sessionCost = activeSession.sessionCost;

  // Effective settings = the global/project base, with this chat's own
  // overrides (if any) layered on top — never the other way around, so a
  // per-chat override always wins for that chat alone.
  const hasChatOverride = !!activeSession.settingsOverride && Object.keys(activeSession.settingsOverride).length > 0;
  const effectiveAgentSettings: AgentSettings = useMemo(
    () => ({ ...baseAgentSettings, ...activeSession.settingsOverride }),
    [baseAgentSettings, activeSession.settingsOverride]
  );

  const updateAgentSettings = (patch: Partial<AgentSettings>) => {
    if (settingsScope === "chat") {
      updateSession(activeSessionId, (s) => ({ ...s, settingsOverride: { ...s.settingsOverride, ...patch } }));
      return;
    }
    setBaseAgentSettings((prev) => {
      const next = { ...prev, ...patch };
      saveGlobalAgentSettings(next);
      saveProjectAgentSettings(projectRoot, next);
      return next;
    });
  };

  const applyAgentPreset = (preset: AgentSettings) => {
    if (settingsScope === "chat") {
      updateSession(activeSessionId, (s) => ({ ...s, settingsOverride: { ...preset } }));
      return;
    }
    setBaseAgentSettings(preset);
    saveGlobalAgentSettings(preset);
    saveProjectAgentSettings(projectRoot, preset);
  };

  const clearChatSettingsOverride = () => {
    updateSession(activeSessionId, (s) => ({ ...s, settingsOverride: undefined }));
  };

  // Budget monitoring: total spend across every folder/chat, not just the
  // active one, against an optional user-set limit (build plan §8).
  const [budget, setBudget] = useState<BudgetState>(loadBudget);
  const addSpend = (usd: number, thb: number) => {
    setBudget((prev) => {
      const next = { ...prev, totalUsd: prev.totalUsd + usd, totalThb: prev.totalThb + thb };
      saveBudget(next);
      return next;
    });
  };
  const setBudgetLimit = (limitUsd: number) => {
    setBudget((prev) => {
      const next = { ...prev, limitUsd };
      saveBudget(next);
      return next;
    });
  };
  const resetBudgetSpend = () => {
    if (!confirm(`Reset tracked spend? This clears the running total ($${budget.totalUsd.toFixed(4)} tracked so far) — it does not affect chat history.`)) return;
    setBudget((prev) => {
      const next = { ...prev, totalUsd: 0, totalThb: 0 };
      saveBudget(next);
      return next;
    });
  };

  // Chat history is written at most every 800ms (with a trailing write), not
  // on every state change — streaming used to rewrite the whole history file
  // to disk once per token, which is what made long replies stutter.
  const pendingSaveRef = useRef<{ root: string | undefined; sessions: ChatSession[]; activeId: string }>();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const flushSessionSave = () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = undefined;
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = undefined;
    if (pending) saveSessions(pending.root, pending.sessions, pending.activeId);
  };

  useEffect(() => {
    // Skip saving until the first real load resolves — otherwise this fires
    // with the throwaway placeholder session and clobbers real history.
    if (sessionsLoading) return;
    const root = sessionsRootRef.current;
    if (pendingSaveRef.current && pendingSaveRef.current.root !== root) flushSessionSave();
    pendingSaveRef.current = { root, sessions, activeId: activeSessionId };
    if (!saveTimerRef.current) saveTimerRef.current = setTimeout(flushSessionSave, 800);
  }, [sessions, activeSessionId, sessionsLoading]);

  useEffect(() => {
    window.addEventListener("beforeunload", flushSessionSave);
    return () => window.removeEventListener("beforeunload", flushSessionSave);
  }, []);

  // Load (or reload, on folder switch) the chat history for whichever
  // folder is open — from that folder's own .devtopflow/chat-history.json
  // if there is one, else the app's local no-folder storage.
  useEffect(() => {
    let cancelled = false;
    // Persist the previous folder's history before swapping it out, and stop
    // any task still writing into it.
    flushSessionSave();
    taskControllersRef.current.forEach((c) => c.abort());
    setSessionsLoading(true);
    loadSessions(projectRoot).then((next) => {
      if (cancelled) return;
      sessionsRootRef.current = projectRoot;
      setSessions(next.sessions);
      setActiveSessionId(next.activeId);
      setPendingAttachments([]);
      setSessionsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  // Agent Settings: a project folder's own .devtopflow/settings.json (if it
  // has one) takes precedence over the app-global default while that folder
  // is open — same pattern as chat history.
  useEffect(() => {
    let cancelled = false;
    loadProjectAgentSettings(projectRoot).then((found) => {
      if (cancelled) return;
      setBaseAgentSettings(found ?? loadGlobalAgentSettings());
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  const updateSession = (id: string, updater: (s: ChatSession) => ChatSession) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? updater(s) : s)));
  };

  const refreshKeys = () => loadAllApiKeys().then(setApiKeys);

  useEffect(() => {
    refreshKeys();
    refreshOllamaModels();

    // Reopen the last project folder automatically — otherwise every chat
    // (old or new) looks like it "lost" directory access after a restart,
    // since projectRoot would silently reset to none.
    if (projectRoot) {
      setIsOpeningFolder(true);
      listDir(projectRoot)
        .then(() => buildFileTree(projectRoot))
        .then(setCachedFileTree)
        .catch((e) => {
          // Folder moved/deleted/inaccessible since last time — drop it
          // rather than repeatedly failing to reopen it on every launch.
          console.error(`DevTop Flow: couldn't reopen last folder "${projectRoot}", clearing it.`, e);
          localStorage.removeItem(PROJECT_ROOT_KEY);
          setProjectRoot(undefined);
        })
        .finally(() => setIsOpeningFolder(false));
    }
  }, []);

  // WebView2's own native right-click menu (Back/Forward/Reload/Inspect) can
  // otherwise show instead of — or on top of — a custom one like the
  // Explorer's "Reveal in File Explorer" menu. Suppress it app-wide, except
  // over actually-editable regions (inputs, Monaco) where a context menu is
  // expected and useful (cut/copy/paste).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable = target?.closest("input, textarea, [contenteditable='true'], .monaco-editor");
      if (!isEditable) e.preventDefault();
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  useEffect(() => {
    // Only fall back if there's no remembered choice, or the remembered one
    // is no longer available — never override an already-valid selection.
    if (providers.length === 0) return;
    if (activeProviderId && providers.some((p) => p.id === activeProviderId)) return;
    // Discovered-model refresh regenerates provider ids from whatever the API
    // just returned — e.g. deepseek's static fallback ids ("deepseek-chat")
    // never match its real /models response ("deepseek-v4-…"), so the id the
    // user had selected stops existing in `providers` the moment the real
    // list loads. Falling straight to providers[0] would silently jump the
    // selection to a different vendor entirely (e.g. Anthropic) — stay on the
    // same vendor instead, so refreshing one provider's models doesn't make
    // another provider's picker selection "disappear".
    const vendor = activeProviderId?.split(":")[0];
    const sameVendor = vendor ? providers.find((p) => p.id.startsWith(`${vendor}:`)) : undefined;
    const next = sameVendor ?? providers[0];
    setActiveProviderId(next.id);
    localStorage.setItem(ACTIVE_PROVIDER_KEY, next.id);
  }, [providers, activeProviderId]);

  const openFolder = async () => {
    const folder = await pickProjectFolder();
    if (!folder) return;
    // Opening "/" (or a volume root) as a project isn't meaningful for an
    // IDE and reliably breaks the auto-reopen-on-launch flow — refuse it
    // outright rather than silently failing on the next startup.
    const normalized = folder.replace(/[\\/]+$/, "");
    if (normalized === "" || /^\/Volumes\/[^/]+$/.test(normalized) || /^[a-zA-Z]:$/.test(normalized)) {
      alert(`"${folder}" is a drive root, not a project folder. Please pick a specific folder inside it instead.`);
      return;
    }
    setIsOpeningFolder(true);
    try {
      await listDir(folder); // fails fast on an unreadable folder, before switching to it
      setProjectRoot(folder);
      setCachedFileTree(await buildFileTree(folder));
      localStorage.setItem(PROJECT_ROOT_KEY, folder);
      if (!loadConsentedFolders().has(folder)) {
        markFolderConsented(folder);
        setPrivacyOpen(true);
      }
    } catch (e) {
      alert(
        `Couldn't read "${folder}": ${e instanceof Error ? e.message : String(e)}\n\n` +
          `If this is a protected folder (Desktop/Documents/Downloads), macOS may need you to grant DevTop Flow access under System Settings → Privacy & Security → Files and Folders.`
      );
    } finally {
      setIsOpeningFolder(false);
    }
  };

  const refreshTree = async () => {
    if (!projectRoot) return;
    setIsOpeningFolder(true);
    try {
      setTreeRefreshKey((k) => k + 1);
      setCachedFileTree(await buildFileTree(projectRoot));
    } finally {
      setIsOpeningFolder(false);
    }
  };

  /** New-file creation from the Explorer (root or a specific folder), VS Code-style. */
  const createNewFile = async (dirPath: string, fileName: string) => {
    const sep = dirPath.includes("\\") ? "\\" : "/";
    const fullPath = `${dirPath.replace(/[\\/]+$/, "")}${sep}${fileName}`;
    if (/\.(png|jpe?g)$/i.test(fileName)) {
      // A zero-byte .png/.jpg isn't an image any viewer can open — this app's
      // own preview included. Write a real blank canvas of that format instead.
      const blank = await renderBlankImage(1024, 1024, formatFromPath(fileName));
      await createBinaryFile(fullPath, base64ToBytes(blank.base64));
    } else {
      await createFile(fullPath, "");
    }
    await refreshTree();
    await openFile(fullPath);
  };

  const openFile = async (path: string) => {
    setSelection("");
    if (openTabs.some((t) => t.path === path)) {
      setActiveTabPath(path);
      return;
    }
    if (isRasterImagePath(path)) {
      const imageSrc = await readImageAsDataUrl(path);
      setOpenTabs((prev) => [...prev, { path, content: "", savedContent: "", imageSrc }]);
    } else {
      const content = await readFile(path);
      setOpenTabs((prev) => [...prev, { path, content, savedContent: content }]);
    }
    setActiveTabPath(path);
  };

  /**
   * Called after the agent writes image files. A tab already open on one of
   * those paths is still showing the previous bytes (openFile short-circuits
   * when the path is already open), so those get re-read in place; then the
   * first new image is surfaced, so a generated image is visible immediately
   * instead of having to be hunted down in the Explorer.
   */
  const showCreatedImages = async (paths: string[]) => {
    if (paths.length === 0) return;
    const refreshed = new Map<string, string>();
    for (const path of paths) {
      try {
        refreshed.set(path, await readImageAsDataUrl(path));
      } catch {
        // unreadable for some reason — leave whatever that tab already shows
      }
    }
    setOpenTabs((prev) => prev.map((t) => (refreshed.has(t.path) ? { ...t, imageSrc: refreshed.get(t.path) } : t)));
    await openFile(paths[0]);
  };

  /** Explorer rename/move: open tabs for that file (or anything inside that folder) follow it to the new path. */
  const handlePathMoved = (oldPath: string, newPath: string) => {
    setOpenTabs((prev) =>
      prev.map((t) => (isSameOrDescendant(t.path, oldPath) ? { ...t, path: rebasePath(t.path, oldPath, newPath) } : t))
    );
    setActiveTabPath((p) => (p && isSameOrDescendant(p, oldPath) ? rebasePath(p, oldPath, newPath) : p));
  };

  /** Explorer delete: close tabs for anything that was moved to the Trash. */
  const handlePathDeleted = (path: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => !isSameOrDescendant(t.path, path));
      if (activeTabPath && isSameOrDescendant(activeTabPath, path)) setActiveTabPath(next[0]?.path);
      return next;
    });
  };

  const closeTab = (path: string) => {
    setOpenTabs((prev) => {
      const closingIndex = prev.findIndex((t) => t.path === path);
      const next = prev.filter((t) => t.path !== path);
      if (activeTabPath === path) {
        const fallback = next[closingIndex] ?? next[closingIndex - 1];
        setActiveTabPath(fallback?.path);
      }
      return next;
    });
  };

  const saveActiveFile = async () => {
    if (!activeTab || activeTab.imageSrc) return;
    await writeFile(activeTab.path, activeTab.content);
    setOpenTabs((prev) =>
      prev.map((t) => (t.path === activeTab.path ? { ...t, savedContent: activeTab.content } : t))
    );
  };

  const saveActiveFileAs = async () => {
    if (!activeTab || activeTab.imageSrc) return;
    const target = await save({ defaultPath: activeTab.path });
    if (!target) return;
    await writeFile(target, activeTab.content);
    setOpenTabs((prev) => [...prev, { path: target, content: activeTab.content, savedContent: activeTab.content }]);
    setActiveTabPath(target);
    if (projectRoot && target.startsWith(`${projectRoot}/`)) {
      await refreshTree();
    }
  };

  // Native macOS menu bar (Home: Open/Save/Save As/Exit). Built once — the
  // actions below are indirected through refs so they always call whichever
  // tab/folder is current, without needing to rebuild the native menu itself
  // every time the active tab changes.
  const openFolderRef = useRef(openFolder);
  openFolderRef.current = openFolder;
  const saveActiveFileRef = useRef(saveActiveFile);
  saveActiveFileRef.current = saveActiveFile;
  const saveActiveFileAsRef = useRef(saveActiveFileAs);
  saveActiveFileAsRef.current = saveActiveFileAs;

  useEffect(() => {
    buildAppMenu({
      onOpenFolder: () => openFolderRef.current(),
      onTogglePrivacy: () => setPrivacyOpen((v) => !v),
      onSave: () => saveActiveFileRef.current(),
      onSaveAs: () => saveActiveFileAsRef.current(),
    });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveActiveFile();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPrivacyOpen((v) => !v);
      }
      // Terminal-style force-quit: Cmd+C (Ctrl+C) interrupts whatever the
      // agent is doing, anywhere in the app — not just the chat input. Only
      // hijacks Cmd+C while a task is actually running and nothing is
      // selected, so copying text out of a streaming reply still works.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "c" &&
        isSending &&
        !window.getSelection()?.toString()
      ) {
        e.preventDefault();
        stopCurrentTask();
      }
      // Ctrl+` (backtick) toggles the integrated terminal — VS Code's own shortcut for it.
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        setTerminalOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const toRelativePath = (p: string) => (projectRoot ? p.replace(`${projectRoot}/`, "") : p);
  const relativePath = openPath ? toRelativePath(openPath) : undefined;

  const editorTabs: EditorTab[] = openTabs.map((t) => ({
    path: t.path,
    relativePath: toRelativePath(t.path),
    dirty: t.content !== t.savedContent,
  }));

  const attachActiveFile = () => {
    if (!openPath) return;
    if (activeTab?.imageSrc) {
      // An open design mockup (jpg/png/…) — attach it as a real image so a
      // vision-capable model can actually look at it, not just its filename.
      const msg = buildImageAttachmentMessage(relativePath ?? openPath, activeTab.imageSrc);
      addPendingAttachment(msg, `image: ${relativePath ?? openPath}`);
      return;
    }
    const msg = buildFileContextMessage({
      relativePath: relativePath ?? openPath,
      languageId: languageFromPath(openPath),
      content: editorValue,
      selection,
    });
    addPendingAttachment(msg, (selection.trim() ? "Selection from " : "") + relativePath);
  };

  /** Attaches every file the user picks in one go — not limited to a single file. */
  const attachFilesFromDisk = async () => {
    const paths = await pickAnyFiles();
    if (paths.length > effectiveAgentSettings.maxAutoAttachFiles) {
      const ok = confirm(
        `You selected ${paths.length} files, but "Max files to auto-attach" in Agent Settings is set to ${effectiveAgentSettings.maxAutoAttachFiles}. Attach all ${paths.length} anyway?`
      );
      if (!ok) return;
    }
    for (const path of paths) {
      const label = projectRoot && path.startsWith(`${projectRoot}/`) ? toRelativePath(path) : path;
      try {
        if (isRasterImagePath(path)) {
          const dataUrl = await readImageAsDataUrl(path);
          addPendingAttachment(buildImageAttachmentMessage(label, dataUrl), `image: ${label}`);
          continue;
        }
        const content = await readFile(path);
        const msg = buildFileContextMessage({ relativePath: label, languageId: languageFromPath(path), content });
        addPendingAttachment(msg, label);
      } catch (e) {
        alert(`Couldn't read "${path}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  /** Cmd+V / Ctrl+V a copied image straight into the chat input — same attach flow, no save-to-disk detour needed. */
  const attachPastedImage = (dataUrl: string) => {
    const msg = buildImageAttachmentMessage("pasted-image.png", dataUrl);
    addPendingAttachment(msg, "image: pasted-image.png");
  };

  const newChat = () => {
    // Non-destructive: starts a fresh thread and switches to it. The old
    // thread stays in `sessions`, reachable from the history list.
    const fresh = newSession();
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setPendingAttachments([]);
    setSupervisorWarning(undefined);
  };

  const switchSession = (id: string) => {
    setActiveSessionId(id);
    setPendingAttachments([]);
    setSupervisorWarning(undefined);
  };

  const deleteSession = (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    const ok = confirm(
      `Delete "${target.title}"? This can't be undone${
        target.sessionCost.usd > 0
          ? ` — it's tracking $${target.sessionCost.usd.toFixed(4)} / ฿${target.sessionCost.thb.toFixed(2)} in usage.`
          : "."
      }`
    );
    if (!ok) return;
    stopTask(id);

    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (id === activeSessionId) {
        if (next.length > 0) {
          setActiveSessionId(next[0].id);
        } else {
          const fresh = newSession();
          setActiveSessionId(fresh.id);
          return [fresh];
        }
      }
      return next;
    });
  };

  /**
   * Runs one full agent task (every model turn, agentic read round trip, and
   * file-writing pass) for one chat, under the runaway/overrun supervisor
   * (agent-control-panel-prompt.md §2): bounded turns, bounded tool calls per
   * turn, a per-turn no-activity watcher, and a repeated-identical-read loop
   * detector. `bypassLimits` is set only by "Resume anyway" after a supervisor
   * stop — the manual Stop/Esc/⌘C/@stop path always still works.
   *
   * Every line this adds to the transcript goes through `trailing`, so the
   * final state is always exactly what the task produced — partial answer,
   * error, or stop notice — with UI-only lines tagged `meta` so they're never
   * sent back to the model on the next turn.
   */
  const runAgentTask = async (
    sessionId: string,
    priorTurns: ChatMessage[],
    effSettings: AgentSettings,
    bypassLimits: boolean
  ) => {
    if (taskControllersRef.current.has(sessionId)) return; // already running in this chat

    const setMessages = (msgs: ChatMessage[]) =>
      updateSession(sessionId, (s) => ({
        ...s,
        messages: msgs,
        title: s.title === "New Chat" ? deriveTitle(msgs) : s.title,
      }));

    const trailing: ChatMessage[] = [];
    // Streaming deltas are batched to one transcript update per frame.
    let renderQueued = false;
    const flush = () => {
      renderQueued = false;
      setMessages([...priorTurns, ...trailing]);
    };
    const render = (immediate = false) => {
      if (immediate) return flush();
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(flush);
    };
    render(true);

    const provider = activeProvider;
    if (!provider) {
      trailing.push({ role: "assistant", content: t("chat.noModelHint"), meta: "error" });
      render(true);
      return;
    }

    const controller = new AbortController();
    taskControllersRef.current.set(sessionId, controller);
    let abortReason: SupervisorStopReason | undefined;
    const supervisorAbort = (reason: SupervisorStopReason) => {
      if (controller.signal.aborted) return;
      abortReason = reason;
      controller.abort();
    };
    // Rejects the moment the task is aborted — raced against each provider
    // call so a stop takes effect immediately even if the underlying HTTP
    // stream doesn't notice the abort signal right away.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
    aborted.catch(() => {});

    // An attached image adds real upload time on top of the provider's own
    // (slower, for vision) time-to-first-token — give it a bigger window
    // before calling it a stall.
    const hasImage = priorTurns.some((m) => !!m.image);
    const turnTimeoutMs = hasImage ? effSettings.turnTimeoutMs * 2 : effSettings.turnTimeoutMs;
    let outputTokensSoFar = 0;

    setTasks((prev) => ({
      ...prev,
      [sessionId]: { phase: "connecting", startedAt: Date.now(), turn: 1, outputTokens: 0, timeoutMs: turnTimeoutMs },
    }));

    interface TurnResult {
      text: string;
      failed: boolean;
    }

    const runTurn = async (agentContext: ChatMessage[], turn: number): Promise<TurnResult> => {
      const systemMessages: ChatMessage[] = [
        buildToolCapabilityMessage(
          projectRoot,
          cachedFileTree,
          effSettings.includeWorkspaceTree,
          // Generative images need the OpenAI key; the SVG→PNG path never does.
          !!apiKeys.openai
        ),
      ];
      if (effSettings.systemPromptOverride.trim()) {
        systemMessages.push({ role: "system", content: effSettings.systemPromptOverride.trim() });
      }
      // The open editor file, freshly read on every turn — not saved into
      // chat history, since its content can change turn to turn.
      const autoFileContext: ChatMessage[] =
        effSettings.includeOpenFile && openPath && !activeTab?.imageSrc
          ? [
              buildFileContextMessage({
                relativePath: relativePath ?? openPath,
                languageId: languageFromPath(openPath),
                content: editorValue,
                selection,
              }),
            ]
          : [];
      const requestMessages = [
        ...systemMessages,
        ...toRequestMessages(priorTurns),
        ...autoFileContext,
        ...agentContext,
      ];

      const assistantIndex = priorTurns.length + trailing.length;
      trailing.push({ role: "assistant", content: "" });
      render(true);

      let phase: AgentPhase = "connecting";
      const setPhase = (next: AgentPhase) => {
        if (phase === next) return;
        phase = next;
        patchTask(sessionId, { phase: next });
      };
      patchTask(sessionId, { phase: "connecting", turn, detail: undefined, stalledSince: undefined });

      let text = "";
      let sawThinking = false;
      let stopReason: string | undefined;
      let reportedOutputTokens = 0;
      let lastTokenPatch = 0;

      const stall = createStallWatcher({
        timeoutMs: turnTimeoutMs,
        onWarn: () => patchTask(sessionId, { stalledSince: Date.now() }),
        onRecovered: () => patchTask(sessionId, { stalledSince: undefined }),
        onTimeout: () => supervisorAbort({ kind: "turn-stall" }),
      });

      const onChunk = (chunk: StreamChunk) => {
        if (controller.signal.aborted) return;
        stall.ping();
        if (chunk.activity === "connected" && phase === "connecting") setPhase("waiting");
        if (chunk.thinking) {
          sawThinking = true;
          if (phase !== "streaming") setPhase("thinking");
        }
        if (chunk.delta) {
          setPhase("streaming");
          text += chunk.delta;
          trailing[trailing.length - 1] = { role: "assistant", content: text };
          render();
          const now = Date.now();
          if (now - lastTokenPatch > 300) {
            lastTokenPatch = now;
            patchTask(sessionId, { outputTokens: outputTokensSoFar + Math.round(text.length / 4) });
          }
        }
        if (chunk.stopReason) stopReason = chunk.stopReason;
        if (chunk.usage) {
          reportedOutputTokens = chunk.usage.outputTokens ?? 0;
          const cost = estimateCost(provider.vendor, provider.label, chunk.usage);
          updateSession(sessionId, (s) => ({
            ...s,
            messageCosts: { ...s.messageCosts, [assistantIndex]: formatCost(cost) },
            sessionCost: { usd: s.sessionCost.usd + cost.usd, thb: s.sessionCost.thb + cost.thb },
          }));
          addSpend(cost.usd, cost.thb);
        }
      };

      try {
        const request = provider.chat(requestMessages, onChunk, {
          signal: controller.signal,
          temperature: effSettings.temperature,
          maxOutputTokens: effSettings.maxOutputTokens,
          thinkingMode: effSettings.thinkingMode,
          maxThinkingTokens: effSettings.maxThinkingTokens,
        });
        request.catch(() => {}); // if the abort race wins, this still settles later
        await Promise.race([request, aborted]);
      } catch (e) {
        if (controller.signal.aborted) throw e;
        // A real failure (bad key, network error, provider outage, a
        // mid-stream error event) — keep whatever partial answer arrived and
        // say exactly what went wrong.
        const message = e instanceof Error ? e.message : String(e);
        if (!text) trailing.pop();
        trailing.push({
          role: "assistant",
          content: t("chat.requestFailed", { model: provider.label, error: message }),
          meta: "error",
        });
        render(true);
        return { text, failed: true };
      } finally {
        stall.stop();
      }

      outputTokensSoFar += reportedOutputTokens || Math.round(text.length / 4);
      patchTask(sessionId, { outputTokens: outputTokensSoFar });

      if (!text.trim()) {
        trailing.pop();
        trailing.push({
          role: "assistant",
          content: sawThinking ? t("chat.emptyAfterThinking") : t("chat.emptyResponse"),
          meta: "error",
        });
        render(true);
        return { text: "", failed: true };
      }
      render(true);
      if (stopReason === "max_tokens") {
        trailing.push({
          role: "assistant",
          content: t("chat.truncated", { n: effSettings.maxOutputTokens.toLocaleString() }),
          meta: "notice",
        });
        render(true);
      }
      return { text, failed: false };
    };

    const runTask = async () => {
      let turn = 1;
      let result = await runTurn([], turn);
      // Everything the model has seen/said during this task's read loop, so
      // each follow-up turn keeps the earlier files it asked for too.
      let agentContext: ChatMessage[] = [];
      let lastReadHash: string | null = null;
      let stagnantCount = 0;

      // Agentic read loop: the model can ask to see specific files' contents
      // and keep iterating, bounded by the supervisor limits.
      while (projectRoot && !result.failed) {
        const readPaths = extractReadRequests(result.text);
        if (readPaths.length === 0) break;

        if (!bypassLimits && readPaths.length > effSettings.maxToolCallsPerTurn) {
          return supervisorAbort({ kind: "max-tool-calls" });
        }
        const hash = hashReadPaths(readPaths);
        if (hash === lastReadHash) {
          stagnantCount++;
          if (!bypassLimits && stagnantCount >= 2) return supervisorAbort({ kind: "loop-detected" });
        } else {
          stagnantCount = 0;
          lastReadHash = hash;
        }
        if (!bypassLimits && turn >= effSettings.maxTurnsPerTask) {
          return supervisorAbort({ kind: "max-turns" });
        }

        patchTask(sessionId, { phase: "reading", detail: readPaths.join(", ") });
        const readResults = await buildReadResultsMessage(projectRoot, readPaths);
        if (controller.signal.aborted) return;
        agentContext = [...agentContext, { role: "assistant", content: result.text }, readResults];
        turn++;
        result = await runTurn(agentContext, turn);
      }

      if (result.failed) {
        setSupervisorWarning({ reason: { kind: "request-failed" }, sessionId });
        return;
      }

      // File/image blocks from every turn of this task, in order (a later
      // block for the same path simply overwrites an earlier one).
      const taskText = trailing
        .filter((m) => !m.meta)
        .map((m) => m.content)
        .join("\n\n");

      if (projectRoot && /```devtopflow:file/.test(taskText)) {
        const planned = extractFileDirectives(taskText).map((d) => d.path);
        patchTask(sessionId, { phase: "writing", detail: planned.join(", ") });
        const applied = await applyFileDirectives(projectRoot, taskText);
        trailing.push(
          applied.length > 0
            ? {
                role: "assistant",
                meta: applied.every((f) => f.ok) ? "notice" : "error",
                content: applied
                  .map((f) => (f.ok ? `✅ ${t("chat.fileWritten")} \`${f.path}\`` : `❌ \`${f.path}\` — ${f.error}`))
                  .join("\n"),
              }
            : { role: "assistant", meta: "error", content: t("chat.fileBlockUnparsed") }
        );
        render(true);
        if (applied.length > 0) await refreshTree();
      }

      // Image blocks (devtopflow:draw / devtopflow:image) — the only way real
      // .png/.jpg bytes get written. Runs after the text files so images can
      // land in folders those files just created.
      if (projectRoot && /```devtopflow:(image|draw)/.test(taskText)) {
        patchTask(sessionId, { phase: "imaging", detail: undefined });
        const images = await applyImageDirectives(projectRoot, taskText, {
          openaiKey: apiKeys.openai,
          signal: controller.signal,
        });
        const lines: string[] = [];
        for (const img of images) {
          if (!img.ok) {
            lines.push(`❌ \`${img.path}\` — ${img.error}`);
          } else if (img.kind === "drawn") {
            lines.push(`🖼 Created \`${img.path}\` (rendered from ${img.detail})`);
          } else {
            // Generated images are billed per image, not per token — fold
            // them into the same session/budget totals as chat usage.
            const cost = estimateImageCost(img.size ?? "1024x1024", img.quality ?? "medium");
            updateSession(sessionId, (s) => ({
              ...s,
              sessionCost: { usd: s.sessionCost.usd + cost.usd, thb: s.sessionCost.thb + cost.thb },
            }));
            addSpend(cost.usd, cost.thb);
            lines.push(`🖼 Generated \`${img.path}\` (${img.detail}) — ${formatCost(cost)}`);
          }
        }
        trailing.push({
          role: "assistant",
          meta: images.length > 0 && images.every((i) => i.ok) ? "notice" : "error",
          content: lines.length > 0 ? lines.join("\n") : t("chat.imageBlockUnparsed"),
        });
        render(true);
        await refreshTree();
        await showCreatedImages(images.filter((i) => i.ok && i.absolutePath).map((i) => i.absolutePath!));
      }
    };

    try {
      await runTask();
    } catch (e) {
      if (!controller.signal.aborted) {
        trailing.push({
          role: "assistant",
          meta: "error",
          content: t("chat.unexpectedError", { error: e instanceof Error ? e.message : String(e) }),
        });
      }
    } finally {
      if (controller.signal.aborted) {
        const reason = abortReason ?? { kind: "manual" as const };
        const last = trailing[trailing.length - 1];
        if (last && last.role === "assistant" && !last.meta && !last.content.trim()) trailing.pop();
        trailing.push({
          role: "assistant",
          content: t(supervisorStopMessageKey(reason)),
          meta: reason.kind === "manual" ? "notice" : "error",
        });
        if (isResumable(reason)) setSupervisorWarning({ reason, sessionId });
      }
      render(true);
      taskControllersRef.current.delete(sessionId);
      setTasks((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    }
  };

  const handleSend = async (text: string) => {
    if (isSending) return;
    // A hard budget cap, with an explicit override.
    if (budget.limitUsd > 0 && budget.totalUsd >= budget.limitUsd) {
      const proceed = confirm(
        `You've reached your $${budget.limitUsd.toFixed(2)} budget limit (tracked so far: $${budget.totalUsd.toFixed(4)}). Send this message anyway?`
      );
      if (!proceed) return;
    }
    // Every pending attachment becomes a real, visible turn in the transcript
    // right here — sent once, then it's just part of history like any other
    // message, instead of a hidden system prompt silently resent forever.
    const attachments = pendingAttachments;
    const priorTurns = [
      ...messages,
      ...attachments.map((a) => a.message),
      { role: "user" as const, content: text },
    ];
    if (attachments.length > 0) setPendingAttachments([]);
    setSupervisorWarning(undefined);
    await runAgentTask(activeSessionId, priorTurns, effectiveAgentSettings, false);
  };

  /**
   * Retry after a failure, or "Resume anyway" after a supervisor stop:
   * re-runs the task from the last user message (dropping the failed
   * attempt's partial output and notices), with supervisor limits lifted for
   * the resume case. Manual Stop/Esc/⌘C/@stop still works throughout.
   */
  const resumeAnyway = async () => {
    const reason = supervisorWarning?.reason;
    setSupervisorWarning(undefined);
    let lastUser = -1;
    activeSession.messages.forEach((m, i) => {
      if (m.role === "user" && !m.meta) lastUser = i;
    });
    if (lastUser < 0) return;
    const bypass = !!reason && !isRetryable(reason);
    await runAgentTask(activeSessionId, activeSession.messages.slice(0, lastUser + 1), effectiveAgentSettings, bypass);
  };

  // Images cost real tokens too (roughly proportional to resolution) — the
  // text estimate alone would wildly understate an attached screenshot/mockup.
  const estimatedTokens =
    pendingAttachments.length > 0
      ? pendingAttachments.reduce(
          (sum, a) => sum + estimateTokens(a.message.content) + (a.message.image ? 1200 : 0),
          0
        )
      : undefined;

  // Context window check (Agent Settings §Context) — a soft warning, not a
  // truncation: cutting history would break Anthropic's prompt-cache prefix
  // matching, so this just tells the user they're over budget.
  const conversationTokenEstimate =
    messages.reduce((sum, m) => sum + estimateTokens(m.content), 0) + (estimatedTokens ?? 0);
  const overContextLimit = conversationTokenEstimate > effectiveAgentSettings.contextLimit;

  const activeSupervisorWarning =
    supervisorWarning?.sessionId === activeSessionId ? supervisorWarning.reason : undefined;

  return (
    <div
      className="app-shell"
      style={{ gridTemplateColumns: `${effectiveSidebarWidth}px 1fr ${effectiveChatWidth}px` }}
    >
      {(anyTaskRunning || modelsLoading || isOpeningFolder) && (
        <div className={`global-progress ${activeTask?.stalledSince ? "stalled" : ""}`} aria-label="Working" />
      )}
      <div className="titlebar">
        <div className="brand">
          <img src={logo} alt="" className="brand-logo" />
          DevTop Flow
        </div>
        <div className="titlebar-actions">
          <button
            className="titlebar-action"
            onClick={toggleLocale}
            title={t("titlebar.language")}
          >
            {locale === "en" ? "EN" : "ไทย"}
          </button>
          <button
            className="titlebar-action"
            onClick={toggleTheme}
            title={theme === "dark" ? t("titlebar.lightMode") : t("titlebar.darkMode")}
          >
            {theme === "dark" ? "🌙" : "☀️"}
          </button>
          <button className="titlebar-action" onClick={() => setAgentSettingsOpen(true)} title={t("titlebar.agentSettings")}>
            🎛
          </button>
          <button className="titlebar-action" onClick={() => setSettingsOpen(true)} title={t("titlebar.apiKeys")}>
            ⚙
          </button>
        </div>
      </div>
      {!sidebarCollapsed && (
        <Sidebar
          projectRoot={projectRoot}
          activePath={openPath}
          refreshKey={treeRefreshKey}
          onOpenFolder={openFolder}
          onRefresh={refreshTree}
          onOpenFile={openFile}
          onCreateFile={createNewFile}
          onPathMoved={handlePathMoved}
          onPathDeleted={handlePathDeleted}
        />
      )}
      <div className="editor-column">
        <EditorPane
          tabs={editorTabs}
          activeTabPath={activeTabPath}
          language={openPath ? languageFromPath(openPath) : "plaintext"}
          value={editorValue}
          imageSrc={activeTab?.imageSrc}
          theme={theme}
          onSelectTab={setActiveTabPath}
          onCloseTab={closeTab}
          onChange={(v) =>
            setOpenTabs((prev) => prev.map((t) => (t.path === activeTabPath ? { ...t, content: v ?? "" } : t)))
          }
          onSelectionChange={setSelection}
        />
        {terminalOpen && (
          <div className="terminal-resize-handle" onMouseDown={startTerminalResize} />
        )}
        <div style={{ height: terminalOpen ? terminalHeight : 0, flexShrink: 0 }}>
          {(terminalOpen || terminalStarted) && (
            <Suspense fallback={null}>
              <TerminalPanel projectRoot={projectRoot} visible={terminalOpen} />
            </Suspense>
          )}
        </div>
      </div>
      {!chatCollapsed && (
        <ChatPanel
          providers={providers}
          activeProviderId={activeProvider?.id}
          onSelectProvider={selectProvider}
          onSend={handleSend}
          messages={messages}
          messageCosts={messageCosts}
          sessionCost={sessionCost}
          pendingAttachments={pendingAttachments.map((a) => a.label)}
          onAttachContext={attachActiveFile}
          onAttachFromDisk={attachFilesFromDisk}
          onAttachImageData={attachPastedImage}
          onRemoveAttachment={removePendingAttachment}
          taskStatus={activeTask}
          onStop={stopCurrentTask}
          onNewChat={newChat}
          estimatedTokens={estimatedTokens}
          sessions={sessions.map((s) => ({ id: s.id, title: s.title, usd: s.sessionCost.usd, thb: s.sessionCost.thb }))}
          activeSessionId={activeSessionId}
          onSwitchSession={switchSession}
          onDeleteSession={deleteSession}
          projectRoot={projectRoot}
          overContextLimit={overContextLimit}
          contextLimit={effectiveAgentSettings.contextLimit}
          supervisorWarningText={activeSupervisorWarning ? t(supervisorStopMessageKey(activeSupervisorWarning)) : undefined}
          supervisorCanRetry={!!activeSupervisorWarning && isRetryable(activeSupervisorWarning)}
          onResumeAnyway={resumeAnyway}
          onDismissWarning={() => setSupervisorWarning(undefined)}
        />
      )}

      {!sidebarCollapsed && (
        <div
          className="resize-handle-overlay"
          style={{ left: sidebarWidth - 3 }}
          onMouseDown={startResize("sidebar")}
        />
      )}
      {!chatCollapsed && (
        <div
          className="resize-handle-overlay"
          style={{ right: chatWidth - 3 }}
          onMouseDown={startResize("chat")}
        />
      )}

      <div className="statusbar">
        <span>
          DevTop Flow — created by Akanit Kwangkaew (Ph.D){" "}
          <span className="build-timestamp" title={__BUILD_TIME__}>
            · Build: {new Date(__BUILD_TIME__).toLocaleString()}
          </span>
        </span>
        <span className="statusbar-actions">
          <button
            className={`text-btn budget-chip ${
              budget.limitUsd > 0 && budget.totalUsd >= budget.limitUsd
                ? "over"
                : budget.limitUsd > 0 && budget.totalUsd >= budget.limitUsd * 0.8
                ? "near"
                : ""
            }`}
            onClick={() => setBudgetPanelOpen((v) => !v)}
            title={t("statusbar.budgetTooltip")}
          >
            💰 ${budget.totalUsd.toFixed(4)}
            {budget.limitUsd > 0 ? ` / $${budget.limitUsd.toFixed(2)}` : ""}
          </button>
          <button className="text-btn" onClick={() => setSidebarCollapsed((v) => !v)} title={t("statusbar.toggleSidebar")}>
            {sidebarCollapsed ? t("statusbar.sidebarHidden") : t("statusbar.sidebarShown")}
          </button>
          <button className="text-btn" onClick={() => setChatCollapsed((v) => !v)} title={t("statusbar.toggleChat")}>
            {chatCollapsed ? t("statusbar.chatHidden") : t("statusbar.chatShown")}
          </button>
          <button
            className="text-btn"
            onClick={() => setTerminalOpen((v) => !v)}
            title="Toggle terminal (Ctrl+`)"
          >
            {terminalOpen ? "▾ Terminal" : "▸ Terminal"}
          </button>
        </span>

        {budgetPanelOpen && (
          <div className="budget-panel">
            <div className="budget-panel-title">Budget monitor</div>
            <div className="budget-panel-row">
              <span>Total spend</span>
              <span>
                ${budget.totalUsd.toFixed(4)} · ฿{budget.totalThb.toFixed(2)}
              </span>
            </div>
            <div className="budget-panel-row">
              <label htmlFor="budget-limit-input">Limit (USD)</label>
              <input
                id="budget-limit-input"
                type="number"
                min="0"
                step="0.01"
                defaultValue={budget.limitUsd || ""}
                placeholder="No limit"
                onBlur={(e) => setBudgetLimit(parseFloat(e.target.value) || 0)}
              />
            </div>
            {budget.limitUsd > 0 && (
              <div className="budget-bar">
                <div
                  className={`budget-bar-fill ${budget.totalUsd >= budget.limitUsd ? "over" : budget.totalUsd >= budget.limitUsd * 0.8 ? "near" : ""}`}
                  style={{ width: `${Math.min(100, (budget.totalUsd / budget.limitUsd) * 100)}%` }}
                />
              </div>
            )}
            <button className="text-btn danger" onClick={resetBudgetSpend}>
              Reset tracked spend
            </button>
          </div>
        )}
      </div>
      {settingsOpen && (
        <Settings
          hasKey={{
            anthropic: !!apiKeys.anthropic,
            openai: !!apiKeys.openai,
            deepseek: !!apiKeys.deepseek,
          }}
          ollamaModels={manualOllamaModels}
          detectedOllamaModels={ollamaModels}
          ollamaRunning={ollamaRunning}
          ollamaError={ollamaError}
          ollamaBaseUrl={ollamaBaseUrl}
          onOllamaBaseUrlChange={changeOllamaBaseUrl}
          onRefreshOllamaModels={() => refreshOllamaModels()}
          onAddOllamaModel={addManualOllamaModel}
          onRemoveOllamaModel={removeManualOllamaModel}
          onClose={() => setSettingsOpen(false)}
          onKeysChanged={refreshKeys}
        />
      )}
      {privacyOpen && <PrivacyNotice projectRoot={projectRoot} onClose={() => setPrivacyOpen(false)} />}
      {agentSettingsOpen && (
        <AgentSettingsPanel
          settings={effectiveAgentSettings}
          scope={settingsScope}
          hasChatOverride={hasChatOverride}
          onScopeChange={setSettingsScope}
          onClearChatOverride={clearChatSettingsOverride}
          onChange={updateAgentSettings}
          onApplyPreset={applyAgentPreset}
          providers={providers}
          activeProviderId={activeProvider?.id}
          onSelectProvider={selectProvider}
          onManageApiKeys={() => {
            setAgentSettingsOpen(false);
            setSettingsOpen(true);
          }}
          onClose={() => setAgentSettingsOpen(false)}
        />
      )}
    </div>
  );
}

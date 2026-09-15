import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import EditorPane, { EditorTab } from "./components/EditorPane";
import ChatPanel from "./components/ChatPanel";
import TerminalPanel from "./components/TerminalPanel";
import Settings from "./components/Settings";
import PrivacyNotice from "./components/PrivacyNotice";
import AgentSettingsPanel from "./components/AgentSettingsPanel";
import {
  ChatMessage,
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
  FileEntry,
  base64ToBytes,
  buildFileTree,
  createBinaryFile,
  createFile,
  isRasterImagePath,
  languageFromPath,
  listDir,
  pickAnyFiles,
  pickProjectFolder,
  readFile,
  readImageAsDataUrl,
  writeFile,
} from "./lib/fileSystem";
import { buildFileContextMessage, buildImageAttachmentMessage, estimateTokens } from "./lib/contextBuilder";
import {
  applyFileDirectives,
  applyImageDirectives,
  buildReadResultsMessage,
  buildToolCapabilityMessage,
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
  createStallWatcher,
  estimateProgress,
  hashReadPaths,
  isResumable,
  supervisorStopMessage,
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
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
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
  // True for the entire task — every model turn, agentic read round trip,
  // and file-creation pass — not just the gap before the first token.
  const [isSending, setIsSending] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  /** Forces every in-flight step of the current task to stop — the model turn, any read round trip, file writes. Wired to the Stop control, Esc, ⌘C, and the @stop chat command. */
  const stopCurrentTask = () => abortControllerRef.current?.abort();

  // Agent Control Panel (agent-control-panel-prompt.md): the global default
  // lives in localStorage; a project folder gets its own on-disk copy (like
  // chat history) that takes precedence while that folder is open; a single
  // chat can additionally override the effective settings for itself alone.
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [baseAgentSettings, setBaseAgentSettings] = useState<AgentSettings>(loadGlobalAgentSettings);
  const [settingsScope, setSettingsScope] = useState<"global" | "chat">("global");

  // Phase-based progress (agent-control-panel-prompt.md §3), plus the
  // runaway/overrun supervisor's warning banner (§2) when a task is stopped
  // for a reason other than the user manually asking it to stop.
  const [agentPhase, setAgentPhase] = useState<AgentPhase>("idle");
  const [agentProgress, setAgentProgress] = useState(0);
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

  useEffect(() => {
    // Skip saving until the first real load resolves — otherwise this fires
    // with the throwaway placeholder session and clobbers real history.
    if (sessionsLoading) return;
    saveSessions(sessionsRootRef.current, sessions, activeSessionId);
  }, [sessions, activeSessionId, sessionsLoading]);

  // Load (or reload, on folder switch) the chat history for whichever
  // folder is open — from that folder's own .devtopflow/chat-history.json
  // if there is one, else the app's local no-folder storage.
  useEffect(() => {
    let cancelled = false;
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
        .then(setRootEntries)
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
      const entries = await listDir(folder);
      setProjectRoot(folder);
      setRootEntries(entries);
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
      setRootEntries(await listDir(projectRoot));
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
      // hijacks Cmd+C while a task is actually running, so normal copy still
      // works the rest of the time.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "c" && isSending) {
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
   * file-creation pass) under the runaway/overrun supervisor
   * (agent-control-panel-prompt.md §2): bounded turns, bounded tool calls
   * per turn, a per-turn stall watcher, and a repeated-identical-read loop
   * detector. `bypassLimits` is set only by "Resume anyway" after a
   * supervisor stop — the manual Stop/Esc/⌘C/@stop path always still works.
   */
  const runAgentTask = async (
    sessionId: string,
    priorTurns: ChatMessage[],
    effSettings: AgentSettings,
    bypassLimits: boolean
  ) => {
    const setMessages = (msgs: ChatMessage[]) =>
      updateSession(sessionId, (s) => ({
        ...s,
        messages: msgs,
        title: s.title === "New Chat" ? deriveTitle(msgs) : s.title,
      }));
    setMessages(priorTurns);

    if (!activeProvider) {
      setMessages([...priorTurns, { role: "assistant", content: "No model configured yet — add an API key via ⚙ in the sidebar." }]);
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    // Same array reference as `trailing` inside runSendTurns below — mutated
    // in place, so this always reflects whatever streamed in before a stop.
    let latestTrailing: ChatMessage[] = [];
    let abortReason: SupervisorStopReason | undefined;
    const supervisorAbort = (reason: SupervisorStopReason) => {
      if (controller.signal.aborted) return;
      abortReason = reason;
      controller.abort();
    };

    // An attached image adds real, often-slow-network upload time on top of
    // the provider's own (also slower, for vision) time-to-first-token — the
    // stall watcher needs a bigger grace window for that, or a normal image
    // attachment reads as a false "stalled"/timed-out task.
    const hasImage = priorTurns.some((m) => !!m.image);
    const effTurnTimeoutMs = hasImage ? effSettings.turnTimeoutMs * 2 : effSettings.turnTimeoutMs;

    // Absolute last-resort cap, derived from the configured limits — the
    // per-turn stall watcher below catches the common "hung silently" case
    // far sooner than this; this just guarantees the task can never outlive
    // its own settings by an unbounded amount.
    const absoluteTimeoutMs = effSettings.maxTurnsPerTask * effTurnTimeoutMs + 60_000;
    const absoluteTimeoutId = setTimeout(() => supervisorAbort({ kind: "absolute-timeout" }), absoluteTimeoutMs);

    const reportAbortedOutcome = () => {
      const reason = abortReason ?? { kind: "manual" as const };
      setMessages([...priorTurns, ...latestTrailing, { role: "assistant", content: supervisorStopMessage(reason) }]);
      if (isResumable(reason)) setSupervisorWarning({ reason, sessionId });
    };

    setIsSending(true);
    setAgentPhase("parsing");
    setAgentProgress(estimateProgress("parsing", 0, effSettings.maxOutputTokens));
    try {
      await runSendTurns();
      if (controller.signal.aborted) reportAbortedOutcome();
    } catch (e) {
      if (controller.signal.aborted) {
        reportAbortedOutcome();
      } else {
        throw e;
      }
    } finally {
      clearTimeout(absoluteTimeoutId);
      setIsSending(false);
      setAgentPhase("idle");
      setAgentProgress(0);
      abortControllerRef.current = null;
    }

    async function runSendTurns() {
      // Each call below is one model turn; `trailing` accumulates every
      // assistant message added during this task (the initial answer, plus
      // any follow-up turns from agentic file-read round trips).
      const trailing: ChatMessage[] = [];
      latestTrailing = trailing;
      const render = () => setMessages([...priorTurns, ...trailing]);

      const runTurn = async (extraContext: ChatMessage[]): Promise<string> => {
        const toolMessage = buildToolCapabilityMessage(
          projectRoot,
          cachedFileTree,
          effSettings.includeWorkspaceTree,
          // Generative images need the OpenAI key; the SVG→PNG path never does,
          // so it stays offered either way.
          !!apiKeys.openai
        );
        const systemMessages: ChatMessage[] = [toolMessage];
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
        const requestMessages = [...systemMessages, ...priorTurns, ...autoFileContext, ...extraContext];
        const assistantIndex = priorTurns.length + trailing.length;
        trailing.push({ role: "assistant", content: "" });
        render();

        // Tracked locally (not just via the async setAgentPhase state) so the
        // waiting-boost interval below can tell it's been superseded by a
        // stall warning and stop nudging progress upward — a stalled task
        // must show as stalled, not keep fake-progressing toward completion.
        let localPhase: AgentPhase = "waiting";
        const setPhase = (p: AgentPhase) => {
          localPhase = p;
          setAgentPhase(p);
        };
        setPhase("waiting");
        setAgentProgress(estimateProgress("waiting", 0, effSettings.maxOutputTokens));
        // Fallback increment so the bar never looks frozen before the first
        // token arrives.
        let waitingBoost = 0;
        const waitingBoostId = setInterval(() => {
          if (localPhase !== "waiting") return;
          waitingBoost = Math.min(waitingBoost + 0.005, 0.05);
          setAgentProgress(0.1 + waitingBoost);
        }, 500);

        let turnText = "";
        const stall = createStallWatcher({
          timeoutMs: effTurnTimeoutMs,
          onWarn: () => setPhase("stalled"),
          onRecovered: () => setPhase(turnText ? "streaming" : "waiting"),
          onTimeout: () => supervisorAbort({ kind: "turn-stall" }),
        });

        try {
          await activeProvider.chat(
            requestMessages,
            (chunk) => {
              stall.ping();
              if (chunk.delta) {
                if (turnText === "") setPhase("streaming");
                turnText += chunk.delta;
                trailing[trailing.length - 1] = { role: "assistant", content: turnText };
                render();
                setAgentProgress(estimateProgress("streaming", turnText.length / 4, effSettings.maxOutputTokens));
              }
              if (chunk.usage) {
                const cost = estimateCost(activeProvider.vendor, activeProvider.label, chunk.usage);
                updateSession(sessionId, (s) => ({
                  ...s,
                  messageCosts: { ...s.messageCosts, [assistantIndex]: formatCost(cost) },
                  sessionCost: { usd: s.sessionCost.usd + cost.usd, thb: s.sessionCost.thb + cost.thb },
                }));
                addSpend(cost.usd, cost.thb);
              }
            },
            {
              signal: controller.signal,
              temperature: effSettings.temperature,
              maxOutputTokens: effSettings.maxOutputTokens,
              thinkingMode: effSettings.thinkingMode,
              maxThinkingTokens: effSettings.maxThinkingTokens,
            }
          );
        } catch (e) {
          // A real failure (bad key, network error, provider outage) — not a
          // user-initiated stop — used to propagate as an unhandled promise
          // rejection: the reply bubble just stayed empty forever with no
          // visible feedback at all. Abort is already handled elsewhere
          // (reportAbortedOutcome), so only intercept the non-abort case.
          if (controller.signal.aborted) throw e;
          const message = e instanceof Error ? e.message : String(e);
          turnText = `⚠️ Couldn't reach ${activeProvider.label} (${activeProvider.vendor}): ${message}`;
          trailing[trailing.length - 1] = { role: "assistant", content: turnText };
          render();
        } finally {
          stall.stop();
          clearInterval(waitingBoostId);
        }
        return turnText;
      };

      let assistantText = await runTurn([]);
      let turns = 1;
      let lastReadHash: string | null = null;
      let stagnantCount = 0;

      // Agentic read loop: the model can ask to see specific files' contents
      // (rather than just the file tree it was given) and keep iterating,
      // bounded by maxTurnsPerTask/maxToolCallsPerTurn and a loop detector
      // that catches it re-requesting the same file(s) with no new progress.
      while (projectRoot) {
        const readPaths = extractReadRequests(assistantText);
        if (readPaths.length === 0) break;

        if (!bypassLimits && readPaths.length > effSettings.maxToolCallsPerTurn) {
          supervisorAbort({ kind: "max-tool-calls" });
          return;
        }

        const hash = hashReadPaths(readPaths);
        if (hash === lastReadHash) {
          stagnantCount++;
          if (!bypassLimits && stagnantCount >= 2) {
            supervisorAbort({ kind: "loop-detected" });
            return;
          }
        } else {
          stagnantCount = 0;
          lastReadHash = hash;
        }

        if (!bypassLimits && turns >= effSettings.maxTurnsPerTask) {
          supervisorAbort({ kind: "max-turns" });
          return;
        }

        trailing[trailing.length - 1] = {
          role: "assistant",
          content: `🔍 Reading ${readPaths.map((p) => `\`${p}\``).join(", ")}…`,
        };
        render();
        const readResults = await buildReadResultsMessage(projectRoot, readPaths);
        assistantText = await runTurn([{ role: "assistant", content: assistantText }, readResults]);
        turns++;
      }

      setAgentPhase("applying");
      setAgentProgress(estimateProgress("applying", 0, effSettings.maxOutputTokens));
      if (projectRoot && /```devtopflow:file/.test(assistantText)) {
        const applied = await applyFileDirectives(projectRoot, assistantText);
        if (applied.length > 0) {
          const summary = applied
            .map((f) => (f.ok ? `✅ Created \`${f.path}\`` : `❌ \`${f.path}\` — ${f.error}`))
            .join("\n");
          trailing.push({ role: "assistant", content: summary });
          render();
          await refreshTree();
        } else {
          // The model clearly tried to write a file (the literal marker is in
          // the text) but the fenced block didn't parse — surface that instead
          // of silently doing nothing, which is what made this look broken.
          trailing.push({
            role: "assistant",
            content:
              "⚠️ It looks like a file-creation block didn't parse correctly (often caused by a nested ``` fence inside the file's own contents, e.g. a markdown file with code examples). No file was written — try asking again, or ask for that one file on its own.",
          });
          render();
        }
      }

      // Image blocks (devtopflow:draw / devtopflow:image) — the only way real
      // .png/.jpg bytes ever get written, since devtopflow:file writes text.
      // Runs after the text files so a scaffolded project's images land in
      // folders its own files may have just created.
      if (projectRoot && /```devtopflow:(image|draw)/.test(assistantText)) {
        trailing.push({ role: "assistant", content: "🎨 Creating image(s)…" });
        render();
        const images = await applyImageDirectives(projectRoot, assistantText, {
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
            // Generated images are billed per image rather than per token, so
            // they're priced here and folded into the same session/budget
            // totals as chat usage — otherwise they'd spend real money
            // invisibly, outside the budget cap entirely.
            const cost = estimateImageCost(img.size ?? "1024x1024", img.quality ?? "medium");
            updateSession(sessionId, (s) => ({
              ...s,
              sessionCost: { usd: s.sessionCost.usd + cost.usd, thb: s.sessionCost.thb + cost.thb },
            }));
            addSpend(cost.usd, cost.thb);
            lines.push(`🖼 Generated \`${img.path}\` (${img.detail}) — ${formatCost(cost)}`);
          }
        }
        trailing[trailing.length - 1] = {
          role: "assistant",
          content:
            lines.length > 0
              ? lines.join("\n")
              : '⚠️ An image block didn\'t parse correctly — no image was written. Each devtopflow:image / devtopflow:draw block needs a path="…" attribute ending in .png or .jpg on its opening fence.',
        };
        render();
        await refreshTree();
        await showCreatedImages(images.filter((i) => i.ok && i.absolutePath).map((i) => i.absolutePath!));
      }

      setAgentPhase("finalizing");
      setAgentProgress(1);
    }
  };

  const handleSend = async (text: string) => {
    // The budget chip/bar used to be purely informational — going red never
    // actually stopped anything, so a set limit was more of a suggestion
    // than a cap. A hard stop here (with an explicit override, same pattern
    // as the other guard rails in this file) makes it a real cap.
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
   * Re-enters the same task after a supervisor stop (loop/turn/tool-call
   * limit, stall, or the absolute timeout), bypassing those specific limits
   * for this one attempt. Manual Stop/Esc/⌘C/@stop still works mid-resume —
   * only the automatic supervisor limits are lifted, not the ability to stop.
   */
  const resumeAnyway = async () => {
    setSupervisorWarning(undefined);
    await runAgentTask(activeSessionId, activeSession.messages, effectiveAgentSettings, true);
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
      {(isSending || modelsLoading || isOpeningFolder) && (
        <div className={`global-progress ${agentPhase === "stalled" ? "stalled" : ""}`} aria-label="Working" />
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
          rootEntries={rootEntries}
          activePath={openPath}
          onOpenFolder={openFolder}
          onRefresh={refreshTree}
          onOpenFile={openFile}
          onCreateFile={createNewFile}
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
          <TerminalPanel projectRoot={projectRoot} visible={terminalOpen} />
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
          isSending={isSending}
          onStop={stopCurrentTask}
          onNewChat={newChat}
          estimatedTokens={estimatedTokens}
          sessions={sessions.map((s) => ({ id: s.id, title: s.title, usd: s.sessionCost.usd, thb: s.sessionCost.thb }))}
          activeSessionId={activeSessionId}
          onSwitchSession={switchSession}
          onDeleteSession={deleteSession}
          projectRoot={projectRoot}
          agentPhase={agentPhase}
          agentProgress={agentProgress}
          overContextLimit={overContextLimit}
          contextLimit={effectiveAgentSettings.contextLimit}
          supervisorWarningText={activeSupervisorWarning ? supervisorStopMessage(activeSupervisorWarning) : undefined}
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

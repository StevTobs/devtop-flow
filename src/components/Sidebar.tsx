import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  FileEntry,
  baseName,
  copyIntoDir,
  createFolder,
  fileIconFor,
  isSameOrDescendant,
  joinPath,
  listDir,
  movePath,
  moveToTrash,
  parentDir,
  pathExists,
  renamePath,
  revealInFileExplorer,
  validateEntryName,
} from "../lib/fileSystem";
import { useI18n } from "../lib/i18n";

/** `path` relative to `root`, forward-slash normalized regardless of the OS's native separator — for "Copy Relative Path", where the point is a portable, human-readable path rather than exactly what the OS would show. */
function relativeToRoot(root: string, path: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const cleanRoot = norm(root);
  const cleanPath = norm(path);
  return cleanPath.startsWith(`${cleanRoot}/`) ? cleanPath.slice(cleanRoot.length + 1) : cleanPath;
}

const EXPANDED_KEY_PREFIX = "devtopflow.explorer.expanded:";
const DRAG_THRESHOLD_PX = 4;
const AUTO_EXPAND_DELAY_MS = 650;

type Draft =
  | { kind: "file" | "folder"; dir: string; value: string; error?: string }
  | { kind: "rename"; target: FileEntry; value: string; error?: string };

interface Row {
  entry: FileEntry;
  depth: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  /** Undefined = the project root / empty space. */
  entry?: FileEntry;
}

interface DragState {
  entry: FileEntry;
  x: number;
  y: number;
  /** Directory the item would land in, or undefined when over nothing droppable. */
  overDir?: string;
}

interface SidebarProps {
  projectRoot?: string;
  activePath?: string;
  /** Bumped by the app whenever files may have changed on disk (agent writes, manual refresh). */
  refreshKey: number;
  onOpenFolder: () => void;
  /** Re-lists the tree (and the app's AI-facing file tree) after an Explorer operation. */
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
  onCreateFile: (dirPath: string, fileName: string) => Promise<void>;
  onPathMoved: (oldPath: string, newPath: string) => void;
  onPathDeleted: (path: string) => void;
}

export default function Sidebar({
  projectRoot,
  activePath,
  refreshKey,
  onOpenFolder,
  onRefresh,
  onOpenFile,
  onCreateFile,
  onPathMoved,
  onPathDeleted,
}: SidebarProps) {
  const { t } = useI18n();
  const projectName = projectRoot?.split(/[\\/]/).filter(Boolean).pop();

  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const [drag, setDrag] = useState<DragState>();
  const [externalDropDir, setExternalDropDir] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; kind: "info" | "error" }>();
  const treeRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const showNotice = useCallback((text: string, kind: "info" | "error" = "info") => {
    setNotice({ text, kind });
  }, []);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(undefined), notice.kind === "error" ? 6000 : 3000);
    return () => clearTimeout(id);
  }, [notice]);

  // --- loading -------------------------------------------------------------

  const loadDir = useCallback(async (dir: string) => {
    setLoadingDirs((prev) => new Set(prev).add(dir));
    try {
      const entries = await listDir(dir);
      setChildren((prev) => ({ ...prev, [dir]: entries }));
      return true;
    } catch {
      setChildren((prev) => {
        const next = { ...prev };
        delete next[dir];
        return next;
      });
      return false;
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
    }
  }, []);

  // Expanded folders survive restarts, per project. Saved from inside the
  // state update itself (not a separate effect) so a folder switch can never
  // write one project's expanded set under another project's key.
  const updateExpanded = useCallback(
    (fn: (prev: Set<string>) => Set<string>) =>
      setExpanded((prev) => {
        const next = fn(prev);
        if (projectRoot) {
          try {
            localStorage.setItem(EXPANDED_KEY_PREFIX + projectRoot, JSON.stringify([...next]));
          } catch {
            // best-effort
          }
        }
        return next;
      }),
    [projectRoot]
  );

  const readStoredExpanded = (root: string): Set<string> => {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY_PREFIX + root);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  };

  // Reload the root plus every expanded folder whenever the app says the
  // disk may have changed — so a file created inside a nested folder (by the
  // agent or by the Explorer itself) shows up without collapsing anything.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const loadedRootRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    let dirs = expandedRef.current;
    if (loadedRootRef.current !== projectRoot) {
      // A different folder was opened: start from that folder's saved state.
      loadedRootRef.current = projectRoot;
      dirs = projectRoot ? readStoredExpanded(projectRoot) : new Set();
      setExpanded(dirs);
      setChildren({});
      setSelected(undefined);
      setDraft(undefined);
    }
    if (!projectRoot) return;
    let cancelled = false;
    (async () => {
      await loadDir(projectRoot);
      const gone: string[] = [];
      for (const dir of dirs) {
        if (cancelled) return;
        if (!isSameOrDescendant(dir, projectRoot) || !(await loadDir(dir))) gone.push(dir);
      }
      if (gone.length && !cancelled) {
        updateExpanded((prev) => {
          const next = new Set(prev);
          gone.forEach((d) => next.delete(d));
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, refreshKey, loadDir]);

  const expandDir = useCallback(
    async (dir: string) => {
      if (!children[dir]) await loadDir(dir);
      updateExpanded((prev) => new Set(prev).add(dir));
    },
    [children, loadDir, updateExpanded]
  );

  const collapseDir = (dir: string) =>
    updateExpanded((prev) => {
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });

  const toggleDir = (dir: string) => (expanded.has(dir) ? collapseDir(dir) : expandDir(dir));

  // --- flattened, visible rows ------------------------------------------------

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (!projectRoot) return out;
    const walk = (dir: string, depth: number) => {
      for (const entry of children[dir] ?? []) {
        out.push({ entry, depth });
        if (entry.isDirectory && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(projectRoot, 0);
    return out;
  }, [children, expanded, projectRoot]);

  const entryByPath = useMemo(() => new Map(rows.map((r) => [r.entry.path, r.entry])), [rows]);

  /** Where "New File/Folder" goes: the selected folder, the selected file's folder, or the root. */
  const targetDirForNew = (): string | undefined => {
    if (!projectRoot) return undefined;
    const sel = selected ? entryByPath.get(selected) : undefined;
    if (!sel) return projectRoot;
    return sel.isDirectory ? sel.path : parentDir(sel.path);
  };

  // --- create / rename / delete ---------------------------------------------

  const startCreate = async (kind: "file" | "folder", dir = targetDirForNew()) => {
    if (!dir) return;
    setContextMenu(undefined);
    if (dir !== projectRoot) await expandDir(dir);
    setDraft({ kind, dir, value: "" });
  };

  const startRename = (entry: FileEntry) => {
    setContextMenu(undefined);
    setSelected(entry.path);
    setDraft({ kind: "rename", target: entry, value: entry.name });
  };

  const nameErrorText = (key: "empty" | "invalid") =>
    key === "empty" ? t("sidebar.errEmpty") : t("sidebar.errInvalid");

  const committingRef = useRef(false);
  const commitDraft = async (fromBlur: boolean) => {
    if (!draft || committingRef.current) return;
    committingRef.current = true;
    try {
      await commitDraftInner(fromBlur, draft);
    } finally {
      committingRef.current = false;
    }
  };

  const commitDraftInner = async (fromBlur: boolean, draft: Draft) => {
    const value = draft.value.trim();
    // Leaving an untouched box by clicking elsewhere just cancels, like VS Code.
    if (fromBlur && (!value || (draft.kind === "rename" && value === draft.target.name))) {
      setDraft(undefined);
      return;
    }
    const fail = (message: string) => {
      if (fromBlur) {
        setDraft(undefined);
        showNotice(message, "error");
      } else {
        setDraft({ ...draft, error: message });
      }
    };
    const invalid = validateEntryName(value);
    if (invalid) return fail(nameErrorText(invalid));

    try {
      if (draft.kind === "rename") {
        if (value === draft.target.name) {
          setDraft(undefined);
          return;
        }
        if (/[\\/]/.test(value)) return fail(t("sidebar.errInvalid"));
        const newPath = joinPath(parentDir(draft.target.path), value);
        await renamePath(draft.target.path, newPath);
        setDraft(undefined);
        if (draft.target.isDirectory) {
          updateExpanded((prev) => {
            const next = new Set<string>();
            prev.forEach((p) =>
              next.add(isSameOrDescendant(p, draft.target.path) ? newPath + p.slice(draft.target.path.length) : p)
            );
            return next;
          });
        }
        onPathMoved(draft.target.path, newPath);
        setSelected(newPath);
        onRefresh();
        return;
      }

      const fullPath = joinPath(draft.dir, value);
      if (await pathExists(fullPath)) return fail(t("sidebar.errExists", { name: value }));
      setDraft(undefined);
      if (draft.kind === "folder") {
        await createFolder(fullPath);
        updateExpanded((prev) => new Set(prev).add(draft.dir).add(fullPath));
        onRefresh();
      } else {
        await onCreateFile(draft.dir, value);
      }
      setSelected(fullPath);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteEntry = async (entry: FileEntry) => {
    setContextMenu(undefined);
    if (!confirm(t("sidebar.confirmDelete", { name: entry.name }))) return;
    try {
      await moveToTrash(entry.path);
      onPathDeleted(entry.path);
      if (selected && isSameOrDescendant(selected, entry.path)) setSelected(undefined);
      showNotice(t("sidebar.trashed", { name: entry.name }));
      onRefresh();
    } catch (e) {
      showNotice(t("sidebar.opFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
    }
  };

  const moveEntry = async (entry: FileEntry, destDir: string) => {
    if (parentDir(entry.path) === destDir) return; // dropped back where it was
    if (isSameOrDescendant(destDir, entry.path)) {
      showNotice(t("sidebar.errIntoSelf", { name: entry.name }), "error");
      return;
    }
    try {
      const newPath = await movePath(entry.path, destDir);
      if (entry.isDirectory) {
        updateExpanded((prev) => {
          const next = new Set<string>();
          prev.forEach((p) => next.add(isSameOrDescendant(p, entry.path) ? newPath + p.slice(entry.path.length) : p));
          return next.add(destDir);
        });
      } else {
        updateExpanded((prev) => (destDir === projectRoot ? prev : new Set(prev).add(destDir)));
      }
      onPathMoved(entry.path, newPath);
      setSelected(newPath);
      showNotice(t("sidebar.moved", { name: entry.name, dest: baseName(destDir) }));
      onRefresh();
    } catch (e) {
      showNotice(t("sidebar.opFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
    }
  };

  // --- mouse drag to move ----------------------------------------------------
  // Pointer-based rather than HTML5 drag-and-drop: Tauri's native file-drop
  // handling swallows HTML5 drag events inside the webview, which is why
  // dragging never worked reliably here before.

  const pendingDragRef = useRef<{ entry: FileEntry; x: number; y: number } | undefined>(undefined);
  const dragRef = useRef<DragState | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const autoExpandRef = useRef<{ dir: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);

  const dropDirForRow = (entry: FileEntry) => (entry.isDirectory ? entry.path : parentDir(entry.path));

  const updateDrag = (next: DragState | undefined) => {
    dragRef.current = next;
    setDrag(next);
  };

  const scheduleAutoExpand = (dir: string | undefined) => {
    if (autoExpandRef.current?.dir === dir) return;
    if (autoExpandRef.current) clearTimeout(autoExpandRef.current.timer);
    autoExpandRef.current = undefined;
    if (!dir || dir === projectRoot || expandedRef.current.has(dir)) return;
    autoExpandRef.current = { dir, timer: setTimeout(() => expandDir(dir), AUTO_EXPAND_DELAY_MS) };
  };

  const onRowMouseDown = (e: MouseEvent, entry: FileEntry) => {
    if (e.button !== 0 || draft) return;
    pendingDragRef.current = { entry, x: e.clientX, y: e.clientY };
  };

  /** Hover tracking while dragging — rows report themselves, so no coordinate math (and no page-zoom skew) is involved. */
  const onRowMouseMove = (e: MouseEvent, entry: FileEntry) => {
    const current = dragRef.current;
    if (!current) return;
    const dir = dropDirForRow(entry);
    const valid = !isSameOrDescendant(dir, current.entry.path);
    updateDrag({ ...current, x: e.clientX, y: e.clientY, overDir: valid ? dir : undefined });
    scheduleAutoExpand(entry.isDirectory && valid ? entry.path : undefined);
  };

  const onTreeBackgroundMouseMove = (e: MouseEvent) => {
    const current = dragRef.current;
    if (!current || !projectRoot) return;
    // Rows handle their own hover (and must not stopPropagation — the
    // window-level listener below needs every move to start/scroll the drag).
    if ((e.target as HTMLElement).closest("[data-path]")) return;
    updateDrag({ ...current, x: e.clientX, y: e.clientY, overDir: projectRoot });
    scheduleAutoExpand(undefined);
  };

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      const pending = pendingDragRef.current;
      if (pending && !dragRef.current) {
        if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < DRAG_THRESHOLD_PX) return;
        updateDrag({ entry: pending.entry, x: e.clientX, y: e.clientY });
        document.body.classList.add("explorer-dragging");
      }
      const current = dragRef.current;
      if (!current) return;
      // Outside the tree entirely → nothing to drop onto.
      const inTree = treeRef.current?.contains(e.target as Node);
      if (!inTree) {
        updateDrag({ ...current, x: e.clientX, y: e.clientY, overDir: undefined });
        scheduleAutoExpand(undefined);
      } else if (current.x !== e.clientX || current.y !== e.clientY) {
        dragRef.current = { ...dragRef.current!, x: e.clientX, y: e.clientY };
        setDrag(dragRef.current);
      }
      // Auto-scroll near the top/bottom edge of the tree.
      const scroller = scrollRef.current;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        if (e.clientY < rect.top + 28) scroller.scrollTop -= 10;
        else if (e.clientY > rect.bottom - 28) scroller.scrollTop += 10;
      }
    };
    const endDrag = () => {
      pendingDragRef.current = undefined;
      if (autoExpandRef.current) clearTimeout(autoExpandRef.current.timer);
      autoExpandRef.current = undefined;
      document.body.classList.remove("explorer-dragging");
      updateDrag(undefined);
    };
    const onUp = () => {
      const current = dragRef.current;
      if (current) {
        suppressClickRef.current = true;
        setTimeout(() => (suppressClickRef.current = false), 0);
        if (current.overDir) moveEntry(current.entry, current.overDir);
      }
      endDrag();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) endDrag();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  });

  // --- drop files in from Finder / Explorer ------------------------------------

  const dropDirAtWindowPoint = (physX: number, physY: number): string | undefined => {
    if (!projectRoot) return undefined;
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom || "1") || 1;
    const dpr = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(physX / dpr / zoom, physY / dpr / zoom);
    if (!el || !el.closest(".sidebar")) return undefined;
    const row = el.closest<HTMLElement>("[data-drop-dir]");
    return row?.dataset.dropDir ?? projectRoot;
  };

  useEffect(() => {
    if (!projectRoot) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "leave") {
          setExternalDropDir(undefined);
          return;
        }
        const dir = dropDirAtWindowPoint(p.position.x, p.position.y);
        if (p.type === "enter" || p.type === "over") {
          setExternalDropDir(dir);
          return;
        }
        setExternalDropDir(undefined);
        if (p.type !== "drop" || !dir || p.paths.length === 0) return;
        let copied = 0;
        const errors: string[] = [];
        for (const src of p.paths) {
          try {
            await copyIntoDir(src, dir);
            copied++;
          } catch (e) {
            errors.push(`${baseName(src)}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (dir !== projectRoot) updateExpanded((prev) => new Set(prev).add(dir));
        onRefresh();
        if (errors.length) showNotice(t("sidebar.opFailed", { error: errors.join("; ") }), "error");
        else showNotice(t("sidebar.copiedIn", { n: copied, dest: baseName(dir) }));
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // not running inside Tauri (e.g. plain `vite` in a browser) — no native drops
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  // --- clicks & keyboard -------------------------------------------------------

  const activateRow = (entry: FileEntry) => {
    if (suppressClickRef.current) return;
    setSelected(entry.path);
    treeRef.current?.focus();
    if (entry.isDirectory) toggleDir(entry.path);
    else onOpenFile(entry.path);
  };

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (draft || (e.target as HTMLElement).tagName === "INPUT") return;
    const index = rows.findIndex((r) => r.entry.path === selected);
    const current = index >= 0 ? rows[index].entry : undefined;
    const move = (delta: number) => {
      if (rows.length === 0) return;
      const next = rows[Math.min(rows.length - 1, Math.max(0, (index < 0 ? -1 : index) + delta))];
      setSelected(next.entry.path);
      treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.entry.path)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "ArrowRight":
        if (current?.isDirectory) {
          e.preventDefault();
          if (!expanded.has(current.path)) expandDir(current.path);
          else move(1);
        }
        break;
      case "ArrowLeft":
        if (!current) break;
        e.preventDefault();
        if (current.isDirectory && expanded.has(current.path)) collapseDir(current.path);
        else if (parentDir(current.path) !== projectRoot) setSelected(parentDir(current.path));
        break;
      case "Enter":
        if (current) {
          e.preventDefault();
          if (current.isDirectory) toggleDir(current.path);
          else onOpenFile(current.path);
        }
        break;
      case "F2":
        if (current) {
          e.preventDefault();
          startRename(current);
        }
        break;
      case "Delete":
      case "Backspace":
        if (current && (e.key === "Delete" || e.metaKey)) {
          e.preventDefault();
          deleteEntry(current);
        }
        break;
    }
  };

  const openContextMenu = (e: MouseEvent, entry?: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    if (!projectRoot) return;
    if (entry) setSelected(entry.path);
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // --- rendering ---------------------------------------------------------------

  const renderDraftInput = (depth: number, placeholder: string) =>
    draft && (
      <div className="tree-draft" style={{ paddingLeft: 8 + depth * 12 + 16 }}>
        <input
          className={`new-file-input ${draft.error ? "has-error" : ""}`}
          autoFocus
          placeholder={placeholder}
          value={draft.value}
          onFocus={(e) => {
            // Rename: pre-select just the name, not the extension (Finder / VS Code behavior).
            if (draft.kind === "rename") {
              const dot = draft.value.lastIndexOf(".");
              e.currentTarget.setSelectionRange(0, dot > 0 && !draft.target.isDirectory ? dot : draft.value.length);
            }
          }}
          onChange={(e) => setDraft({ ...draft, value: e.target.value, error: undefined })}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft(false);
            }
            if (e.key === "Escape") setDraft(undefined);
          }}
          onBlur={() => commitDraft(true)}
        />
        {draft.error && <div className="tree-draft-error">{draft.error}</div>}
      </div>
    );

  const createDraftFor = (dir: string) =>
    draft && draft.kind !== "rename" && draft.dir === dir ? draft : undefined;

  const renderRows = () => {
    const out: JSX.Element[] = [];
    if (projectRoot && createDraftFor(projectRoot)) {
      out.push(
        <div key="__draft-root">
          {renderDraftInput(0, draft!.kind === "folder" ? t("sidebar.folderPlaceholder") : t("sidebar.filenamePlaceholder"))}
        </div>
      );
    }
    for (const { entry, depth } of rows) {
      const isRenaming = draft?.kind === "rename" && draft.target.path === entry.path;
      if (isRenaming) {
        out.push(<div key={`__rename-${entry.path}`}>{renderDraftInput(depth, entry.name)}</div>);
      } else {
        const isOpen = entry.isDirectory && expanded.has(entry.path);
        const dropDir = dropDirForRow(entry);
        const isDropTarget =
          (drag?.overDir && entry.isDirectory && drag.overDir === entry.path) ||
          (externalDropDir && entry.isDirectory && externalDropDir === entry.path);
        const icon = entry.isDirectory ? undefined : fileIconFor(entry.name);
        out.push(
          <div
            key={entry.path}
            data-path={entry.path}
            data-drop-dir={dropDir}
            className={[
              "tree-row",
              entry.isDirectory ? "is-dir" : "",
              activePath === entry.path ? "active" : "",
              selected === entry.path ? "selected" : "",
              isDropTarget ? "drop-target" : "",
              drag?.entry.path === entry.path ? "dragging" : "",
            ].join(" ")}
            style={{ paddingLeft: 8 + depth * 12 }}
            onMouseDown={(e) => onRowMouseDown(e, entry)}
            onMouseMove={(e) => onRowMouseMove(e, entry)}
            onClick={() => activateRow(entry)}
            onContextMenu={(e) => openContextMenu(e, entry)}
            title={entry.path}
          >
            <span className="tree-chevron">{entry.isDirectory ? (isOpen ? "▾" : "▸") : ""}</span>
            {entry.isDirectory ? (
              <span className="tree-folder-icon">{isOpen ? "📂" : "📁"}</span>
            ) : (
              <span className="file-icon" style={{ background: icon!.bg, color: icon!.fg ?? "#fff" }}>
                {icon!.label}
              </span>
            )}
            <span className="tree-name">{entry.name}</span>
            {loadingDirs.has(entry.path) && <span className="tree-loading">…</span>}
            {entry.isDirectory && (
              <span className="tree-row-actions">
                <button
                  className="file-item-action"
                  title={t("sidebar.newFile")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(entry.path);
                    startCreate("file", entry.path);
                  }}
                >
                  ＋📄
                </button>
                <button
                  className="file-item-action"
                  title={t("sidebar.newFolder")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(entry.path);
                    startCreate("folder", entry.path);
                  }}
                >
                  ＋📁
                </button>
              </span>
            )}
          </div>
        );
      }
      if (entry.isDirectory && expanded.has(entry.path) && createDraftFor(entry.path)) {
        out.push(
          <div key={`__draft-${entry.path}`}>
            {renderDraftInput(depth + 1, draft!.kind === "folder" ? t("sidebar.folderPlaceholder") : t("sidebar.filenamePlaceholder"))}
          </div>
        );
      }
    }
    return out;
  };

  const menuEntry = contextMenu?.entry;
  const menuDir = menuEntry ? (menuEntry.isDirectory ? menuEntry.path : parentDir(menuEntry.path)) : projectRoot;
  const menuPath = menuEntry?.path ?? projectRoot;
  const rootIsDropTarget =
    (drag && drag.overDir === projectRoot) || (externalDropDir !== undefined && externalDropDir === projectRoot);

  return (
    <div className="sidebar">
      <div className="explorer-header">
        <span className="explorer-title" title={projectRoot} onContextMenu={(e) => openContextMenu(e)}>
          {projectName ? t("sidebar.explorerNamed", { name: projectName }) : t("sidebar.explorer")}
        </span>
        <span className="explorer-actions">
          {projectRoot && (
            <>
              <button className="explorer-btn" onClick={() => startCreate("file")} title={t("sidebar.newFile")}>
                ＋📄
              </button>
              <button className="explorer-btn" onClick={() => startCreate("folder")} title={t("sidebar.newFolder")}>
                ＋📁
              </button>
              <button className="explorer-btn" onClick={onRefresh} title={t("sidebar.refresh")}>
                ⟲
              </button>
              <button className="explorer-btn" onClick={() => updateExpanded(() => new Set())} title={t("sidebar.collapseAll")}>
                ⊟
              </button>
            </>
          )}
          <button className="explorer-btn" onClick={onOpenFolder} title={t("sidebar.openFolder")}>
            ⊕
          </button>
        </span>
      </div>

      <div className="sidebar-scroll" ref={scrollRef}>
        {!projectRoot && (
          <div className="empty-hint" onClick={onOpenFolder}>
            {t("sidebar.emptyHint")}
          </div>
        )}

        {projectRoot && (
          <div
            ref={treeRef}
            className={`explorer-tree ${rootIsDropTarget ? "drop-target-root" : ""}`}
            tabIndex={0}
            onKeyDown={onTreeKeyDown}
            onMouseMove={onTreeBackgroundMouseMove}
            onClick={(e) => {
              if (e.target === e.currentTarget) setSelected(undefined);
            }}
            onContextMenu={(e) => openContextMenu(e)}
            data-drop-dir={projectRoot}
          >
            {renderRows()}
            {rows.length === 0 && !createDraftFor(projectRoot) && (
              <div className="empty-hint">{t("sidebar.emptyFolder")}</div>
            )}
          </div>
        )}
      </div>

      {notice && <div className={`explorer-notice ${notice.kind}`}>{notice.text}</div>}

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 12, top: drag.y + 8 }}>
          {drag.entry.isDirectory ? "📁" : "📄"} {drag.entry.name}
          {drag.overDir && <span className="drag-ghost-dest"> → {baseName(drag.overDir)}</span>}
        </div>
      )}

      {contextMenu && menuDir && menuPath && (
        <>
          <div
            className="context-menu-backdrop"
            onClick={() => setContextMenu(undefined)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(undefined);
            }}
          />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            {menuEntry && !menuEntry.isDirectory && (
              <button
                onClick={() => {
                  onOpenFile(menuEntry.path);
                  setContextMenu(undefined);
                }}
              >
                {t("sidebar.open")}
              </button>
            )}
            <button onClick={() => startCreate("file", menuDir)}>{t("sidebar.newFile")}</button>
            <button onClick={() => startCreate("folder", menuDir)}>{t("sidebar.newFolder")}</button>
            <div className="context-menu-sep" />
            {menuEntry && (
              <>
                <button onClick={() => startRename(menuEntry)}>
                  {t("sidebar.rename")} <span className="context-menu-kbd">F2</span>
                </button>
                <button className="danger" onClick={() => deleteEntry(menuEntry)}>
                  {t("sidebar.delete")} <span className="context-menu-kbd">⌘⌫</span>
                </button>
                <div className="context-menu-sep" />
              </>
            )}
            <button
              onClick={() => {
                revealInFileExplorer(menuEntry && !menuEntry.isDirectory ? parentDir(menuPath) : menuPath);
                setContextMenu(undefined);
              }}
            >
              {t("sidebar.revealInExplorer")}
            </button>
            <button
              onClick={() => {
                navigator.clipboard.writeText(menuPath);
                setContextMenu(undefined);
              }}
            >
              {t("sidebar.copyPath")}
            </button>
            {projectRoot && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(relativeToRoot(projectRoot, menuPath));
                  setContextMenu(undefined);
                }}
              >
                {t("sidebar.copyRelativePath")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

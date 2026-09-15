import { useState, type MouseEvent } from "react";
import { FileEntry, fileIconFor, listDir, parentDir, revealInFileExplorer } from "../lib/fileSystem";

interface TreeNodeProps {
  entry: FileEntry;
  depth: number;
  activePath?: string;
  onOpenFile: (path: string) => void;
  onCreateFile: (dirPath: string, fileName: string) => Promise<void>;
  onContextMenu: (path: string, isDirectory: boolean, x: number, y: number) => void;
}

function TreeNode({ entry, depth, activePath, onOpenFile, onCreateFile, onContextMenu }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");

  const loadChildren = async () => {
    setLoading(true);
    try {
      setChildren(await listDir(entry.path));
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    if (!entry.isDirectory) {
      onOpenFile(entry.path);
      return;
    }
    if (!expanded && children === undefined) await loadChildren();
    setExpanded((v) => !v);
  };

  const startCreate = async (e: MouseEvent) => {
    e.stopPropagation();
    if (!expanded) {
      if (children === undefined) await loadChildren();
      setExpanded(true);
    }
    setCreating(true);
    setDraftName("");
  };

  const submitCreate = async () => {
    const name = draftName.trim();
    setCreating(false);
    if (!name) return;
    await onCreateFile(entry.path, name);
    setChildren(await listDir(entry.path));
  };
  const cancelCreate = () => setCreating(false);

  if (!entry.isDirectory) {
    const icon = fileIconFor(entry.name);
    return (
      <div
        className={`file-item ${activePath === entry.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(entry.path, false, e.clientX, e.clientY);
        }}
      >
        <span className="file-icon" style={{ background: icon.bg, color: icon.fg ?? "#fff" }}>
          {icon.label}
        </span>
        {entry.name}
      </div>
    );
  }

  return (
    <div>
      <div
        className="file-item file-item-dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(entry.path, true, e.clientX, e.clientY);
        }}
      >
        <span>
          {expanded ? "▾ " : "▸ "}
          {entry.name}
          {loading ? " …" : ""}
        </span>
        <button className="file-item-action" title="New File…" onClick={startCreate}>
          📄
        </button>
      </div>
      {expanded && creating && (
        <input
          className="new-file-input"
          style={{ marginLeft: 8 + (depth + 1) * 14 }}
          autoFocus
          placeholder="filename.ext"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitCreate();
            if (e.key === "Escape") cancelCreate();
          }}
          onBlur={cancelCreate}
        />
      )}
      {expanded &&
        children?.map((c) => (
          <TreeNode
            key={c.path}
            entry={c}
            depth={depth + 1}
            activePath={activePath}
            onOpenFile={onOpenFile}
            onCreateFile={onCreateFile}
            onContextMenu={onContextMenu}
          />
        ))}
    </div>
  );
}

interface SidebarProps {
  projectRoot?: string;
  rootEntries: FileEntry[];
  activePath?: string;
  onOpenFolder: () => void;
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
  onCreateFile: (dirPath: string, fileName: string) => Promise<void>;
}

export default function Sidebar({
  projectRoot,
  rootEntries,
  activePath,
  onOpenFolder,
  onRefresh,
  onOpenFile,
  onCreateFile,
}: SidebarProps) {
  const projectName = projectRoot?.split(/[\\/]/).filter(Boolean).pop();
  const [creatingAtRoot, setCreatingAtRoot] = useState(false);
  const [rootDraftName, setRootDraftName] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; isDirectory: boolean } | undefined>();

  const submitRootCreate = async () => {
    const name = rootDraftName.trim();
    setCreatingAtRoot(false);
    if (!name || !projectRoot) return;
    await onCreateFile(projectRoot, name);
  };
  const cancelRootCreate = () => setCreatingAtRoot(false);

  const openContextMenu = (path: string, isDirectory: boolean, x: number, y: number) =>
    setContextMenu({ path, isDirectory, x, y });
  const closeContextMenu = () => setContextMenu(undefined);

  return (
    <div className="sidebar">
      <div className="sidebar-scroll">
        <div className="section-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span
            title={projectRoot}
            onContextMenu={(e) => {
              if (!projectRoot) return;
              e.preventDefault();
              openContextMenu(projectRoot, true, e.clientX, e.clientY);
            }}
          >
            {projectName ? `Explorer — ${projectName}` : "Explorer"}
          </span>
          <span>
            {projectRoot && (
              <>
                <button
                  className="text-btn"
                  onClick={() => {
                    setCreatingAtRoot(true);
                    setRootDraftName("");
                  }}
                  title="New File…"
                >
                  📄
                </button>
                <button className="text-btn" onClick={onRefresh} title="Refresh">
                  ⟲
                </button>
              </>
            )}
            <button className="text-btn" onClick={onOpenFolder} title="Open Folder…">
              ＋
            </button>
          </span>
        </div>

        {!projectRoot && (
          <div className="empty-hint" onClick={onOpenFolder}>
            Open a folder to start editing — DevTop Flow can only create/edit files inside a folder you've opened.
          </div>
        )}

        {projectRoot && creatingAtRoot && (
          <input
            className="new-file-input"
            style={{ marginLeft: 8 }}
            autoFocus
            placeholder="filename.ext"
            value={rootDraftName}
            onChange={(e) => setRootDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRootCreate();
              if (e.key === "Escape") cancelRootCreate();
            }}
            onBlur={cancelRootCreate}
          />
        )}

        {projectRoot &&
          rootEntries.map((e) => (
            <TreeNode
              key={e.path}
              entry={e}
              depth={0}
              activePath={activePath}
              onOpenFile={onOpenFile}
              onCreateFile={onCreateFile}
              onContextMenu={openContextMenu}
            />
          ))}
      </div>

      {contextMenu && (
        <>
          <div className="context-menu-backdrop" onClick={closeContextMenu} onContextMenu={(e) => e.preventDefault()} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button
              onClick={() => {
                revealInFileExplorer(contextMenu.isDirectory ? contextMenu.path : parentDir(contextMenu.path));
                closeContextMenu();
              }}
            >
              Reveal in File Explorer
            </button>
          </div>
        </>
      )}
    </div>
  );
}

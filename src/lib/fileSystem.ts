import { open } from "@tauri-apps/plugin-dialog";
import {
  mkdir,
  readDir,
  readFile as readBinaryFile,
  readTextFile,
  writeFile as writeBinaryFileRaw,
  writeTextFile,
  type DirEntry,
} from "@tauri-apps/plugin-fs";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

// Real filesystem access for the file explorer / editor (build plan §7 "Project &
// Workspace Management"), via Tauri's fs + dialog plugins instead of a demo list.

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

const IGNORED_DIRS = new Set(["node_modules", "target", ".git", "dist", "out", ".DS_Store", ".devtopflow"]);

/** Native folder picker. Returns the chosen absolute path, or undefined if cancelled. */
export async function pickProjectFolder(): Promise<string | undefined> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : undefined;
}

/** Native file picker — any file on disk, not limited to the open project (used to attach context to chat). */
export async function pickAnyFile(): Promise<string | undefined> {
  const selected = await open({ directory: false, multiple: false });
  return typeof selected === "string" ? selected : undefined;
}

/** Same, but lets the user select several files at once. */
export async function pickAnyFiles(): Promise<string[]> {
  const selected = await open({ directory: false, multiple: true });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** The containing folder of a file path — separator-aware for both POSIX and Windows paths. */
export function parentDir(path: string): string {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSep > 0 ? path.slice(0, lastSep) : path;
}

/** Opens a folder in the OS file manager (Explorer on Windows, Finder on macOS) — VS Code's "Reveal in File Explorer". */
export async function revealInFileExplorer(path: string): Promise<void> {
  await shellOpen(path);
}

/** Opens a URL in the user's default browser — e.g. "get an API key" links in Settings. */
export async function openExternalUrl(url: string): Promise<void> {
  await shellOpen(url);
}

/** One level of a directory's children, directories first then files, alphabetically. */
export async function listDir(path: string): Promise<FileEntry[]> {
  const entries: DirEntry[] = await readDir(path);
  const sep = path.includes("\\") ? "\\" : "/";
  return entries
    .filter((e) => !IGNORED_DIRS.has(e.name ?? ""))
    .map((e) => ({
      name: e.name ?? "",
      path: `${path.replace(/[\\/]+$/, "")}${sep}${e.name}`,
      isDirectory: e.isDirectory,
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export async function readFile(path: string): Promise<string> {
  return readTextFile(path);
}

/**
 * A capped, indented text tree of the project — this is what actually lets
 * the AI "see" the folder. Without it the model only ever knew the root
 * path string, not what's inside it, and correctly reported it couldn't
 * browse anything. Depth/entry caps keep token cost bounded on large repos.
 */
export async function buildFileTree(
  root: string,
  opts: { maxDepth?: number; maxEntries?: number } = {}
): Promise<string> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxEntries = opts.maxEntries ?? 400;
  const lines: string[] = [];
  let count = 0;

  async function walk(dir: string, depth: number, prefix: string) {
    if (count >= maxEntries) return;
    let entries: FileEntry[];
    try {
      entries = await listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxEntries) {
        lines.push(`${prefix}… (truncated)`);
        return;
      }
      lines.push(`${prefix}${entry.isDirectory ? entry.name + "/" : entry.name}`);
      count++;
      if (entry.isDirectory && depth < maxDepth) {
        await walk(entry.path, depth + 1, `${prefix}  `);
      }
    }
  }

  await walk(root, 1, "");
  return lines.join("\n");
}

export async function writeFile(path: string, content: string): Promise<void> {
  await writeTextFile(path, content);
}

const RASTER_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** True for binary raster formats (jpg/png/gif/webp/bmp/ico) — svg is handled separately since it's text. */
export function isRasterImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext in RASTER_MIME;
}

export function isImagePath(path: string): boolean {
  return isRasterImagePath(path) || path.toLowerCase().endsWith(".svg");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000; // avoid call-stack overflow from spreading huge arrays
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Inverse of bytesToBase64 — decodes raw base64 (no `data:` prefix) into bytes for writing an image to disk. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Splits a `data:<mime>;base64,<payload>` URL into its parts — canvas and the image APIs both hand back this form. */
export function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const m = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s);
  if (!m) throw new Error("not a base64 data: URL");
  return { mimeType: m[1], base64: m[2] };
}

/** Reads a raster image file and returns it as a data: URL for previewing. */
export async function readImageAsDataUrl(path: string): Promise<string> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = RASTER_MIME[ext] ?? "application/octet-stream";
  const bytes = await readBinaryFile(path);
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

const OTHER_ASSET_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  json: "application/json",
  webmanifest: "application/manifest+json",
};

/**
 * Reads any local file's bytes and returns it as a data: URL, guessing MIME
 * from the extension (falls back to a generic octet-stream). Used to inline
 * local assets (background images, @font-face files, <img> tags, …) into an
 * HTML/CSS preview — the packaged app's webview can't fetch arbitrary file://
 * sub-resources referenced by a srcDoc iframe the way a real browser tab can,
 * so the preview builder (htmlPreview.ts) reads and embeds them itself.
 */
export async function readAnyFileAsDataUrl(path: string): Promise<string> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = RASTER_MIME[ext] ?? OTHER_ASSET_MIME[ext] ?? "application/octet-stream";
  const bytes = await readBinaryFile(path);
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** Encodes SVG source text as a data: URL (used for the live SVG preview, and rendered as an <img> so embedded scripts never execute). */
export function svgTextToDataUrl(svgText: string): string {
  const bytes = new TextEncoder().encode(svgText);
  return `data:image/svg+xml;base64,${bytesToBase64(bytes)}`;
}

/** True for a Windows drive-letter path ("C:\..." / "C:/..."), a UNC path ("\\server\share"), or a POSIX absolute path ("/..."). */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

/**
 * Resolves a (possibly relative, possibly absolute, possibly `..`-laden)
 * path against the open project root and refuses anything that would escape
 * it — the AI is only ever allowed to touch the folder the user explicitly
 * opened. Handles both POSIX ("/") and Windows ("C:\...", mixed "/") paths:
 * a model asked for a *relative* path still sometimes emits an absolute one
 * regardless, and on Windows that absolute form uses a drive letter and
 * backslashes that a POSIX-only implementation can't recognize as absolute
 * at all — it would fall through to the "relative" branch, get nonsensically
 * appended onto the root, and then get rejected as "escaping" for the wrong
 * reason (this is exactly what happened: a real in-root Windows path refused).
 */
export function resolveWithinRoot(root: string, relativeOrAbsolute: string): string | undefined {
  const sep = root.includes("\\") ? "\\" : "/";
  const toSlashes = (p: string) => p.replace(/\\/g, "/");

  const cleanRoot = toSlashes(root).replace(/\/+$/, "");
  const combined = isAbsolutePath(relativeOrAbsolute)
    ? toSlashes(relativeOrAbsolute)
    : `${cleanRoot}/${toSlashes(relativeOrAbsolute)}`;

  // A Windows drive letter has to survive the ../ collapsing below intact —
  // otherwise it's just another segment and gets treated as such.
  const driveMatch = combined.match(/^([a-zA-Z]:)\/(.*)$/);
  const drive = driveMatch?.[1] ?? "";
  const rest = driveMatch ? driveMatch[2] : combined.replace(/^\/+/, "");

  const parts = rest.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  const absolute = drive ? `${drive}/${resolved.join("/")}` : `/${resolved.join("/")}`;

  // Windows paths (and drive letters) are case-insensitive.
  const norm = drive ? (s: string) => s.toLowerCase() : (s: string) => s;
  const withinRoot = norm(absolute) === norm(cleanRoot) || norm(absolute).startsWith(`${norm(cleanRoot)}/`);
  if (!withinRoot) return undefined;

  return sep === "\\" ? absolute.replace(/\//g, "\\") : absolute;
}

/** Creates (or overwrites) a file, making any missing parent directories along the way. */
export async function createFile(path: string, content: string): Promise<void> {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastSlash > 0) {
    await mkdir(path.slice(0, lastSlash), { recursive: true });
  }
  await writeTextFile(path, content);
}

/**
 * Binary sibling of createFile — writes raw bytes (a generated PNG/JPG, say)
 * rather than text, making parent directories along the way. Text encoding
 * would corrupt image bytes, so image writes must never go through
 * writeTextFile.
 */
export async function createBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastSlash > 0) {
    await mkdir(path.slice(0, lastSlash), { recursive: true });
  }
  await writeBinaryFileRaw(path, bytes);
}

/** Best-effort language id for Monaco, from the file extension. */
export function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "json",
    css: "css",
    scss: "scss",
    sass: "scss",
    less: "less",
    html: "html",
    htm: "html",
    md: "markdown",
    mdx: "markdown",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
    kt: "kotlin",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    rb: "ruby",
    sql: "sql",
    toml: "toml",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ps1: "powershell",
    bat: "bat",
    xml: "xml",
    svg: "xml",
    csv: "plaintext",
    txt: "plaintext",
    env: "plaintext",
  };
  return map[ext] ?? "plaintext";
}

export interface FileIcon {
  /** Short glyph shown in the badge — usually the language's conventional 1-3 char abbreviation. */
  label: string;
  /** Badge background, loosely matching that language/tool's brand color (same idea as GitHub's language dots). */
  bg: string;
  fg?: string;
}

const FILE_ICONS: Record<string, FileIcon> = {
  js: { label: "JS", bg: "#f0db4f", fg: "#222" },
  mjs: { label: "JS", bg: "#f0db4f", fg: "#222" },
  cjs: { label: "JS", bg: "#f0db4f", fg: "#222" },
  jsx: { label: "JSX", bg: "#61dafb", fg: "#222" },
  ts: { label: "TS", bg: "#3178c6" },
  tsx: { label: "TSX", bg: "#3178c6" },
  json: { label: "{}", bg: "#cbcb41", fg: "#222" },
  jsonc: { label: "{}", bg: "#cbcb41", fg: "#222" },
  html: { label: "<>", bg: "#e34c26" },
  htm: { label: "<>", bg: "#e34c26" },
  css: { label: "#", bg: "#264de4" },
  scss: { label: "#", bg: "#cc6699" },
  sass: { label: "#", bg: "#cc6699" },
  less: { label: "#", bg: "#1d365d" },
  vue: { label: "V", bg: "#42b883" },
  svelte: { label: "S", bg: "#ff3e00" },
  md: { label: "M↓", bg: "#519aba" },
  mdx: { label: "M↓", bg: "#519aba" },
  py: { label: "PY", bg: "#3572a5" },
  rs: { label: "RS", bg: "#dea584", fg: "#222" },
  go: { label: "GO", bg: "#00add8" },
  java: { label: "J", bg: "#b07219" },
  kt: { label: "K", bg: "#7f52ff" },
  c: { label: "C", bg: "#555555" },
  h: { label: "H", bg: "#555555" },
  cpp: { label: "C++", bg: "#00599c" },
  hpp: { label: "C++", bg: "#00599c" },
  cs: { label: "C#", bg: "#178600" },
  php: { label: "PHP", bg: "#4f5d95" },
  rb: { label: "RB", bg: "#701516" },
  sh: { label: ">_", bg: "#4eaa25" },
  bash: { label: ">_", bg: "#4eaa25" },
  zsh: { label: ">_", bg: "#4eaa25" },
  ps1: { label: ">_", bg: "#012456" },
  bat: { label: ">_", bg: "#555555" },
  yml: { label: "Y", bg: "#cb171e" },
  yaml: { label: "Y", bg: "#cb171e" },
  toml: { label: "T", bg: "#9c4221" },
  xml: { label: "X", bg: "#e37933" },
  sql: { label: "DB", bg: "#336791" },
  svg: { label: "◇", bg: "#ffb13b", fg: "#222" },
  png: { label: "PNG", bg: "#a074c4" },
  jpg: { label: "JPG", bg: "#a074c4" },
  jpeg: { label: "JPG", bg: "#a074c4" },
  gif: { label: "GIF", bg: "#a074c4" },
  webp: { label: "IMG", bg: "#a074c4" },
  ico: { label: "ICO", bg: "#a074c4" },
  pdf: { label: "PDF", bg: "#d93831" },
  txt: { label: "TXT", bg: "#6d6d6d" },
  env: { label: "ENV", bg: "#ecd53f", fg: "#222" },
  lock: { label: "🔒", bg: "#6d6d6d" },
};

const FILE_ICONS_BY_NAME: Record<string, FileIcon> = {
  ".gitignore": { label: "GIT", bg: "#f14e32" },
  ".gitattributes": { label: "GIT", bg: "#f14e32" },
  dockerfile: { label: "🐳", bg: "#2496ed" },
  makefile: { label: "MK", bg: "#6d6d6d" },
  "package.json": { label: "PKG", bg: "#cb3837" },
};

const DEFAULT_FILE_ICON: FileIcon = { label: "•", bg: "#6d6d6d" };

/** VS Code-style per-extension file badge for the Explorer tree — falls back to a generic dot for anything unrecognized. */
export function fileIconFor(name: string): FileIcon {
  const lower = name.toLowerCase();
  if (FILE_ICONS_BY_NAME[lower]) return FILE_ICONS_BY_NAME[lower];
  const ext = lower.includes(".") ? (lower.split(".").pop() ?? "") : "";
  return FILE_ICONS[ext] ?? DEFAULT_FILE_ICON;
}

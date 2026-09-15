import { ChatMessage } from "./modelProvider";
import { createBinaryFile, createFile, base64ToBytes, readFile, resolveWithinRoot } from "./fileSystem";
import {
  formatFromPath,
  generateImage,
  normalizeImageQuality,
  normalizeImageSize,
  renderSvgToImage,
  type ImageQuality,
  type ImageSize,
} from "./imageGen";

// "Command execution / tool use" seam (build plan §5.6):
// - The model gets a real file tree of the open project up front — without
//   this it only ever knew the root path string, not what's inside it, and
//   would (correctly) say it couldn't browse anything.
// - It can request the contents of a specific file via a fenced `devtopflow:read`
//   block; the app fetches it and feeds it back for a follow-up turn.
// - It can create/overwrite a file via a fenced `devtopflow:file` block.
// - It can produce real .png/.jpg files two ways: `devtopflow:draw` rasterizes
//   SVG the model writes itself (offline, free, works with every model), and
//   `devtopflow:image` calls a generative image model (needs the OpenAI key).
// Everything is confined to the project folder the user explicitly opened
// (build plan §8 guardrails) — paths that would escape it are refused.

const FILE_BLOCK = /```devtopflow:file path="([^"\n]+)"\n([\s\S]*?)```/g;
const READ_BLOCK = /```devtopflow:read path="([^"\n]+)"\s*```/g;
const IMAGE_BLOCK = /```devtopflow:image ([^\n]*)\n([\s\S]*?)```/g;
const DRAW_BLOCK = /```devtopflow:draw ([^\n]*)\n([\s\S]*?)```/g;

export interface AppliedFile {
  path: string;
  ok: boolean;
  error?: string;
}

/** One image-writing directive's outcome. */
export interface AppliedImage extends AppliedFile {
  kind: "generated" | "drawn";
  /** Human-readable detail for the transcript, e.g. "SVG" or "1024x1024 medium". */
  detail?: string;
  /** Where it actually landed on disk — lets the caller open/refresh the file without re-resolving the path. */
  absolutePath?: string;
  /** Generative only: what the request was billed at, so the caller can price it against the budget. */
  size?: ImageSize;
  quality?: ImageQuality;
}

/**
 * System instructions describing the available tools, scoped to whether a
 * project is open. `tree` is a pre-built file listing, not walked here —
 * this used to call buildFileTree() itself on every single model turn
 * (including the extra turn from an agentic file-read), redoing a recursive
 * filesystem walk over IPC each time even though the project structure
 * hadn't changed. Callers now cache the tree and pass it in.
 */
export function buildToolCapabilityMessage(
  projectRoot: string | undefined,
  tree: string,
  includeTree: boolean = true,
  canGenerateImages: boolean = false
): ChatMessage {
  if (!projectRoot) {
    return {
      role: "system",
      content:
        "No project folder is open. You cannot see any files or create/edit files right now. If the user asks you to look at, create, write, or scaffold a file, tell them to open a folder first (the ＋ button next to Explorer in the sidebar).",
    };
  }

  const treeSection = includeTree
    ? [`Here is its file tree (may be truncated for very large projects):`, "```", tree || "(empty folder)", "```"]
    : [
        `Workspace tree browsing is turned off in Agent Settings — you don't have a file listing right now. Ask the user for exact paths, or use devtopflow:read once they give you one.`,
      ];

  // The generative path needs an OpenAI key; the SVG path never does, so it
  // stays available (and is the one recommended for logos/icons/diagrams
  // regardless, since it's exact, free, and editable afterwards).
  const imageSection = canGenerateImages
    ? [
        `To generate a photographic or illustrative image with an image model, emit:`,
        '```devtopflow:image path="assets/hero.png" size="1024x1024" quality="medium"',
        "<the image prompt, in plain words — this whole block body is the prompt>",
        "```",
        `size may be 1024x1024, 1536x1024 (landscape) or 1024x1536 (portrait); quality may be low, medium or high (defaults: 1024x1024, medium). Each one costs real money against the user's OpenAI account and their budget, so generate only what was actually asked for — never several variations "to choose from" unless they asked for variations.`,
      ]
    : [
        `Generative image creation is unavailable right now (it needs an OpenAI API key in Settings), but devtopflow:draw below still works — it needs no key and costs nothing.`,
      ];

  return {
    role: "system",
    content: [
      `A project folder is open at: ${projectRoot}`,
      ...treeSection,
      `You don't have file contents yet regardless of the above. To read a file's contents before answering, emit a fenced block with this exact format and nothing else in your reply:`,
      '```devtopflow:read path="relative/path/to/file.ext"',
      "```",
      `The app will fetch it and send its contents back to you as a follow-up turn.`,
      ``,
      `To create or overwrite a file, emit a fenced code block with this exact format:`,
      '```devtopflow:file path="relative/path/to/file.ext"',
      "<full file contents>",
      "```",
      `When asked to create an app or scaffold a project, emit ONE such block PER FILE, one after another, all in the same response — do not stop after the first file, and do not describe the remaining files in prose instead of writing them. For example, scaffolding a small app might mean emitting a devtopflow:file block for package.json, then another for index.html, then another for src/main.ts, back to back, each with its own path and full contents.`,
      ``,
      `You can also create real .png and .jpg image files in the project — devtopflow:file writes text, so it can never produce one, and these two blocks are the only way.`,
      `To draw an image yourself (logos, icons, banners, charts, diagrams, placeholder art, anything geometric or typographic), write SVG and the app will rasterize it to a real .png/.jpg on disk:`,
      '```devtopflow:draw path="assets/logo.png" width="512" height="512"',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">…</svg>',
      "```",
      `The body must be a single complete <svg> element. width/height are optional — they default to the SVG's own size, or 1024. Prefer this for anything you can express as shapes and text: it's free, instant, offline, exact, and the SVG stays editable. The output format follows the file extension (.png keeps transparency; .jpg is flattened onto white).`,
      ``,
      ...imageSection,
      ``,
      `Paths must be relative to the project root (never use ../ to escape it — it will be rejected). Only use devtopflow:file when the user explicitly asks you to create, write, or scaffold a file — use plain fenced code blocks for ordinary examples that shouldn't be written to disk. Never nest a fenced code block inside a devtopflow:file block's contents (e.g. when the file itself is markdown) — it will be mistaken for the closing fence and truncate the file.`,
    ].join("\n"),
  };
}

/** Extracts every devtopflow:file block from a finished assistant response. */
export function extractFileDirectives(text: string): { path: string; content: string }[] {
  const matches: { path: string; content: string }[] = [];
  for (const m of text.matchAll(FILE_BLOCK)) {
    matches.push({ path: m[1], content: m[2] });
  }
  return matches;
}

/** Extracts every devtopflow:read request from a finished assistant response. */
export function extractReadRequests(text: string): string[] {
  return [...text.matchAll(READ_BLOCK)].map((m) => m[1]);
}

/** `path="a.png" size="1024x1024"` → { path: "a.png", size: "1024x1024" }. */
function parseAttributes(header: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of header.matchAll(/([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

export interface ImageDirective {
  path: string;
  /** The generative prompt, for `devtopflow:image`. */
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
}

export interface DrawDirective {
  path: string;
  svg: string;
  width?: number;
  height?: number;
}

export function extractImageDirectives(text: string): ImageDirective[] {
  const out: ImageDirective[] = [];
  for (const m of text.matchAll(IMAGE_BLOCK)) {
    const attrs = parseAttributes(m[1]);
    if (!attrs.path) continue;
    // The prompt normally lives in the block body, but a model that packed it
    // into a prompt="…" attribute instead shouldn't silently generate nothing.
    const prompt = (m[2].trim() || attrs.prompt || "").trim();
    out.push({
      path: attrs.path,
      prompt,
      size: normalizeImageSize(attrs.size),
      quality: normalizeImageQuality(attrs.quality),
    });
  }
  return out;
}

export function extractDrawDirectives(text: string): DrawDirective[] {
  const out: DrawDirective[] = [];
  for (const m of text.matchAll(DRAW_BLOCK)) {
    const attrs = parseAttributes(m[1]);
    if (!attrs.path) continue;
    const width = Number(attrs.width);
    const height = Number(attrs.height);
    out.push({
      path: attrs.path,
      svg: m[2].trim(),
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
    });
  }
  return out;
}

/** Writes every directive to disk, refusing anything that would escape projectRoot. */
export async function applyFileDirectives(projectRoot: string, text: string): Promise<AppliedFile[]> {
  const directives = extractFileDirectives(text);
  const results: AppliedFile[] = [];
  for (const { path, content } of directives) {
    const resolved = resolveWithinRoot(projectRoot, path);
    if (!resolved) {
      results.push({ path, ok: false, error: "path escapes the open project folder — refused" });
      continue;
    }
    try {
      await createFile(resolved, content);
      results.push({ path, ok: true });
    } catch (e) {
      results.push({ path, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);

/** Both image blocks write binary raster data, so the target really does have to be a .png/.jpg. */
function rejectNonImagePath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(ext)) return undefined;
  return `"${ext || "no extension"}" isn't an image format — use .png, .jpg or .jpeg (plain SVG files go through devtopflow:file instead)`;
}

/**
 * Runs every devtopflow:draw and devtopflow:image block in a response, writing
 * real image bytes into the project. Draw blocks run first: they're free and
 * instant, so a response mixing both never bills for a generation when the
 * cheap half was going to fail anyway on a bad path.
 */
export async function applyImageDirectives(
  projectRoot: string,
  text: string,
  opts: { openaiKey?: string; signal?: AbortSignal } = {}
): Promise<AppliedImage[]> {
  const results: AppliedImage[] = [];

  for (const { path, svg, width, height } of extractDrawDirectives(text)) {
    const base: AppliedImage = { path, ok: false, kind: "drawn" };
    const badExtension = rejectNonImagePath(path);
    if (badExtension) {
      results.push({ ...base, error: badExtension });
      continue;
    }
    const resolved = resolveWithinRoot(projectRoot, path);
    if (!resolved) {
      results.push({ ...base, error: "path escapes the open project folder — refused" });
      continue;
    }
    if (!/<svg[\s>]/i.test(svg)) {
      results.push({ ...base, error: "the block body wasn't an <svg> element" });
      continue;
    }
    try {
      const format = formatFromPath(path);
      const image = await renderSvgToImage(svg, { width, height, format });
      await createBinaryFile(resolved, base64ToBytes(image.base64));
      results.push({
        ...base,
        ok: true,
        absolutePath: resolved,
        detail: width && height ? `${width}×${height} SVG` : "SVG",
      });
    } catch (e) {
      results.push({ ...base, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const { path, prompt, size, quality } of extractImageDirectives(text)) {
    const base: AppliedImage = { path, ok: false, kind: "generated", size, quality };
    const badExtension = rejectNonImagePath(path);
    if (badExtension) {
      results.push({ ...base, error: badExtension });
      continue;
    }
    const resolved = resolveWithinRoot(projectRoot, path);
    if (!resolved) {
      results.push({ ...base, error: "path escapes the open project folder — refused" });
      continue;
    }
    if (!opts.openaiKey) {
      results.push({ ...base, error: "no OpenAI API key set — add one in Settings, or ask for a devtopflow:draw (SVG) image instead" });
      continue;
    }
    if (!prompt) {
      results.push({ ...base, error: "the block had no prompt in its body" });
      continue;
    }
    try {
      const format = formatFromPath(path);
      const image = await generateImage(opts.openaiKey, prompt, { size, quality, format, signal: opts.signal });
      await createBinaryFile(resolved, base64ToBytes(image.base64));
      // Pricing/budget stays with the caller, which owns the rate table; this
      // layer only reports what was actually generated and at what tier.
      results.push({ ...base, ok: true, absolutePath: resolved, detail: `${size} ${quality}` });
    } catch (e) {
      results.push({ ...base, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return results;
}

/** Reads every requested file, refusing anything that would escape projectRoot, and packages the results as one system message for the follow-up turn. */
export async function buildReadResultsMessage(projectRoot: string, paths: string[]): Promise<ChatMessage> {
  const sections: string[] = [];
  for (const path of paths) {
    const resolved = resolveWithinRoot(projectRoot, path);
    if (!resolved) {
      sections.push(`\`${path}\`: refused — path escapes the open project folder.`);
      continue;
    }
    try {
      const content = await readFile(resolved);
      sections.push(`\`${path}\`:\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``);
    } catch (e) {
      sections.push(`\`${path}\`: couldn't read it — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    role: "system",
    content: `Here are the file(s) you asked to read:\n\n${sections.join("\n\n")}\n\nNow answer the user's original question using this.`,
  };
}

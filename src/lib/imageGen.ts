// DevTop Flow — image generation / rasterization.
//
// Two independent ways to end up with a real .png/.jpg on disk:
//
//  1. `renderSvgToImage` — deterministic, offline, free. The model writes SVG
//     (which every model can do) and the app rasterizes it in the webview's own
//     canvas. Works with Claude, DeepSeek and local Ollama models too, none of
//     which have an image-generation endpoint at all.
//  2. `generateImage` — a real generative image model (OpenAI's gpt-image-1),
//     for photographic/illustrative output that no amount of hand-written SVG
//     will produce. Needs the OpenAI key from Settings, and costs money per
//     image, so it's metered through the same budget tracker as chat.
//
// Both hand back raw base64 + a mime type; writing to disk is the caller's job
// (createBinaryFile), so path guardrails stay in one place (agentTools).

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { parseDataUrl } from "./fileSystem";

export type ImageFormat = "png" | "jpeg";

export interface GeneratedImage {
  mimeType: string;
  /** Raw base64, no `data:` prefix. */
  base64: string;
}

/** png vs jpeg from the target file's extension — the extension is the source of truth, not whatever the model asked for. */
export function formatFromPath(path: string): ImageFormat {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext === "jpg" || ext === "jpeg" ? "jpeg" : "png";
}

/**
 * Rasterizes SVG source to PNG/JPEG bytes using an offscreen canvas.
 *
 * The SVG goes in as a data: URL (allowed by the app's CSP `img-src ... data:`)
 * and is drawn as an <img>, so any script inside it never executes — the same
 * safety property the existing SVG preview relies on. JPEG gets an explicit
 * white background first, since JPEG has no alpha channel and an unpainted
 * canvas would otherwise come out black.
 */
export async function renderSvgToImage(
  svgSource: string,
  opts: { width?: number; height?: number; format?: ImageFormat; quality?: number; background?: string } = {}
): Promise<GeneratedImage> {
  const format = opts.format ?? "png";
  const intrinsic = readSvgDimensions(svgSource);
  const width = Math.round(opts.width ?? intrinsic.width ?? 1024);
  const height = Math.round(opts.height ?? intrinsic.height ?? 1024);
  const svg = ensureSvgDimensions(svgSource, width, height);

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = await loadImage(url);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("couldn't get a 2D canvas context to rasterize the image");

  const background = opts.background ?? (format === "jpeg" ? "#ffffff" : undefined);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);

  const dataUrl = canvas.toDataURL(format === "jpeg" ? "image/jpeg" : "image/png", opts.quality ?? 0.92);
  return parseDataUrl(dataUrl);
}

/** A blank canvas of a given size — what "create an empty .png" has to mean, since a zero-byte .png isn't a valid image any viewer can open. */
export async function renderBlankImage(
  width: number,
  height: number,
  format: ImageFormat,
  background?: string
): Promise<GeneratedImage> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("couldn't get a 2D canvas context to create the image");
  // PNG keeps its transparency unless asked otherwise; JPEG can't, so it gets white.
  const fill = background ?? (format === "jpeg" ? "#ffffff" : undefined);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, width, height);
  }
  const dataUrl = canvas.toDataURL(format === "jpeg" ? "image/jpeg" : "image/png");
  return parseDataUrl(dataUrl);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(
        new Error("the SVG couldn't be parsed as an image (malformed markup, or it references something external)")
      );
    img.src = src;
  });
}

/** Intrinsic size from width/height attributes, else the viewBox. */
function readSvgDimensions(svg: string): { width?: number; height?: number } {
  const attr = (name: string) => {
    const m = svg.match(new RegExp(`<svg[^>]*\\s${name}\\s*=\\s*["']([\\d.]+)`, "i"));
    return m ? Number(m[1]) : undefined;
  };
  const width = attr("width");
  const height = attr("height");
  if (width && height) return { width, height };
  const viewBox = svg.match(/<svg[^>]*\sviewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  return {};
}

/**
 * An <svg> with no width/height rasterizes at a browser default (often 300x150,
 * squashing the drawing), so stamp the resolved size onto the root element
 * before rendering. A viewBox, if present, is left alone — that's what keeps
 * the drawing scaled correctly into the new size.
 */
function ensureSvgDimensions(svg: string, width: number, height: number): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_full, attrs: string) => {
    const stripped = attrs.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, "");
    return `<svg${stripped} width="${width}" height="${height}">`;
  });
}

export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536" | "auto";
export type ImageQuality = "low" | "medium" | "high" | "auto";

/** Nearest size the API actually accepts — a model will happily ask for "800x600", which is a hard error otherwise. */
export function normalizeImageSize(requested: string | undefined): ImageSize {
  if (!requested) return "1024x1024";
  const value = requested.trim().toLowerCase();
  if (value === "auto" || value === "1024x1024" || value === "1536x1024" || value === "1024x1536") {
    return value as ImageSize;
  }
  const m = value.match(/^(\d+)\s*[x×]\s*(\d+)$/);
  if (!m) return "1024x1024";
  const ratio = Number(m[1]) / Number(m[2]);
  if (ratio > 1.2) return "1536x1024";
  if (ratio < 0.83) return "1024x1536";
  return "1024x1024";
}

export function normalizeImageQuality(requested: string | undefined): ImageQuality {
  const value = (requested ?? "").trim().toLowerCase();
  return value === "low" || value === "medium" || value === "high" || value === "auto"
    ? (value as ImageQuality)
    : "medium";
}

export interface GenerateImageOptions {
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  background?: "transparent" | "opaque" | "auto";
  signal?: AbortSignal;
}

/**
 * OpenAI Images API (gpt-image-1). Routed through Tauri's Rust-side HTTP client
 * for the same reason every other provider call is (see modelProvider.ts) —
 * the webview's origin makes plain fetch subject to CORS behavior this app has
 * no control over. gpt-image-1 always returns b64_json, never a URL.
 */
export async function generateImage(
  apiKey: string,
  prompt: string,
  opts: GenerateImageOptions = {}
): Promise<GeneratedImage> {
  const format = opts.format ?? "png";
  const res = await tauriFetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size: opts.size ?? "1024x1024",
      quality: opts.quality ?? "medium",
      output_format: format,
      // Transparency is PNG-only; asking for it on a JPEG is an API error.
      background: format === "png" ? opts.background ?? "auto" : undefined,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text || res.statusText;
    try {
      message = JSON.parse(text).error?.message ?? message;
    } catch {
      /* body wasn't JSON — keep the raw text */
    }
    throw new Error(`HTTP ${res.status}: ${message}`);
  }

  const data = await res.json();
  const base64 = data?.data?.[0]?.b64_json;
  if (!base64) throw new Error("the image API returned no image data");
  return { mimeType: format === "jpeg" ? "image/jpeg" : "image/png", base64 };
}

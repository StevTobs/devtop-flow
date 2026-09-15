// DevTop Flow — Model Provider Abstraction Layer
// One interface, many backends: Anthropic Claude, OpenAI-compatible (ChatGPT / DeepSeek), and local (Ollama).
// This is the core seam described in the build plan (Section 4). Everything else in the app
// talks to `ModelProvider`, never to a specific vendor SDK directly.

import type { UsageInfo } from "./pricing";
// Every outbound call in this file goes through Tauri's Rust-side HTTP
// client rather than the webview's own `fetch`. The webview's origin on
// Windows (https://tauri.localhost) makes plain `fetch` subject to normal
// browser CORS behavior — some hosts (Ollama's own origin allowlist) reject
// it outright, and others (api.anthropic.com, api.openai.com,
// api.deepseek.com) depend on the request's Origin header being handled the
// way *that specific host* expects, which isn't guaranteed. This was only
// ever verified for Ollama, and only in the built .exe (`tauri dev` serves
// the frontend from plain http://localhost, which doesn't hit this at all) —
// routing every provider through tauriFetch sidesteps the whole class of
// bug, since CORS is a browser-enforced concept that doesn't apply to a
// native client.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export type Role = "system" | "user" | "assistant";

/** A single image attached to a message — e.g. a design mockup the model should look at. */
export interface ChatImage {
  mimeType: string;
  /** Raw base64, no `data:` prefix. */
  dataBase64: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  image?: ChatImage;
}

export type Vendor = "anthropic" | "openai" | "deepseek" | "ollama";

export type ThinkingMode = "off" | "low" | "medium" | "high";

const THINKING_BUDGETS: Record<Exclude<ThinkingMode, "off">, number> = {
  low: 2000,
  medium: 6000,
  high: 12000,
};

export interface StreamChunk {
  delta: string;
  done: boolean;
  usage?: UsageInfo;
}

/** Per-request knobs from Agent Settings (agent-control-panel-prompt.md §1) — every provider gets the same shape, and ignores whatever it can't support. */
export interface ChatOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingMode?: ThinkingMode;
  /** Only used when thinkingMode !== "off"; falls back to a mode-based default otherwise. */
  maxThinkingTokens?: number;
}

export interface ModelProvider {
  id: string;
  label: string;
  kind: "cloud" | "local";
  vendor: Vendor;
  /** Async generator so the UI can stream tokens as they arrive. `options.signal` supports forced-stop (e.g. @stop / the Stop control). */
  chat(messages: ChatMessage[], onChunk: (chunk: StreamChunk) => void, options?: ChatOptions): Promise<void>;
}

/** Anthropic Claude — cloud, primary path. One instance per model id. */
export class ClaudeProvider implements ModelProvider {
  kind: "cloud" = "cloud";
  vendor: Vendor = "anthropic";

  constructor(public id: string, public label: string, private apiKey: string, private model: string) {}

  async chat(messages: ChatMessage[], onChunk: (c: StreamChunk) => void, options?: ChatOptions) {
    // Multiple system messages (tool-capability + a user's custom system
    // prompt override) collapse into one — Anthropic only accepts a single
    // top-level `system` field.
    const systemText = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n") || undefined;
    const turnMessages = messages.filter((m) => m.role !== "system");

    // Cache breakpoints: Anthropic only caches a prefix if it's explicitly
    // marked, unlike OpenAI/DeepSeek's automatic caching. The system/tool
    // prompt and everything up through the last *historical* turn are
    // resent verbatim every request (that's the point of persisting chat
    // history to disk — build plan §7), so marking them lets Anthropic
    // serve them from cache instead of reprocessing — cache_read tokens on
    // the next turn, not full-price input.
    const anthropicMessages = turnMessages.map((m, i) => {
      const isLastHistoricalTurn = i === turnMessages.length - 2;
      const cacheControl = isLastHistoricalTurn ? { cache_control: { type: "ephemeral" } } : {};
      if (m.image) {
        return {
          role: m.role,
          content: [
            { type: "image", source: { type: "base64", media_type: m.image.mimeType, data: m.image.dataBase64 } },
            { type: "text", text: m.content, ...cacheControl },
          ],
        };
      }
      if (!isLastHistoricalTurn) return { role: m.role, content: m.content };
      return { role: m.role, content: [{ type: "text", text: m.content, ...cacheControl }] };
    });

    const thinkingMode = options?.thinkingMode ?? "off";
    const thinkingEnabled = thinkingMode !== "off";
    // Extended thinking budget: use the user's explicit token count if given,
    // else a sane default per mode.
    const thinkingBudget = options?.maxThinkingTokens ?? THINKING_BUDGETS[thinkingMode as Exclude<ThinkingMode, "off">];
    // Anthropic requires max_tokens to exceed the thinking budget, and
    // requires temperature to be unset (defaults to 1) while thinking is on.
    const maxTokens = thinkingEnabled
      ? Math.max(options?.maxOutputTokens ?? 8192, thinkingBudget + 1024)
      : options?.maxOutputTokens ?? 8192;

    const sendRequest = (includeTemperature: boolean) =>
      tauriFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          // Anthropic blocks direct browser-origin fetch by default; a Tauri
          // webview is treated the same way, so this opts back in.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: this.model,
          // 2048 was cutting off multi-file scaffolding responses mid-file —
          // an incomplete fenced ```devtopflow:file block never matches the
          // extraction regex, so the response silently produced no files at all.
          max_tokens: maxTokens,
          stream: true,
          messages: anthropicMessages,
          system: systemText ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }] : undefined,
          temperature: thinkingEnabled || !includeTemperature ? undefined : options?.temperature,
          thinking: thinkingEnabled ? { type: "enabled", budget_tokens: thinkingBudget } : undefined,
        }),
        signal: options?.signal,
      });

    let res = await sendRequest(true);
    // Newer models (e.g. claude-opus-5) reject an explicit `temperature`
    // outright instead of just ignoring it — retry once without it rather
    // than hardcoding which model generations do this, since that list will
    // only grow and go stale.
    if (!res.ok && res.status === 400) {
      const probe = await res.clone().text().catch(() => "");
      if (/temperature/i.test(probe) && /deprecated|not supported|unsupported/i.test(probe)) {
        res = await sendRequest(false);
      }
    }
    await throwIfErrorResponse(res);

    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    await streamSSE(res, (json) => {
      if (json.type === "content_block_delta" && json.delta?.text) {
        onChunk({ delta: json.delta.text, done: false });
      }
      if (json.type === "message_start") {
        const u = json.message?.usage;
        if (u) {
          inputTokens = u.input_tokens ?? 0;
          cacheReadTokens = u.cache_read_input_tokens ?? 0;
          cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
        }
      }
      if (json.type === "message_delta" && json.usage) {
        onChunk({
          delta: "",
          done: false,
          usage: {
            inputTokens,
            outputTokens: json.usage.output_tokens ?? 0,
            cacheHitTokens: cacheReadTokens,
            cacheWriteTokens,
          },
        });
      }
      if (json.type === "message_stop") onChunk({ delta: "", done: true });
    });
  }
}

/** OpenAI-compatible — covers ChatGPT and DeepSeek's hosted API (same wire format). Cloud, primary path. */
export class OpenAICompatibleProvider implements ModelProvider {
  kind: "cloud" = "cloud";

  constructor(
    public id: string,
    public label: string,
    private baseUrl: string, // e.g. https://api.openai.com/v1 or https://api.deepseek.com/v1
    private apiKey: string,
    private model: string,
    public vendor: Vendor = "openai"
  ) {}

  async chat(messages: ChatMessage[], onChunk: (c: StreamChunk) => void, options?: ChatOptions) {
    const wireMessages = messages.map((m) =>
      m.image
        ? {
            role: m.role,
            content: [
              { type: "text", text: m.content },
              { type: "image_url", image_url: { url: `data:${m.image.mimeType};base64,${m.image.dataBase64}` } },
            ],
          }
        : { role: m.role, content: m.content }
    );

    const res = await tauriFetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: wireMessages,
        stream: true,
        // Left unset, some providers (DeepSeek defaults to 4096) cap output
        // well below what a multi-file scaffolding response needs — an
        // incomplete fenced ```devtopflow:file block silently produces no file.
        max_tokens: options?.maxOutputTokens ?? 8192,
        temperature: options?.temperature,
        // Ask for a final usage chunk (OpenAI & DeepSeek both support this) —
        // DeepSeek's usage object includes prompt_cache_hit_tokens / prompt_cache_miss_tokens.
        stream_options: { include_usage: true },
      }),
      signal: options?.signal,
    });
    await throwIfErrorResponse(res);
    await streamSSE(res, (json) => {
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) onChunk({ delta, done: false });
      if (json.usage) {
        const u = json.usage;
        onChunk({
          delta: "",
          done: false,
          usage: {
            inputTokens: u.prompt_tokens ?? 0,
            outputTokens: u.completion_tokens ?? 0,
            cacheHitTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
            cacheMissTokens: u.prompt_cache_miss_tokens,
          },
        });
      }
      if (json.choices?.[0]?.finish_reason) onChunk({ delta: "", done: true });
    });
  }
}

/** Local model via Ollama — secondary/optional path, no API key needed, no cost. */
export class OllamaProvider implements ModelProvider {
  kind: "local" = "local";
  vendor: Vendor = "ollama";
  id: string;
  label: string;

  constructor(model: string, private baseUrl = DEFAULT_OLLAMA_BASE_URL) {
    this.id = `ollama:${model}`;
    this.label = `${model} (local)`;
    this.model = model;
  }
  private model: string;

  async chat(messages: ChatMessage[], onChunk: (c: StreamChunk) => void, options?: ChatOptions) {
    const wireMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
      images: m.image ? [m.image.dataBase64] : undefined,
    }));
    const res = await tauriFetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      // num_predict: many Ollama models default to a low prediction cap that
      // truncates multi-file scaffolding responses mid-file. `think` is
      // best-effort — only reasoning-capable local models (deepseek-r1,
      // qwen3, …) act on it; others ignore the unknown field.
      body: JSON.stringify({
        model: this.model,
        messages: wireMessages,
        stream: true,
        think: options?.thinkingMode && options.thinkingMode !== "off" ? true : undefined,
        options: {
          num_predict: options?.maxOutputTokens ?? 8192,
          temperature: options?.temperature,
        },
      }),
      signal: options?.signal,
    });
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const json = JSON.parse(line);
        if (json.message?.content) onChunk({ delta: json.message.content, done: false });
        if (json.done) {
          onChunk({
            delta: "",
            done: false,
            usage: { inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 },
          });
          onChunk({ delta: "", done: true });
        }
      }
    }
  }
}

/**
 * Anthropic/OpenAI return a plain JSON object (not SSE) on error responses —
 * no line starts with `data:`, so streamSSE would silently skip the entire
 * body and resolve as if nothing happened, leaving the caller waiting
 * forever on an empty reply with no error. Check status first so real
 * failures (bad key, no credit, invalid model, etc.) actually surface.
 */
async function throwIfErrorResponse(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  let message = text || res.statusText;
  try {
    const parsed = JSON.parse(text);
    message = parsed.error?.message ?? parsed.message ?? message;
  } catch {
    /* body wasn't JSON — fall back to the raw text already assigned above */
  }
  throw new Error(`HTTP ${res.status}: ${message}`);
}

/** Shared SSE reader for Anthropic / OpenAI-style `data: {...}` streams. */
async function streamSSE(res: Response, onEvent: (json: any) => void) {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore partial/non-JSON keepalive lines */
      }
    }
  }
}

const MANUAL_OLLAMA_MODELS_KEY = "devtopflow.manualOllamaModels";
const OLLAMA_BASE_URL_KEY = "devtopflow.ollamaBaseUrl";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/** Ollama's host:port, in case it's not running on the default local port. */
export function loadOllamaBaseUrl(): string {
  return localStorage.getItem(OLLAMA_BASE_URL_KEY) || DEFAULT_OLLAMA_BASE_URL;
}

export function saveOllamaBaseUrl(baseUrl: string): void {
  localStorage.setItem(OLLAMA_BASE_URL_KEY, baseUrl);
}

/**
 * Models the user typed in manually (API Keys panel → Ollama → Model Name).
 * Exists because auto-detection (below) depends on Ollama already running and
 * reachable at app launch — if it's started later, or the model was pulled
 * after that one-shot check, auto-detect never sees it until a restart.
 */
export function loadManualOllamaModels(): string[] {
  try {
    const raw = localStorage.getItem(MANUAL_OLLAMA_MODELS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveManualOllamaModels(models: string[]): void {
  localStorage.setItem(MANUAL_OLLAMA_MODELS_KEY, JSON.stringify(models));
}

export interface OllamaStatus {
  /** True only if the server actually answered — distinguishes "not running" from "running, nothing pulled yet". */
  running: boolean;
  models: string[];
  /** The raw failure reason (network error, ACL scope rejection, HTTP status, …) — shown in the UI so a bad detection doesn't have to be diagnosed blind. */
  error?: string;
}

/**
 * Detect a locally running Ollama server (build plan §6) and return the models
 * it has pulled — the same information `ollama list` shows, straight from the
 * API (GET /api/tags) so the UI can offer a dropdown instead of free typing.
 */
export async function checkOllamaStatus(baseUrl = DEFAULT_OLLAMA_BASE_URL): Promise<OllamaStatus> {
  try {
    const controller = new AbortController();
    // Generous timeout — this is Tauri's Rust-side HTTP client via IPC, not a
    // raw browser fetch, so it has more startup overhead on a cold call.
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await tauriFetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { running: false, models: [], error: `HTTP ${res.status} ${res.statusText}` };
    const data = await res.json();
    const models = (data.models ?? []).map((m: { name: string }) => m.name);
    return { running: true, models };
  } catch (e) {
    return { running: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Model discovery: once a key is entered, ask the provider what's actually
 * available instead of hardcoding a single model id (build plan §4.4 — model
 * registry should reflect real models, incl. pricing/context info where the
 * API exposes it). Falls back to a small known-good default list if the
 * lookup fails (bad key, offline, endpoint not reachable yet).
 */
export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  try {
    const res = await tauriFetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data ?? []).map((m: { id: string }) => m.id);
  } catch {
    return [];
  }
}

export async function listOpenAICompatibleModels(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const res = await tauriFetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data ?? []).map((m: { id: string }) => m.id).sort();
  } catch {
    return [];
  }
}

const FALLBACK_MODELS = {
  anthropic: ["claude-sonnet-5", "claude-opus-5"],
  openai: ["gpt-4.1", "gpt-4.1-mini"],
  deepseek: ["deepseek-chat", "deepseek-coder"],
};

/** Registry: one ModelProvider entry per discovered (or fallback) model. UI reads this list to populate the model picker. */
export function buildProviderRegistry(opts: {
  anthropicKey?: string;
  anthropicModels?: string[];
  openaiKey?: string;
  openaiModels?: string[];
  deepseekKey?: string;
  deepseekModels?: string[];
  ollamaModels?: string[];
  ollamaBaseUrl?: string;
}): ModelProvider[] {
  const providers: ModelProvider[] = [];

  if (opts.anthropicKey) {
    const models = opts.anthropicModels?.length ? opts.anthropicModels : FALLBACK_MODELS.anthropic;
    for (const m of models) providers.push(new ClaudeProvider(`claude:${m}`, m, opts.anthropicKey, m));
  }

  if (opts.openaiKey) {
    const models = opts.openaiModels?.length ? opts.openaiModels : FALLBACK_MODELS.openai;
    for (const m of models)
      providers.push(new OpenAICompatibleProvider(`chatgpt:${m}`, m, "https://api.openai.com/v1", opts.openaiKey, m));
  }

  if (opts.deepseekKey) {
    const models = opts.deepseekModels?.length ? opts.deepseekModels : FALLBACK_MODELS.deepseek;
    for (const m of models)
      providers.push(
        new OpenAICompatibleProvider(`deepseek:${m}`, m, "https://api.deepseek.com/v1", opts.deepseekKey, m, "deepseek")
      );
  }

  for (const m of opts.ollamaModels ?? []) providers.push(new OllamaProvider(m, opts.ollamaBaseUrl));
  return providers;
}

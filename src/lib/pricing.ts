// Token usage → cost conversion (build plan §8 "Token/cost estimator").
// Rates below are editable best-effort estimates, not a live pricing feed —
// update PRICING as providers change their published rates.

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  /** DeepSeek: prompt_cache_hit_tokens. Anthropic: cache_read_input_tokens. */
  cacheHitTokens?: number;
  /** DeepSeek: prompt_cache_miss_tokens (billed at the normal input rate). */
  cacheMissTokens?: number;
  /** Anthropic only: cache_creation_input_tokens (writing new entries to the cache). */
  cacheWriteTokens?: number;
}

interface ModelRate {
  inputPerM: number;
  outputPerM: number;
  cacheHitPerM?: number;
  cacheWritePerM?: number;
}

const RATES: Record<string, ModelRate> = {
  // Anthropic — cache write costs +25% over base input, cache read is ~10% of base input.
  "anthropic:claude-opus": { inputPerM: 15, outputPerM: 75, cacheHitPerM: 1.5, cacheWritePerM: 18.75 },
  "anthropic:claude-sonnet": { inputPerM: 3, outputPerM: 15, cacheHitPerM: 0.3, cacheWritePerM: 3.75 },
  "anthropic:claude-haiku": { inputPerM: 0.8, outputPerM: 4, cacheHitPerM: 0.08, cacheWritePerM: 1 },
  "anthropic:default": { inputPerM: 3, outputPerM: 15, cacheHitPerM: 0.3, cacheWritePerM: 3.75 },

  "openai:gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6, cacheHitPerM: 0.2 },
  "openai:gpt-4.1": { inputPerM: 2, outputPerM: 8, cacheHitPerM: 1 },
  "openai:default": { inputPerM: 2, outputPerM: 8, cacheHitPerM: 1 },

  // DeepSeek — cache hit vs miss is a first-class distinction in their API/pricing.
  "deepseek:default": { inputPerM: 0.27, outputPerM: 1.1, cacheHitPerM: 0.07 },

  "ollama:default": { inputPerM: 0, outputPerM: 0 },
};

function lookupRate(provider: string, modelId: string): ModelRate {
  const key = Object.keys(RATES).find((k) => k.startsWith(`${provider}:`) && modelId.includes(k.split(":")[1]));
  return RATES[key ?? `${provider}:default`] ?? RATES["openai:default"];
}

/** Static approximate rate — not a live feed. Update as needed. */
const USD_TO_THB = 36.0;

export interface CostBreakdown {
  usd: number;
  thb: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  line: string;
}

export function estimateCost(provider: "anthropic" | "openai" | "deepseek" | "ollama", modelId: string, usage: UsageInfo): CostBreakdown {
  const rate = lookupRate(provider, modelId);

  const cacheHit = usage.cacheHitTokens ?? 0;
  const cacheMiss = usage.cacheMissTokens ?? (usage.inputTokens ?? 0) - cacheHit;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const output = usage.outputTokens ?? 0;

  const hitRate = rate.cacheHitPerM ?? rate.inputPerM;
  const writeRate = rate.cacheWritePerM ?? rate.inputPerM;

  const usd =
    (Math.max(cacheHit, 0) / 1_000_000) * hitRate +
    (Math.max(cacheMiss, 0) / 1_000_000) * rate.inputPerM +
    (Math.max(cacheWrite, 0) / 1_000_000) * writeRate +
    (Math.max(output, 0) / 1_000_000) * rate.outputPerM;

  const thb = usd * USD_TO_THB;

  const parts: string[] = [];
  if (cacheHit > 0) parts.push(`${cacheHit} cache hit`);
  if (cacheMiss > 0) parts.push(`${cacheMiss} cache miss`);
  if (cacheWrite > 0) parts.push(`${cacheWrite} cache write`);
  if (output > 0) parts.push(`${output} output`);

  return {
    usd,
    thb,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    outputTokens: output,
    line: parts.join(" · "),
  };
}

/**
 * Per-image price for generated images (OpenAI gpt-image-1), which are billed
 * per image at a quality/size tier rather than per token — the token-rate math
 * above doesn't apply at all. Same best-effort-estimate caveat as RATES.
 */
const IMAGE_RATES: Record<string, Record<string, number>> = {
  "1024x1024": { low: 0.011, medium: 0.042, high: 0.167 },
  "1536x1024": { low: 0.016, medium: 0.063, high: 0.25 },
  "1024x1536": { low: 0.016, medium: 0.063, high: 0.25 },
};

export function estimateImageCost(size: string, quality: string): CostBreakdown {
  const bySize = IMAGE_RATES[size] ?? IMAGE_RATES["1024x1024"];
  // "auto" lets the API pick; medium is the closest thing to a mid estimate.
  const usd = bySize[quality] ?? bySize.medium;
  const thb = usd * USD_TO_THB;
  return {
    usd,
    thb,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    outputTokens: 0,
    line: `1 image · ${size} ${quality}`,
  };
}

export function formatCost(c: CostBreakdown): string {
  return `${c.line} — $${c.usd.toFixed(5)} / ฿${c.thb.toFixed(3)}`;
}

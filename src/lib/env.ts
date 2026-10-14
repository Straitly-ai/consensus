function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Any OpenAI-compatible chat-completions endpoint works. Straitly (https://straitly.ai) is the default; OpenRouter and any
 * custom endpoint are supported. Pick one with LLM_GATEWAY=straitly|openrouter|custom, or let it be inferred from which key
 * is set (Straitly wins when both are set; an OpenRouter-only setup keeps working). Presets know the endpoint, the key
 * variable, the default model, the default sort voters and a safe concurrency; LLM_BASE_URL / LLM_API_KEY / LLM_MODEL /
 * SORT_VOTERS / SORT_CONCURRENCY override any of them.
 */
export type GatewayName = "straitly" | "openrouter" | "custom";
export interface LlmGateway {
  name: GatewayName;
  /** Full chat-completions URL. */
  url: string;
  key: string;
  defaultModel: string | null;
  /** Comma-separated extra sort voters (see src/v3/sort.ts); "" = primary model only. */
  defaultVoters: string;
  /** Sort batches in flight at once; each batch is one primary call plus one per voter. SORT_CONCURRENCY overrides. */
  concurrency: number;
  /**
   * Price used to meter a call when the gateway's response has no `usage.cost`, so DAILY_SPEND_CAP_USD never sees LLM
   * spend as zero. Presets carry a deliberately high estimate; custom gateways must set LLM_USD_PER_1K_TOKENS.
   */
  usdPer1kTokens: number;
}
/** Above the per-token price of every default model on either preset (14 Oct 2026), so a missing usage.cost over-counts. */
const PRESET_FALLBACK_USD_PER_1K = 0.002;
const PRESETS: Record<GatewayName, { base: string | null; keyVar: string; defaultModel: string | null; defaultVoters: string; concurrency: number }> = {
  // Default, tuned for production plans (Growth and above, 200+ requests in flight): 60 batches with the 2-of-3 vote, so
  // 180 calls in flight; the voter ids are the Straitly equivalents of the OpenRouter voters below. On the starter plan
  // (64 in flight) set SORT_VOTERS= (empty) to keep full coverage, or SORT_CONCURRENCY=20 to keep the vote.
  straitly: { base: "https://api.straitly.ai/v1", keyVar: "STRAITLY_API_KEY", defaultModel: "deepseek/deepseek-v4-1-flash", defaultVoters: "xiaomi/mimo-v2.6-pro,gpt-6-luna", concurrency: 60 },
  openrouter: { base: "https://openrouter.ai/api/v1", keyVar: "OPENROUTER_API_KEY", defaultModel: "deepseek/deepseek-v4.1-flash", defaultVoters: "xiaomi/mimo-v2.6-flash,openai/gpt-6-luna-pro", concurrency: 160 },
  custom: { base: null, keyVar: "LLM_API_KEY", defaultModel: null, defaultVoters: "", concurrency: 20 },
};
const chatUrl = (base: string) => (/\/chat\/completions\/?$/.test(base) ? base.replace(/\/$/, "") : `${base.replace(/\/$/, "")}/chat/completions`);

function gatewayName(): GatewayName {
  const explicit = process.env.LLM_GATEWAY?.trim().toLowerCase();
  if (explicit) {
    if (!(explicit in PRESETS)) throw new Error(`LLM_GATEWAY must be one of ${Object.keys(PRESETS).join(", ")}`);
    return explicit as GatewayName;
  }
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY) return "custom";
  if (process.env.STRAITLY_API_KEY) return "straitly";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return "straitly";
}

export const env = {
  get llmGateway(): LlmGateway {
    const name = gatewayName();
    const p = PRESETS[name];
    const base = process.env.LLM_BASE_URL || p.base;
    if (!base) throw new Error("LLM_GATEWAY=custom needs LLM_BASE_URL (an OpenAI-compatible /v1 base URL)");
    const key = process.env.LLM_API_KEY || process.env[p.keyVar];
    if (!key) throw new Error(`Missing environment variable ${p.keyVar} (or LLM_API_KEY) for the ${name} LLM gateway`);
    const priceVar = process.env.LLM_USD_PER_1K_TOKENS?.trim();
    const price = priceVar ? Number(priceVar) : name === "custom" ? NaN : PRESET_FALLBACK_USD_PER_1K;
    // Fail closed: a custom gateway may not report usage.cost, and the daily spend cap must still see LLM spend.
    if (!Number.isFinite(price) || price < 0)
      throw new Error(
        name === "custom"
          ? "LLM_GATEWAY=custom needs LLM_USD_PER_1K_TOKENS (a price per 1,000 tokens, e.g. 0.002) so DAILY_SPEND_CAP_USD can meter calls when the gateway returns no usage.cost"
          : "LLM_USD_PER_1K_TOKENS must be a non-negative number",
      );
    return { name, url: chatUrl(base), key, defaultModel: p.defaultModel, defaultVoters: p.defaultVoters, concurrency: p.concurrency, usdPer1kTokens: price };
  },
  get llmModel() {
    const m = process.env.LLM_MODEL ?? this.llmGateway.defaultModel;
    if (!m) throw new Error("LLM_MODEL is required with LLM_GATEWAY=custom");
    return m;
  },
  /**
   * Extra models that vote on each sort batch; empty = the primary model decides alone. Resolved from the preset without
   * needing a key, so modules that read it at import time (sort.ts, run.ts) load even when no LLM key is configured.
   */
  get llmVoters(): string[] {
    return (process.env.SORT_VOTERS ?? PRESETS[gatewayName()].defaultVoters).split(",").map((s) => s.trim()).filter(Boolean);
  },
  /** Sort batches in flight; SORT_CONCURRENCY overrides the gateway preset. Key-free for the same reason. */
  get llmConcurrency(): number {
    return Number(process.env.SORT_CONCURRENCY ?? PRESETS[gatewayName()].concurrency);
  },
  get llmProviders() {
    return list("LLM_PROVIDERS");
  },
  get classifierModel() {
    return process.env.CLASSIFIER_MODEL ?? this.llmModel;
  },
  get twitterKey() {
    return process.env.TWITTERAPI_IO_KEY;
  },
  get serpApiKey() {
    return required("SERPAPI_KEY");
  },
  get serperKey() {
    return process.env.SERPER_API_KEY;
  },
  /** Fresh (uncached) searches allowed per visitor IP per hour. */
  get rateLimitPerHour() {
    return Number(process.env.RATE_LIMIT_PER_HOUR ?? 30);
  },
  /** Fresh searches stop for the day once this much has been spent (USD, measured per search). */
  get dailySpendCapUsd() {
    return Number(process.env.DAILY_SPEND_CAP_USD ?? 25);
  },
  get cacheTtlHours() {
    return Number(process.env.CACHE_TTL_HOURS ?? 6);
  },
  get oxylabsUsername() {
    return required("OXYLABS_USERNAME");
  },
  get oxylabsPassword() {
    return required("OXYLABS_PASSWORD");
  },
};

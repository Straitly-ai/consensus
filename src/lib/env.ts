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
 * Any OpenAI-compatible chat-completions endpoint works. Pick one with LLM_GATEWAY=openrouter|straitly|custom, or let it
 * be inferred from which key is set. Presets know the endpoint, the key variable, the default model and the default sort
 * voters; LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / SORT_VOTERS override any of them.
 */
export type GatewayName = "openrouter" | "straitly" | "custom";
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
}
const PRESETS: Record<GatewayName, { base: string | null; keyVar: string; defaultModel: string | null; defaultVoters: string; concurrency: number }> = {
  openrouter: { base: "https://openrouter.ai/api/v1", keyVar: "OPENROUTER_API_KEY", defaultModel: "deepseek/deepseek-v4.1-flash", defaultVoters: "xiaomi/mimo-v2.6-flash,openai/gpt-6-luna-pro", concurrency: 160 },
  // Straitly (https://straitly.ai) ids differ slightly from OpenRouter's; these are the closest equivalents of the voters above.
  // Its starter plan allows 64 requests in flight (3 per batch here), bigger plans are free on request.
  straitly: { base: "https://api.straitly.ai/v1", keyVar: "STRAITLY_API_KEY", defaultModel: "deepseek/deepseek-v4-1-flash", defaultVoters: "xiaomi/mimo-v2.6-pro,gpt-6-luna", concurrency: 20 },
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
  if (process.env.STRAITLY_API_KEY && !process.env.OPENROUTER_API_KEY) return "straitly";
  return "openrouter";
}

export const env = {
  get llmGateway(): LlmGateway {
    const name = gatewayName();
    const p = PRESETS[name];
    const base = process.env.LLM_BASE_URL || p.base;
    if (!base) throw new Error("LLM_GATEWAY=custom needs LLM_BASE_URL (an OpenAI-compatible /v1 base URL)");
    const key = process.env.LLM_API_KEY || process.env[p.keyVar];
    if (!key) throw new Error(`Missing environment variable ${p.keyVar} (or LLM_API_KEY) for the ${name} LLM gateway`);
    return { name, url: chatUrl(base), key, defaultModel: p.defaultModel, defaultVoters: p.defaultVoters, concurrency: p.concurrency };
  },
  get llmModel() {
    const m = process.env.LLM_MODEL ?? this.llmGateway.defaultModel;
    if (!m) throw new Error("LLM_MODEL is required with LLM_GATEWAY=custom");
    return m;
  },
  /** Extra models that vote on each sort batch; empty = the primary model decides alone. */
  get llmVoters(): string[] {
    return (process.env.SORT_VOTERS ?? this.llmGateway.defaultVoters).split(",").map((s) => s.trim()).filter(Boolean);
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

/**
 * Serializable configuration of the recap host half, split in two layers:
 *
 * - the Loader {@link Config} (composition entry in cordis.yml) carries
 *   deployment tuning: trigger cadence, truncation limits, retention —
 *   values that shape the prompt framing and therefore the cache prefix
 *   (changing any of them mid-chain re-heats the provider prefix cache);
 * - the user-facing {@link RecapSettings} namespace (`recap` in the settings
 *   document, rendered by the DSH settings shell's schema form) carries the
 *   model route: users point recap at a cheap model while the conversation
 *   itself runs on a strong one.
 *
 * Loader schema validation normally fills defaults; {@link resolveRecapConfig}
 * applies the same defaults for direct callers that bypass the Loader.
 * @module dsh-recap/config
 */
import z from 'schemastery'

/** The user-facing settings namespace id. */
export const RECAP_SETTINGS_NS = 'recap'

/** When a turn's pending deltas are submitted for generation. */
export type RecapTrigger = 'turn-end' | 'step-end' | 'manual'

/**
 * The reasoning effort of the auxiliary recap call. `'off'` disables thinking
 * outright on adapters that support it (DeepSeek: `thinking: disabled`),
 * falling back to `'low'` on routes that reject `'off'`; `'low'` requests the
 * lowest supported effort; `'follow'` leaves the adapter default untouched.
 */
export type RecapEffort = 'off' | 'low' | 'follow'

/** Tunable recap host limits (every field optional; defaults fill in). */
export interface RecapConfig {
  /** When pending deltas are submitted (see {@link RecapTrigger}); the
   *  default `step-end` lands each sentence right after its request. */
  trigger?: RecapTrigger
  /** Debounce window after the trigger event before the drain starts (ms). */
  debounceMs?: number
  /** Per text block byte cap when framing a delta (deterministic truncation). */
  textBlockLimit?: number
  /** Per tool-result byte cap when framing a delta. */
  toolResultLimit?: number
  /** Per tool-call arguments byte cap when framing a delta. */
  toolArgsLimit?: number
  /** History sentences carried in the prompt before the oldest are folded. */
  historyMaxSentences?: number
  /** Retained entries per session file (the durable recap chain cap). */
  storeMaxEntries?: number
  /** Pending-delta cap before the oldest are merged (backpressure). */
  maxPending?: number
  /** Auxiliary call deadline (ms). */
  requestTimeoutMs?: number
  /** Output cap of one recap call (tokens; a single sentence needs few). */
  maxTokens?: number
  /** Whether the model-facing recap tools are registered (default off — the
   *  tool schemas would otherwise enter every request of the session). */
  toolsEnabled?: boolean
  /** Directory override for the recap store (default: ~/.dsh/recap/sessions). */
  storeDir?: string
}

/** Schemastery schema for the plugin configuration. */
export const Config: z<RecapConfig> = z.object({
  trigger: z.union(['turn-end', 'step-end', 'manual'] as const).default('step-end'),
  debounceMs: z.number().step(1).min(0).default(1_500),
  textBlockLimit: z.number().step(1).min(64).default(4_096),
  toolResultLimit: z.number().step(1).min(64).default(2_048),
  toolArgsLimit: z.number().step(1).min(64).default(1_024),
  historyMaxSentences: z.number().step(1).min(10).default(400),
  storeMaxEntries: z.number().step(1).min(10).default(500),
  maxPending: z.number().step(1).min(10).default(200),
  requestTimeoutMs: z.number().step(1).min(1_000).default(60_000),
  maxTokens: z.number().step(1).min(16).default(120),
  toolsEnabled: z.boolean().default(false),
  storeDir: z.string(),
})

/** Fully defaulted recap host settings. */
export interface ResolvedRecapConfig {
  trigger: RecapTrigger
  debounceMs: number
  textBlockLimit: number
  toolResultLimit: number
  toolArgsLimit: number
  historyMaxSentences: number
  storeMaxEntries: number
  maxPending: number
  requestTimeoutMs: number
  maxTokens: number
  toolsEnabled: boolean
  storeDir: string | undefined
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 * @param config - Deployment-provided recap host settings.
 * @returns Complete settings consumed by the host half.
 */
export function resolveRecapConfig(config: RecapConfig | undefined): ResolvedRecapConfig {
  return {
    trigger: config?.trigger ?? 'step-end',
    debounceMs: config?.debounceMs ?? 1_500,
    textBlockLimit: config?.textBlockLimit ?? 4_096,
    toolResultLimit: config?.toolResultLimit ?? 2_048,
    toolArgsLimit: config?.toolArgsLimit ?? 1_024,
    historyMaxSentences: config?.historyMaxSentences ?? 400,
    storeMaxEntries: config?.storeMaxEntries ?? 500,
    maxPending: config?.maxPending ?? 200,
    requestTimeoutMs: config?.requestTimeoutMs ?? 60_000,
    maxTokens: config?.maxTokens ?? 120,
    toolsEnabled: config?.toolsEnabled ?? false,
    storeDir: config?.storeDir,
  }
}

// ── User-facing settings (rendered by the DSH settings shell) ───────────────

/**
 * The user-facing recap route selection: an explicit provider+model pair
 * (both must be set together), the reasoning effort of the auxiliary call,
 * and whether generation is enabled at all. Resolution order at call time:
 * this explicit pair → the session's own logged route → the host default.
 */
export interface RecapSettings {
  /** Master switch; false parks the queue (deltas keep accumulating). */
  enabled: boolean
  /** Explicit provider route (must pair with `model`). */
  provider?: string
  /** Explicit model id on {@link provider}. */
  model?: string
  /** Reasoning effort of the recap call (default `'off'`). */
  effort: RecapEffort
  /**
   * Distillation granularity: one recap sentence covers this many consecutive
   * requests (their deltas merge into one generation call). 1 — the default —
   * keeps one sentence per request. Applies live: the step-end trigger fires
   * only every N-th delta, and a drain re-packs its pending head into
   * N-sized batches before generating.
   */
  interval: number
}

/** Schemastery schema for the user-facing settings namespace. */
export const RecapSettingsSchema: z<RecapSettings> = z.object({
  enabled: z.boolean().default(true),
  provider: z.string(),
  model: z.string(),
  effort: z.union(['off', 'low', 'follow'] as const).default('off'),
  interval: z.number().step(1).min(1).max(50).default(1),
})

/** Fully defaulted user settings (absent document → schema defaults). */
export function resolveRecapSettings(value: Partial<RecapSettings> | undefined): RecapSettings {
  const rawInterval = value?.interval
  // A route pair only counts when BOTH sides are set to non-empty strings
  // (clearing both boxes in the UI writes empty strings); a half-set or
  // cleared pair is normalized away so the resolver falls back to the
  // session's own route.
  const provider = typeof value?.provider === 'string' && value.provider.trim() !== '' ? value.provider : undefined
  const model = typeof value?.model === 'string' && value.model.trim() !== '' ? value.model : undefined
  return {
    enabled: value?.enabled ?? true,
    provider: provider !== undefined && model !== undefined ? provider : undefined,
    model: provider !== undefined && model !== undefined ? model : undefined,
    effort: value?.effort ?? 'off',
    interval: typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval >= 1
      ? Math.min(Math.floor(rawInterval), 50)
      : 1,
  }
}

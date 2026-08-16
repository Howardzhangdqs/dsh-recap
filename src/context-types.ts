/**
 * Structural types for the cordis services this plugin consumes, plus the
 * Context augmentation both halves share. A third-party plugin resolves
 * outside the DSH monorepo's single cordis instance, so the upstream
 * `declare module` augmentations do not reach this Context — the members
 * below mirror the actual runtime shapes this plugin touches (the same
 * containment strategy as dsh-dashboard's context-types.ts):
 * - llm: @deepseek-ai/dsh-llm (the LlmRuntime face used for auxiliary calls)
 * - sessions: @deepseek-ai/dsh-session (the host SessionStore, read-only)
 * - settings: @deepseek-ai/dsh-settings (the user-facing recap route section)
 * - tools: @deepseek-ai/dsh-tools (optional model-tool registration)
 * - webServer: @deepseek-ai/dsh-host-webserver (the /recap/api routes)
 * - locale / dashboard: client-side services (tab registration)
 * Drift from upstream is contained to this file.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import type {
  AssistantMessage,
  ContentBlock,
  GenerateOptions,
  StreamChunk,
  TokenUsage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'

// ── Session events (structural mirror of dsh-session's SessionEvent) ───────

/** One tool invocation requested during a step. */
export interface RecapToolCallEvent {
  type: 'tool/call'
  seq: number
  time: number
  data: { turn: number; step: number; callId: string; name: string; arguments: string }
}

/** One completed tool invocation's model-facing result message. */
export interface RecapToolResultEvent {
  type: 'tool/result'
  seq: number
  time: number
  data: { turn: number; step: number; message: UserMessage; error?: { name: string; code: string } }
}

/** One user-role message entering the model-visible surface. */
export interface RecapUserMessageEvent {
  type: 'user/message'
  seq: number
  time: number
  data: UserMessage
}

/** One assembled assistant message closing a step's model stream. */
export interface RecapAssistantMessageEvent {
  type: 'assistant/message'
  seq: number
  time: number
  data: { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
}

/** Step lifecycle boundary (one model call plus its tool executions). */
export interface RecapStepBoundaryEvent {
  type: 'step/start' | 'step/end'
  seq: number
  time: number
  data: { turn: number; step: number }
}

/** Turn lifecycle boundary. */
export interface RecapTurnBoundaryEvent {
  type: 'turn/start' | 'turn/end'
  seq: number
  time: number
  data: { turn: number; reason?: string }
}

/** Route metadata snapshot (provider/model for the session's requests). */
export interface RecapRequestContextEvent {
  type: 'request/context'
  seq: number
  time: number
  data: { provider?: string; model?: string; contextWindow?: number }
}

/** Any session event this plugin folds; unknown types are skipped. */
export type RecapSessionEvent =
  | RecapToolCallEvent
  | RecapToolResultEvent
  | RecapUserMessageEvent
  | RecapAssistantMessageEvent
  | RecapStepBoundaryEvent
  | RecapTurnBoundaryEvent
  | RecapRequestContextEvent
  | { type: string; seq: number; time: number; data?: unknown }

// ── Service faces ───────────────────────────────────────────────────────────

/** One loader entry's options slice (the connection row's resolved config). */
export interface RecapLoaderEntry {
  options: { name: string; config?: unknown }
}

/** The loader face used to read the connection row's trustedHosts config. */
export interface RecapLoader {
  entries(): Iterable<RecapLoaderEntry>
}

/** The llm service face (mirror of dsh-llm's LlmRuntime slices we use). */
export interface RecapLlmService {
  /** One streaming model call (auxiliary calls pass `purpose: 'recap'`). */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  /** Registered provider routes (for the settings-page model picker). */
  listProviders(): Array<{ id?: string; name?: string } & Record<string, unknown>>
  /** Models of one provider route. */
  listModels(provider: string): Promise<Array<{ id?: string; name?: string } & Record<string, unknown>>>
}

/** The host session store face (strictly read-only). */
export interface RecapSessionStore {
  get(id: string): {
    id?: string
    header: { cwd?: string }
    /** The live session's append-only event log (immutable snapshot). */
    events?: readonly RecapSessionEvent[]
  } | undefined
  list(): Array<{ id?: string } & Record<string, unknown>>
}

/** Owner-facing handle of one registered settings namespace. */
export interface RecapSettingsScope<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
}

/** The settings service face (mirror of dsh-settings' SettingsProvider). */
export interface RecapSettingsService {
  register<T>(ns: string, schema: unknown, options?: { base?: Partial<T>; applies?: 'live' | 'restart' }): RecapSettingsScope<T>
  describe(options?: { redactSecrets?: boolean }): Array<{
    ns: string
    value?: unknown
    revision: number
    applies: 'live' | 'restart'
  }>
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** The tools service face (mirror of dsh-tools' ToolRuntime registration). */
export interface RecapToolsService {
  register(tool: unknown): () => void
}

/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface RecapWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The webServer service face this plugin uses. */
export interface RecapWebServer {
  register(route: RecapWebRoute): () => void
}

/** The invariants service face (package ownership reservation). */
export interface RecapInvariantsService {
  register(packageName: string, installer: () => void): () => void
}

/** The client locale service face (dictionary registration + language). */
export interface RecapLocaleService {
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  /** Snapshot of the active locale (live; switches re-render consumers). */
  getSnapshot(): { active: string }
}

/**
 * The client session-list feed (runtime ISessions slice; mounted under the
 * SAME `sessions` key as the host store — the planes are told apart by
 * shape, see inline.ts): `current` names the conversation the chat view is
 * rendering, which the recap inline rows key their /recap/api fetches on.
 */
export interface RecapClientSessions {
  list: {
    getSnapshot(): { current: string | undefined }
    subscribe(fn: () => void): () => void
  }
}

/** One slot registration entry as the client registry exposes it. */
export interface RecapSlotEntry {
  component: unknown
  options: { key?: string; id?: string; order?: number; priority?: number }
}

/** Registration options the recap client passes to `ctx.slots.register`. */
export interface RecapSlotRegisterOptions {
  name: string
  key?: string
  id?: string
  order?: number
  priority?: number
  /** Nav identity of a list entry (settings.section & co.): plain text or a
   *  locale-following thunk the host resolves at render time. */
  label?: string | (() => string)
  /** Locale namespace whose copy props the entry receives. */
  locale?: string
  registrant?: string
  /** Chain routing selector (returns the matched value, or null to pass on). */
  select?: (owner: unknown) => unknown
  /** Nested slot declarations the winning entry owns. The runtime allows ONE
   *  declaring entry per child slot for its whole ledger lifetime: re-declaring
   *  an already-declared child (even verbatim) throws at register time, so a
   *  takeover entry may carry a children table ONLY while the slot is still
   *  undeclared — probe with {@link RecapSlotsService.spec} first. */
  children?: Record<string, { kind: string; scope?: string }>
}

/** The client slots service face (register returns the disposer). */
export interface RecapSlotsService {
  register(options: RecapSlotRegisterOptions, component: unknown): () => void
  /**
   * Run a callback for each declaration lifetime of a slot: a no-op while
   * the slot is undeclared, so the registration waits for the declaration.
   */
  inject(key: string, callback: () => (() => void) | void): () => void
  /** Live entries of one slot (ledger heads). */
  entries(name: string): Iterable<RecapSlotEntry>
  /**
   * The declaration spec of one slot key, or undefined while undeclared —
   * the same record the runtime's duplicate-declaration probe reads, so a
   * takeover can learn whether a child slot is already owned before it
   * re-declares it. Optional: older runtimes without it report nothing.
   */
  spec?(key: string): unknown
  /** Mirror entry render crashes (contained by the runtime's boundaries). */
  onEntryError(fn: (key: string, entry: RecapSlotEntry, error: unknown, info: { abdicated: boolean }) => void): () => void
}

declare module 'cordis' {
  interface Context {
    llm: RecapLlmService
    sessions: RecapSessionStore
    settings: RecapSettingsService
    tools: RecapToolsService
    webServer: RecapWebServer
    invariants: RecapInvariantsService
    loader: RecapLoader
    /** Client-side only: the locale service (dictionaries for the recap rows). */
    locale: RecapLocaleService
    /** Client-side only: the slot registry (React-native conversation rows). */
    slots: RecapSlotsService
    /**
     * Subscribe to the session append feed (mirror of the cordis event API).
     * Returns the disposer.
     */
    on(event: 'session/event', listener: (session: { id?: string }, event: RecapSessionEvent) => void): () => void
    on(event: 'session/disposed', listener: (session: { id?: string }) => void): () => void
    /** Register a lifecycle callback (DSH-vendored cordis). */
    effect(fn: () => void | (() => void), label?: string): void
    /** Dynamically activate a callback once the listed services exist. */
    inject(deps: string[], callback: (ctx: Context) => void | (() => void)): void
  }
}

export type { ContentBlock, Context, GenerateOptions, StreamChunk, TokenUsage }

/**
 * The recap capture engine: folds a session's append-only event log into
 * per-model-request deltas ("Δ" — the NEW data one API request added to the
 * conversation), with two feeding sources merged into one idempotent fold:
 *
 * - the SEED: the session store's durable event snapshot (`session.events`),
 *   replayed once per plugin activation, covering everything before it;
 * - the MIRROR: the live `session/event` append feed, covering the store's
 *   hydration lag (the same restart boundary dsh-dashboard's llm-stats
 *   mirrors).
 *
 * Idempotence — the property that makes seed+mirror merging safe — comes from
 * two dedup sets: `seenIds` (message ids and `call:` ids already folded into
 * a delta) and `emittedKeys` (steps whose delta already closed). Replaying
 * the same event from either source is a no-op, and replaying a whole log
 * after a host restart re-covers nothing that a persisted recap entry already
 * claimed (the store's `itemIds`/`coveredKeys` seed those sets — see
 * {@link RecapCapture.prime}).
 *
 * Attribution rule: every piece of new data lands in the delta of the step
 * that PRODUCED it — the user input a step consumed, the assistant message
 * it assembled, the tool calls it requested and their results. Each message
 * is summarized exactly once (compaction-safe: a replacement summary message
 * carries fresh ids and folds as new data naturally).
 *
 * This file is strictly read-only towards the session: it only ever listens.
 * @module dsh-recap/capture
 */
import type { RecapSessionEvent } from './context-types.ts'
import type { ResolvedRecapConfig } from './config.ts'
import type { RecapStore } from './store.ts'

/** One piece of new data inside a delta (deterministic framing material). */
export interface DeltaItem {
  kind: 'user' | 'assistant' | 'tool-call' | 'tool-result'
  /** Tool name (tool-call / tool-result items). */
  name?: string
  /** Truncated content text (UTF-8-safe byte cap at framing time). */
  text: string
  /** Whether the tool result reported an error. */
  error?: boolean
}

/** The complete delta of one model request, closed at its step/end. */
export interface StepDelta {
  /** Step identity (`turn:step`, or `turn:tail` for a turn-tail flush). */
  key: string
  turn: number
  /** Step number; null for a turn-tail flush. */
  step: number | null
  /** The new data, in log order. */
  items: DeltaItem[]
  /** Ids covered (`message.id`, or `call:<callId>` for tool calls). */
  itemIds: string[]
  /** The framed JSON text — the exact bytes the prompt will embed. */
  framed: string
  /** Root callIds this request issued, in order (parallel calls share the
   *  delta) — the renderer anchors the recap after these calls' rows. */
  callIds: string[]
  /** Route the session was on when the delta closed (generation fallback). */
  route?: { provider: string; model: string }
}

/** Per-session folding state. */
/** One open step bucket: the delta under construction. */
interface StepBucket {
  turn: number
  step: number
  items: DeltaItem[]
  itemIds: string[]
  /** Root callIds this step requested, in call order — the EXACT request
   *  grouping (parallel calls of one request share this list) the renderer
   *  uses to anchor a recap after its request's own tool rows. */
  callIds: string[]
  /** callIds requested by this step whose results have NOT arrived yet — the
   *  delta must not close while a tool is still executing (the sentence would
   *  miss the result). `step/end` arriving with this set non-empty parks the
   *  bucket until its last result lands. */
  openCalls: Set<string>
}

interface CaptureState {
  seenIds: Set<string>
  emittedKeys: Set<string>
  /** User messages waiting for the next step/start to claim them. */
  pendingUser: DeltaItem[]
  pendingUserIds: string[]
  /** Open step buckets by key (closed and emitted at their step/end, or when
   *  their last tool result lands if that happens later). */
  buckets: Map<string, StepBucket>
  /** Buckets whose step/end arrived while calls were still open, keyed as in
   *  {@link CaptureState.buckets} — flushed the moment the last result lands. */
  closing: Map<string, StepBucket>
  /** callId → tool name (results name their call). */
  toolNames: Map<string, string>
  /** Last known provider/model of the session's requests. */
  route?: { provider: string; model: string }
}

/** Callbacks the capture engine notifies. */
export interface CaptureHooks {
  /** One step's delta closed (step/end or turn-tail flush). */
  onDelta(sessionId: string, delta: StepDelta): void
  /** The session's request route changed. */
  onRoute?(sessionId: string, route: { provider: string; model: string }): void
}

/** Bound a string to a UTF-8 byte cap without splitting a sequence. */
export function boundUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

/**
 * Deterministically frame delta items into the JSON text the prompt embeds.
 * The same items always produce byte-identical output (fixed key order; the
 * optional `error`/`name` fields only appear when set) — the cache contract
 * requires the framing to never drift. Exported for the queue's
 * backpressure-merge, which reframes merged items the same way.
 */
export function frameDelta(turn: number, step: number | null, items: DeltaItem[]): string {
  return JSON.stringify({
    request: step === null ? { turn } : { turn, step },
    items: items.map((item) => {
      if (item.error === true) return { kind: item.kind, name: item.name ?? 'tool', error: true, text: item.text }
      return item.name === undefined ? { kind: item.kind, text: item.text } : { kind: item.kind, name: item.name, text: item.text }
    }),
  })
}

/** Structural narrowing of one raw session event's typed data. */
function dataOf(event: RecapSessionEvent): Record<string, unknown> {
  const data = (event as { data?: unknown }).data
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
}

/** Join a message's text-ish blocks into one flattened string (images → placeholder). */
function flattenBlocks(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
    else if (typed.type === 'reasoning') {
      // The model's thinking IS recap material — the sentence should reflect
      // what the model was working out, not just its visible output.
      if (typeof typed.text === 'string' && typed.text.trim() !== '') parts.push(typed.text)
    } else if (typed.type === 'image') parts.push('[图片]')
    else if (typed.type === 'tool-call') {
      const call = block as { name?: unknown; arguments?: unknown }
      parts.push(`${typeof call.name === 'string' ? call.name : 'tool'}(${typeof call.arguments === 'string' ? call.arguments : ''})`)
    } else if (typed.type === 'tool-result') {
      const result = block as { content?: unknown }
      parts.push(flattenBlocks(Array.isArray(result.content) ? result.content : []))
    }
  }
  return parts.join('\n')
}

/**
 * The capture engine. One instance per plugin activation; cheap enough to
 * fold arbitrarily long logs synchronously (truncation bounds every item).
 */
export class RecapCapture {
  private readonly config: ResolvedRecapConfig
  private readonly hooks: CaptureHooks
  private readonly states = new Map<string, CaptureState>()
  /** Sessions whose seed replay has not completed yet (live events buffer). */
  private readonly seedPending = new Set<string>()
  private readonly buffered = new Map<string, RecapSessionEvent[]>()

  constructor(config: ResolvedRecapConfig, hooks: CaptureHooks) {
    this.config = config
    this.hooks = hooks
  }

  /** Mark a session as needing a seed replay (live events buffer until then). */
  beginSeed(sessionId: string): void {
    this.seedPending.add(sessionId)
  }

  /**
   * Complete a session's seed: adopt the store's covered ids/keys (resume),
   * fold the store's event snapshot, then drain the buffered live events in
   * arrival order. Safe to call for a session with no store file yet.
   */
  async prime(sessionId: string, store: RecapStore, events: readonly RecapSessionEvent[]): Promise<void> {
    const state = this.stateOf(sessionId)
    for (const id of await store.coveredIds(sessionId)) state.seenIds.add(id)
    for (const key of await store.coveredKeys(sessionId)) state.emittedKeys.add(key)
    for (const event of events) this.foldEvent(sessionId, state, event)
    this.seedPending.delete(sessionId)
    const buffered = this.buffered.get(sessionId) ?? []
    this.buffered.delete(sessionId)
    for (const event of buffered) this.foldEvent(sessionId, state, event)
  }

  /** Fold one live append-feed event (buffers until the seed completed). */
  handleEvent(sessionId: string, event: RecapSessionEvent): void {
    if (this.seedPending.has(sessionId)) {
      const list = this.buffered.get(sessionId)
      if (list === undefined) this.buffered.set(sessionId, [event])
      else list.push(event)
      return
    }
    this.foldEvent(sessionId, this.stateOf(sessionId), event)
  }

  /** The session's last known request route (generation fallback). */
  routeOf(sessionId: string): { provider: string; model: string } | undefined {
    return this.states.get(sessionId)?.route
  }

  /** Drop one session's folding state (dispose). */
  forget(sessionId: string): void {
    this.states.delete(sessionId)
    this.buffered.delete(sessionId)
    this.seedPending.delete(sessionId)
  }

  private stateOf(sessionId: string): CaptureState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = {
        seenIds: new Set(),
        emittedKeys: new Set(),
        pendingUser: [],
        pendingUserIds: [],
        buckets: new Map(),
        closing: new Map(),
        toolNames: new Map(),
      }
      this.states.set(sessionId, state)
    }
    return state
  }

  /** Frame one closed delta deterministically (the prompt's exact bytes). */
  private frame(turn: number, step: number | null, items: DeltaItem[]): string {
    return frameDelta(turn, step, items)
  }

  /** Close one bucket (or the turn tail) and emit its delta. */
  private emit(sessionId: string, state: CaptureState, key: string, turn: number, step: number | null, items: DeltaItem[], itemIds: string[], callIds: string[] = []): void {
    state.emittedKeys.add(key)
    if (items.length === 0) return // an aborted step left no new data
    const delta: StepDelta = {
      key,
      turn,
      step,
      items,
      itemIds,
      framed: this.frame(turn, step, items),
      callIds,
      route: state.route,
    }
    this.hooks.onDelta(sessionId, delta)
  }

  /**
   * Close one completed step bucket: one REQUEST — one delta. Parallel calls
   * share the step and therefore the delta (the exact grouping the durable
   * log records); consecutive requests each distill on their own so progress
   * interleaves with execution.
   */
  private closeBucket(sessionId: string, state: CaptureState, bucket: StepBucket): void {
    const key = `${bucket.turn}:${bucket.step}`
    this.emit(sessionId, state, key, bucket.turn, bucket.step, bucket.items, bucket.itemIds, [...bucket.callIds])
  }

  /** Bucket of one step, created on demand (mirror streams may begin mid-step). */
  private bucketOf(state: CaptureState, turn: number, step: number): StepBucket {
    const key = `${turn}:${step}`
    let bucket = state.buckets.get(key)
    if (bucket === undefined) {
      bucket = { turn, step, items: [], itemIds: [], callIds: [], openCalls: new Set() }
      state.buckets.set(key, bucket)
    }
    return bucket
  }

  /** Fold exactly one event (the shared seed/mirror core; idempotent). */
  private foldEvent(sessionId: string, state: CaptureState, event: RecapSessionEvent): void {
    const data = dataOf(event)
    switch (event.type) {
      case 'request/context': {
        const provider = typeof data.provider === 'string' ? data.provider : undefined
        const model = typeof data.model === 'string' ? data.model : undefined
        if (provider !== undefined && model !== undefined) {
          state.route = { provider, model }
          this.hooks.onRoute?.(sessionId, state.route)
        }
        return
      }
      case 'user/message': {
        const message = data as { id?: unknown; content?: unknown }
        const id = typeof message.id === 'string' ? message.id : undefined
        if (id === undefined || state.seenIds.has(id)) return
        state.seenIds.add(id)
        const text = boundUtf8(flattenBlocks(Array.isArray(message.content) ? message.content : []), this.config.textBlockLimit)
        state.pendingUser.push({ kind: 'user', text })
        state.pendingUserIds.push(id)
        return
      }
      case 'step/start': {
        const turn = data.turn
        const step = data.step
        if (typeof turn !== 'number' || typeof step !== 'number') return
        const bucket = this.bucketOf(state, turn, step)
        // The messages a step consumed arrive before its start: claim them.
        if (state.pendingUser.length > 0) {
          bucket.items.push(...state.pendingUser)
          bucket.itemIds.push(...state.pendingUserIds)
          state.pendingUser = []
          state.pendingUserIds = []
        }
        return
      }
      case 'assistant/message': {
        const turn = data.turn
        const step = data.step
        if (typeof turn !== 'number' || typeof step !== 'number') return
        const message = data.message as { id?: unknown; content?: unknown; source?: { provider?: unknown; model?: unknown } } | undefined
        const id = typeof message?.id === 'string' ? message.id : undefined
        const bucket = this.bucketOf(state, turn, step)
        if (id !== undefined) {
          if (state.seenIds.has(id)) return
          state.seenIds.add(id)
          bucket.itemIds.push(id)
        }
        const source = message?.source
        if (typeof source?.provider === 'string' && typeof source.model === 'string') {
          state.route = { provider: source.provider, model: source.model }
        }
        bucket.items.push({
          kind: 'assistant',
          text: boundUtf8(flattenBlocks(Array.isArray(message?.content) ? message.content : []), this.config.textBlockLimit),
        })
        return
      }
      case 'tool/call': {
        const turn = data.turn
        const step = data.step
        if (typeof turn !== 'number' || typeof step !== 'number') return
        const callId = typeof data.callId === 'string' ? data.callId : undefined
        const name = typeof data.name === 'string' ? data.name : 'tool'
        if (callId !== undefined) state.toolNames.set(callId, name)
        const callKey = `call:${callId ?? `${turn}:${step}:${state.seenIds.size}`}`
        if (state.seenIds.has(callKey)) return
        state.seenIds.add(callKey)
        const bucket = this.bucketOf(state, turn, step)
        bucket.itemIds.push(callKey)
        if (callId !== undefined) {
          bucket.callIds.push(callId)
          bucket.openCalls.add(callId)
        }
        bucket.items.push({
          kind: 'tool-call',
          name,
          text: boundUtf8(typeof data.arguments === 'string' ? data.arguments : '', this.config.toolArgsLimit),
        })
        return
      }
      case 'tool/result': {
        const turn = data.turn
        const step = data.step
        if (typeof turn !== 'number' || typeof step !== 'number') return
        const message = data.message as { id?: unknown; content?: unknown } | undefined
        const id = typeof message?.id === 'string' ? message.id : undefined
        if (id !== undefined && state.seenIds.has(id)) return
        if (id !== undefined) state.seenIds.add(id)
        const key = `${turn}:${step}`
        // Route into the parked bucket when the step already closed early
        // (the result IS the delta's awaited completion), else the open one.
        const parked = state.closing.get(key)
        const bucket = parked ?? this.bucketOf(state, turn, step)
        if (id !== undefined) bucket.itemIds.push(id)
        // The result's first content block carries the call correlation; the
        // name comes from the pairing tool/call the capture already recorded.
        const first = Array.isArray(message?.content) ? (message.content[0] as { toolCallId?: unknown } | undefined) : undefined
        const name = typeof first?.toolCallId === 'string' ? state.toolNames.get(first.toolCallId) : undefined
        if (typeof first?.toolCallId === 'string') bucket.openCalls.delete(first.toolCallId)
        bucket.items.push({
          kind: 'tool-result',
          name: name ?? 'tool',
          text: boundUtf8(flattenBlocks(Array.isArray(message?.content) ? message.content : []), this.config.toolResultLimit),
          error: data.error !== undefined,
        })
        // A parked bucket whose last awaited result just landed closes NOW:
        // the delta is complete (through the visible-reply gate).
        if (parked !== undefined && parked.openCalls.size === 0) {
          state.closing.delete(key)
          this.closeBucket(sessionId, state, parked)
        }
        return
      }
      case 'step/end': {
        const turn = data.turn
        const step = data.step
        if (typeof turn !== 'number' || typeof step !== 'number') return
        const key = `${turn}:${step}`
        if (state.emittedKeys.has(key)) return
        const bucket = state.buckets.get(key)
        state.buckets.delete(key)
        if (bucket === undefined) {
          // No bucket survived dedup (replay of an already-covered step):
          // still mark the key so a later re-fold cannot resurrect it.
          state.emittedKeys.add(key)
          return
        }
        // Gate: while any of this step's tool calls is still executing, the
        // delta is NOT complete — park the bucket and let the last tool/result
        // close it. (The durable log normally orders results before step/end;
        // this gate is the guarantee, not the assumption.)
        if (bucket.openCalls.size > 0) {
          state.closing.set(key, bucket)
          return
        }
        this.closeBucket(sessionId, state, bucket)
        return
      }
      case 'turn/end': {
        const turn = data.turn
        if (typeof turn !== 'number') return
        // A turn closing with a parked bucket means its tool never completed
        // (interrupted): the data is frozen as-is — close it now rather than
        // waiting for a result that will never come.
        for (const [key, parked] of [...state.closing]) {
          if (parked.turn === turn) {
            state.closing.delete(key)
            state.emittedKeys.add(key) // frozen: never re-close after flush
            this.closeBucket(sessionId, state, parked)
          }
        }
        // The turn's remaining user input that entered no step flushes as the
        // turn's tail delta.
        if (state.pendingUser.length > 0) {
          const items = state.pendingUser
          const ids = state.pendingUserIds
          state.pendingUser = []
          state.pendingUserIds = []
          const key = `${turn}:tail`
          if (!state.emittedKeys.has(key)) {
            this.emit(sessionId, state, key, turn, null, items, ids)
          }
        }
        return
      }
      default:
        return // unknown event types are informational only
    }
  }
}

/**
 * The recap generation queue: one serial drain chain per session, cross-session
 * parallel, fire-and-forget by construction — nothing in the agent loop ever
 * awaits a recap (the capture hooks run synchronously off emit events and only
 * push work here; the drain runs on its own promise).
 *
 * Per-session seriality is the cache contract's execution side: sentences are
 * appended strictly in delta order, so the k-th request's history prefix is
 * always exactly sentences 1..k-1 as persisted.
 *
 * Resilience rules:
 * - a failed generation records a `failed` entry (the delta is dropped — its
 *   ids stay covered so replay never resurrects it) and the chain continues;
 * - three consecutive failures park the drain until the next trigger (a dead
 *   route must not burn a retry storm);
 * - backpressure: when pending deltas exceed `maxPending`, the oldest are
 *   merged into one delta (their items concatenated, re-framed) so memory and
 *   latency stay bounded while the data still reaches the chain;
 * - `enabled: false` parks generation; deltas keep accumulating (bounded);
 * - session abort (dispose) cancels the in-flight call and parks the chain.
 * @module dsh-recap/queue
 */
import type { ResolvedRecapConfig, RecapSettings } from './config.ts'
import type { Context } from './context-types.ts'
import { frameDelta, type StepDelta } from './capture.ts'
import { generateRecap, type RecapCallPolicy } from './generator.ts'
import type { RecapStore, RecapStoreEntry } from './store.ts'

/** The default-model service face (optional; structural slice). */
interface DefaultModelService {
  currentSelection(): { provider?: string; model?: string } | undefined
}

/** One unit of work visible in the queue stats: WHERE the next recap will
 * land (turn/step/callIds) plus its lifecycle state — the client renders one
 * 总结中 chip per item at its exact request position, or a 限流等待 chip
 * while a rate-limited generation backs off. */
export interface RecapQueueItem {
  key: string
  turn: number
  step: number | null
  callIds: string[]
  state: 'queued' | 'generating' | 'retrying'
  /** For `retrying` items: ms until the backed-off retry fires (live value). */
  retryInMs?: number
}

/** Per-session queue state. */
interface SessionQueue {
  pending: StepDelta[]
  /** The delta currently inside the generating call (stats face). */
  inFlight: StepDelta | undefined
  draining: boolean
  aborted: boolean
  abort: AbortController
  timer: ReturnType<typeof setTimeout> | undefined
  /** Backed-off retry timer of a transiently failed generation. */
  retryTimer: ReturnType<typeof setTimeout> | undefined
  /** Consecutive transient failures of the head delta — the exponential
   *  backoff's exponent (reset on the first success). */
  transientFailures: number
  /** The retrying delta's key + deadline (the stats face marks it 'retrying'). */
  retryKey: string | undefined
  retryAt: number | undefined
  /** In-memory sentence cache (the store remains the durable truth). */
  sentences: string[] | undefined
  /** Entry counter for indexing (seeded from the store on first drain). */
  nextIndex: number | undefined
  consecutiveFailures: number
  lastError: string | undefined
  lastDrainedAt: number | undefined
  /** Deltas offered since the last interval-batch trigger (cadence counter). */
  sinceRecap: number
}

/** Constructor dependencies of the queue. */
export interface RecapQueueDeps {
  ctx: Context
  config: ResolvedRecapConfig
  store: RecapStore
  /** Current user settings (route + effort + master switch). */
  settings: () => RecapSettings
  /** Diagnostics sink (defaults to console). */
  log?: (message: string, error?: unknown) => void
}

/** Live queue statistics for one session (the stats API face). */
export interface RecapQueueStats {
  pending: number
  draining: boolean
  /** The queued + in-flight work items, drain order (in-flight first). */
  items: RecapQueueItem[]
  sentences: number
  consecutiveFailures: number
  lastError?: string
  lastDrainedAt?: number
}

/** Project one queued delta into its stats face (queued or generating). */
function itemOf(delta: StepDelta, state: RecapQueueItem['state']): RecapQueueItem {
  return { key: delta.key, turn: delta.turn, step: delta.step, callIds: [...delta.callIds], state }
}

/**
 * Whether a generation failure is TRANSIENT: the delta itself is fine, the
 * route is merely busy right now. Such failures requeue the delta for a
 * backed-off retry instead of recording a failure entry — a rate-limited
 * route (e.g. zai's 429/1305「访问量过大」) must not punch permanent holes
 * into the recap chain. Everything else keeps the failure-entry contract
 * (ids stay covered; replay never resurrects the delta).
 */
function isTransientError(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'RATE_LIMIT'
}

/**
 * Fold consecutive pending deltas into ONE delta (one generation call): items,
 * ids, and callIds concatenate in order; the merged row is step-null (a batch
 * coordinate, `[T<turn>]` on the wire) carrying the batch's LAST logged route.
 * Shared by backpressure merging and the interval batching of a drain.
 */
export function mergeDeltas(rows: readonly StepDelta[]): StepDelta {
  const items = rows.flatMap((row) => row.items)
  const itemIds = rows.flatMap((row) => row.itemIds)
  const callIds = rows.flatMap((row) => row.callIds)
  const first = rows[0]
  const last = rows.at(-1)
  const turn = first?.turn ?? 0
  return {
    key: `merged:${first?.key ?? '?'}..${last?.key ?? '?'}`,
    turn,
    step: null,
    items,
    itemIds,
    framed: frameDelta(turn, null, items),
    callIds,
    route: last?.route,
  }
}

/**
 * The per-session serial generation queue. All methods are safe to call from
 * event listeners (synchronous, non-blocking); the drain itself is async and
 * self-contained.
 */
export class RecapQueue {
  private readonly deps: RecapQueueDeps
  private readonly sessions = new Map<string, SessionQueue>()

  constructor(deps: RecapQueueDeps) {
    this.deps = deps
  }

  private log(message: string, error?: unknown): void {
    ;(this.deps.log ?? ((msg, err) => console.warn(`[dsh-recap] ${msg}`, err ?? '')))(message, error)
  }

  private stateOf(sessionId: string): SessionQueue {
    let queue = this.sessions.get(sessionId)
    if (queue === undefined) {
      queue = {
        pending: [],
        inFlight: undefined,
        draining: false,
        aborted: false,
        abort: new AbortController(),
        timer: undefined,
        retryTimer: undefined,
        transientFailures: 0,
        retryKey: undefined,
        retryAt: undefined,
        sentences: undefined,
        nextIndex: undefined,
        consecutiveFailures: 0,
        lastError: undefined,
        lastDrainedAt: undefined,
        sinceRecap: 0,
      }
      this.sessions.set(sessionId, queue)
    }
    return queue
  }

  /**
   * Accept one closed delta (capture hook). Applies backpressure merging when
   * the pending set exceeds the configured cap.
   */
  offer(sessionId: string, delta: StepDelta): void {
    const queue = this.stateOf(sessionId)
    queue.pending.push(delta)
    const excess = queue.pending.length - this.deps.config.maxPending
    if (excess > 0) {
      const merged = queue.pending.splice(0, excess + 1)
      queue.pending.unshift(mergeDeltas(merged))
    }
  }

  /**
   * The step-end trigger's cadence gate: counts offered deltas and fires only
   * every `settings.interval`-th one, so each fired drain finds a full batch
   * to fold. Interval 1 (the default) fires on every delta — the per-request
   * cadence. Reads the live setting each call, so a mid-session change
   * applies to the very next delta.
   */
  intervalElapsed(sessionId: string): boolean {
    const queue = this.stateOf(sessionId)
    const interval = this.deps.settings().interval
    if (interval <= 1) return true
    queue.sinceRecap += 1
    if (queue.sinceRecap < interval) return false
    queue.sinceRecap = 0
    return true
  }

  /**
   * Re-pack the pending head into interval-sized batches: every N consecutive
   * deltas become ONE merged delta (one sentence covering N requests). The
   * incomplete tail stays per-delta — the next drain folds it with its
   * successors. No-op at interval 1 (the per-request default).
   */
  private compact(queue: SessionQueue, interval: number): void {
    if (interval <= 1 || queue.pending.length < interval) return
    const batches = Math.floor(queue.pending.length / interval)
    const head = queue.pending.splice(0, batches * interval)
    const packed: StepDelta[] = []
    for (let i = 0; i < head.length; i += interval) {
      packed.push(mergeDeltas(head.slice(i, i + interval)))
    }
    queue.pending.unshift(...packed)
  }

  /**
   * Schedule a debounced drain (trigger events call this). During an active
   * drain the call is a no-op — the drain loop picks new pending work up
   * before exiting.
   */
  schedule(sessionId: string): void {
    const queue = this.stateOf(sessionId)
    if (queue.draining || queue.aborted) return
    if (queue.timer !== undefined) clearTimeout(queue.timer)
    queue.timer = setTimeout(() => {
      queue.timer = undefined
      void this.drain(sessionId)
    }, this.deps.config.debounceMs)
    // Keep the timer off the event loop's keep-alive set.
    ;(queue.timer as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * Arm the backed-off retry of a transiently failed generation. The wait is
   * EXPONENTIAL in the number of consecutive transient failures of the head
   * delta — `retryBackoffMs × 2^(n-1)`, capped at 32× the base — and every
   * further transient failure RE-ARMS the timer with the wider window (a
   * busy route pushes its next probe monotonically further out). The delta
   * it will retry sits at the head of `pending` — the timer simply drains
   * again; the stats face marks that delta `retrying` with a live countdown.
   */
  private scheduleRetry(sessionId: string, queue: SessionQueue, delta: StepDelta): void {
    queue.transientFailures += 1
    const base = this.deps.config.retryBackoffMs
    const backoff = Math.min(base * 2 ** (queue.transientFailures - 1), base * 32)
    if (queue.retryTimer !== undefined) clearTimeout(queue.retryTimer)
    queue.retryKey = delta.key
    queue.retryAt = Date.now() + backoff
    queue.retryTimer = setTimeout(() => {
      queue.retryTimer = undefined
      void this.drain(sessionId)
    }, backoff)
    ;(queue.retryTimer as unknown as { unref?: () => void }).unref?.()
  }

  /** Cancel the debounce and drain immediately (API / model tool). */
  async drainNow(sessionId: string): Promise<void> {
    const queue = this.stateOf(sessionId)
    if (queue.timer !== undefined) {
      clearTimeout(queue.timer)
      queue.timer = undefined
    }
    await this.drain(sessionId)
  }

  /** Abort one session's chain (session dispose) and drop its state. */
  abort(sessionId: string): void {
    const queue = this.sessions.get(sessionId)
    if (queue === undefined) return
    queue.aborted = true
    queue.abort.abort()
    if (queue.timer !== undefined) clearTimeout(queue.timer)
    if (queue.retryTimer !== undefined) clearTimeout(queue.retryTimer)
    this.sessions.delete(sessionId)
  }

  /** Drop all state (plugin disposal aborts every chain). */
  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) this.abort(sessionId)
  }

  /** Live statistics of one session's chain. */
  stats(sessionId: string): RecapQueueStats {
    const queue = this.sessions.get(sessionId)
    if (queue === undefined) {
      return { pending: 0, draining: false, items: [], sentences: 0, consecutiveFailures: 0 }
    }
    const items: RecapQueueItem[] = []
    if (queue.inFlight !== undefined) items.push(itemOf(queue.inFlight, 'generating'))
    for (const delta of queue.pending) {
      // The requeued head delta under a live retry timer is WAITING, not
      // merely queued — surface the countdown so the inline chip can say so.
      if (queue.retryTimer !== undefined && queue.retryKey === delta.key && queue.inFlight === undefined) {
        items.push({ ...itemOf(delta, 'retrying'), retryInMs: Math.max(0, (queue.retryAt ?? 0) - Date.now()) })
      } else {
        items.push(itemOf(delta, 'queued'))
      }
    }
    return {
      pending: queue.pending.length + (queue.inFlight !== undefined ? 1 : 0),
      draining: queue.draining,
      items,
      sentences: queue.sentences?.length ?? 0,
      consecutiveFailures: queue.consecutiveFailures,
      lastError: queue.lastError,
      lastDrainedAt: queue.lastDrainedAt,
    }
  }

  /** Resolve the auxiliary call's route: settings pair → session route → host default. */
  private resolvePolicy(settings: RecapSettings, fallbackRoute: { provider: string; model: string } | undefined, sessionId: string): RecapCallPolicy | undefined {
    if (settings.provider !== undefined && settings.model !== undefined) {
      return { provider: settings.provider, model: settings.model, effort: settings.effort }
    }
    const route = fallbackRoute
      ?? this.routeLookup?.(sessionId)
      ?? (() => {
        const selection = this.deps.ctx.get('agentDefaultModel') as DefaultModelService | undefined
        const current = selection?.currentSelection()
        return current?.provider !== undefined && current?.model !== undefined
          ? { provider: current.provider, model: current.model }
          : undefined
      })()
    if (route === undefined) return undefined
    return { provider: route.provider, model: route.model, effort: settings.effort }
  }

  /** Optional live route lookup injected by the host entry (capture state). */
  routeLookup: ((sessionId: string) => { provider: string; model: string } | undefined) | undefined

  /** Load (and cache) the session's sentence history + entry counter. */
  private async ensureHistory(sessionId: string, queue: SessionQueue): Promise<string[]> {
    if (queue.sentences === undefined || queue.nextIndex === undefined) {
      const entries = await this.deps.store.load(sessionId)
      queue.sentences = await this.deps.store.sentences(sessionId)
      queue.nextIndex = entries.length
    }
    return queue.sentences
  }

  /** The serial drain chain of one session. */
  private async drain(sessionId: string): Promise<void> {
    const queue = this.stateOf(sessionId)
    if (queue.draining || queue.aborted) return
    queue.draining = true
    try {
      // Fold the accumulated head into interval batches BEFORE generating —
      // one sentence per N requests when the user widened the granularity.
      // Deltas arriving mid-drain stay per-delta; the next drain folds them.
      this.compact(queue, this.deps.settings().interval)
      while (queue.pending.length > 0 && !queue.abort.signal.aborted) {
        const settings = this.deps.settings()
        if (!settings.enabled) {
          queue.lastError = 'disabled'
          return // parked; next trigger retries
        }
        if (queue.consecutiveFailures >= 3) {
          return // parked after a failure streak; next trigger retries
        }
        const delta = queue.pending.shift()
        if (delta === undefined) break
        queue.inFlight = delta
        let entry: RecapStoreEntry
        try {
          const policy = this.resolvePolicy(settings, delta.route, sessionId)
          if (policy === undefined) {
            queue.lastError = 'no route: set provider+model in the recap settings, or wait for the session to log one'
            queue.pending.unshift(delta) // keep the work: the park must not drop it
            return // parked; deltas accumulate for the next trigger
          }
          const history = await this.ensureHistory(sessionId, queue)
          const window = history.slice(-this.deps.config.historyMaxSentences)
          try {
            const generation = await generateRecap(
              this.deps.ctx,
              this.deps.config,
              policy,
              window,
              delta.framed,
              sessionId,
              queue.abort.signal,
            )
            entry = {
              v: 1,
              index: queue.nextIndex ?? 0,
              key: delta.key,
              turn: delta.turn,
              step: delta.step,
              createdAt: Date.now(),
              sentence: generation.sentence,
              status: 'ok',
              route: generation.route,
              usage: generation.usage,
              itemIds: delta.itemIds,
              callIds: delta.callIds,
              deltaStats: { items: delta.items.length, bytes: delta.framed.length },
            }
            history.push(generation.sentence)
            if (queue.nextIndex !== undefined) queue.nextIndex += 1
            queue.consecutiveFailures = 0
            queue.transientFailures = 0
            queue.lastError = undefined
            // The retry timer (if one survived an eager trigger's drain)
            // would only fire into an empty queue — drop it and its marker.
            if (queue.retryTimer !== undefined && queue.retryKey === delta.key) {
              clearTimeout(queue.retryTimer)
              queue.retryTimer = undefined
              queue.retryKey = undefined
              queue.retryAt = undefined
            }
          } catch (error) {
            if (queue.abort.signal.aborted) return // dispose: the taken delta is dropped with the chain
            if (isTransientError(error)) {
              // Rate limited: the delta is fine, the route is busy. Put it
              // back (HEAD, drain order preserved — no failure entry, no id
              // coverage) and retry after an exponentially widened backoff.
              // Deliberately outside the consecutive-failure streak: a busy
              // route waits out its backoff, not the next trigger.
              queue.pending.unshift(delta)
              queue.lastError = error instanceof Error ? error.message : String(error)
              this.log(`generation rate-limited for ${sessionId} (${delta.key}); attempt ${queue.transientFailures + 1}`)
              this.scheduleRetry(sessionId, queue, delta)
              return
            }
            queue.consecutiveFailures += 1
            queue.lastError = error instanceof Error ? error.message : String(error)
            this.log(`generation failed for ${sessionId} (${delta.key})`, error)
            entry = {
              v: 1,
              index: queue.nextIndex ?? 0,
              key: delta.key,
              turn: delta.turn,
              step: delta.step,
              createdAt: Date.now(),
              status: 'failed',
              error: queue.lastError,
              itemIds: delta.itemIds,
              callIds: delta.callIds,
              deltaStats: { items: delta.items.length, bytes: delta.framed.length },
            }
            if (queue.nextIndex !== undefined) queue.nextIndex += 1
          }
          await this.deps.store.append(sessionId, entry)
          queue.lastDrainedAt = Date.now()
        } finally {
          queue.inFlight = undefined
        }
      }
    } catch (error) {
      // The drain itself must never throw into a caller that awaits nothing.
      this.log(`drain crashed for ${sessionId}`, error)
      queue.lastError = error instanceof Error ? error.message : String(error)
    } finally {
      queue.draining = false
    }
  }
}

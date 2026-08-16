/**
 * The recap view model: one external store shared by the delegated chat-node
 * renderers and the poller. React components subscribe through
 * useSyncExternalStore; the poller (a plain interval, visible-page gated)
 * fetches /recap/api/list and commits atomically.
 *
 * PLACEMENT RULE (request-exact): every recap row renders at the tail of the
 * request that produced it, never on a neighbouring request's node:
 * - the request issued tool calls → the row renders right AFTER the
 *   request's LAST tool-call row (the tool-call seat wrapper appends it);
 * - a text-only request (no calls) → the row renders BELOW its own
 *   assistant node.
 * The host order [assistant row][tool rows of the request] is exactly the
 * request's visual block, so the row lands at its block's end — and it NEVER
 * MOVES afterwards (the earlier successor-anchored rule relocated rows as
 * later requests appeared, which during live conversation parked each fresh
 * recap ABOVE its own tool rows — right before the last tool call — and lost
 * rows entirely on tool-only steps, whose chat nodes the engine marks
 * visibility:hidden and never renders).
 *
 * PENDING items carry the same coordinates (turn/step/callIds) and render
 * one 凝练中 chip each at exactly the position the sentence will occupy.
 * @module dsh-recap/client/store
 */
import type { Context } from '../context-types.ts'

/** One recap entry as served by the list API. */
export interface RecapEntry {
  index: number
  key: string
  turn: number
  step: number | null
  sentence?: string
  status: 'ok' | 'failed'
  error?: string
  callIds?: string[]
}

/** One pending work item as served by the list API (queue stats face). */
export interface RecapPendingItem {
  key: string
  turn: number
  step: number | null
  callIds: string[]
  state: 'queued' | 'generating'
}

/** The list API result shape. */
interface ListResult {
  entries: RecapEntry[]
  queue: { pending: number; draining: boolean; items?: RecapPendingItem[] }
}

/** The committed view state. */
export interface RecapViewState {
  /** Entries with a rendered sentence or a failure row, newest last. */
  entries: readonly RecapEntry[]
  /** Queue work items (queued + generating), drain order — one chip each. */
  pendingItems: readonly RecapPendingItem[]
  draining: boolean
  /** The session the entries belong to (the session fence). */
  sessionId: string | undefined
  /** Bumped on every commit (useSyncExternalStore version). */
  version: number
}

/** Poll cadence while the page is visible. */
const POLL_MS = 2_500

/**
 * The recap view store + poller. One instance per plugin activation.
 */
export class RecapViewStore {
  private state: RecapViewState = { entries: [], pendingItems: [], draining: false, sessionId: undefined, version: 0 }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private fetchInFlight = false
  private readonly sessionId: () => string | undefined

  constructor(private readonly ctx: Context) {
    this.sessionId = (): string | undefined => {
      try {
        // The client runtime's `sessions` service (ISessions feed) exposes the
        // current conversation through `list.getSnapshot().current`; the host
        // plane's store shape (`.get`) is absent here, hence the probe.
        const sessions = (ctx as unknown as { sessions?: { list?: { getSnapshot(): { current: string | undefined } } } }).sessions
        return sessions?.list?.getSnapshot().current
      } catch {
        return undefined
      }
    }
  }

  /** Current snapshot (useSyncExternalStore getSnapshot). */
  getSnapshot = (): RecapViewState => this.state

  /** Subscribe (useSyncExternalStore subscribe). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private commit(patch: Partial<RecapViewState>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 }
    for (const listener of [...this.listeners]) listener()
  }

  /** Drop all rows (session switch / clear). */
  reset(sessionId: string | undefined): void {
    this.commit({ entries: [], pendingItems: [], draining: false, sessionId })
  }

  /** Fetch the current session's chain and commit. */
  async refresh(): Promise<void> {
    if (this.fetchInFlight || typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const id = this.sessionId()
    if (id === undefined) {
      if (this.state.sessionId !== undefined) this.reset(undefined)
      return
    }
    this.fetchInFlight = true
    try {
      const res = await fetch('/recap/api/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: id, limit: 500 }),
      })
      const json = (await res.json()) as { ok: true; value: ListResult } | { ok: false; error: { message: string } }
      if (!json.ok) return
      // Mid-flight session switch: the data describes a conversation the view
      // no longer shows — drop it instead of painting stale rows.
      if (this.sessionId() !== id) return
      const entries = [...json.value.entries].sort((a, b) => a.index - b.index)
      this.commit({
        entries,
        pendingItems: json.value.queue.items ?? [],
        draining: json.value.queue.draining,
        sessionId: id,
      })
    } catch {
      // Host half not mounted / transient failure: state simply holds.
    } finally {
      this.fetchInFlight = false
    }
  }

  /** Start polling (idempotent). */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.refresh() }, POLL_MS)
    void this.refresh()
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Wire the sessions feed: instant clear + refetch on selection change. */
  bindSessionsFeed(): (() => void) | undefined {
    try {
      const list = (this.ctx as unknown as { sessions?: { list?: { subscribe?: (fn: () => void) => () => void } } }).sessions?.list
      if (typeof list?.subscribe !== 'function') return undefined
      return list.subscribe(() => {
        const current = this.sessionId()
        if (current !== this.state.sessionId) {
          this.reset(current)
          void this.refresh()
        }
      })
    } catch {
      return undefined
    }
  }
}

const noCalls = (ids: string[] | undefined): boolean => ids === undefined || ids.length === 0

/**
 * The recap entries rendering BELOW the tool-call row of one call: exactly
 * the entries whose LAST issued call is this call — i.e. the row lands right
 * after the request's own final tool row, closing the request's visual
 * block. Index order keeps multiple rows (a merged delta sharing the tail
 * call with a later entry cannot happen — ids are covered — but the order is
 * deterministic anyway).
 */
export function recapsAfterCall(entries: readonly RecapEntry[], callId: string): RecapEntry[] {
  const result: RecapEntry[] = []
  for (const entry of entries) {
    const ids = entry.callIds
    if (ids === undefined || ids.length === 0) continue
    if (ids[ids.length - 1] === callId) result.push(entry)
  }
  return result
}

/** The pending items whose LAST issued call is this call (chips after the
 *  request's final tool row). */
export function pendingsAfterCall(items: readonly RecapPendingItem[], callId: string): RecapPendingItem[] {
  const result: RecapPendingItem[] = []
  for (const item of items) {
    if (item.callIds.length === 0) continue
    if (item.callIds[item.callIds.length - 1] === callId) result.push(item)
  }
  return result
}

/**
 * The recap entry rendering BELOW the assistant node of step (turn, step):
 * the step's own entry when the request issued NO tool calls (a text-only
 * reply ends its block at its own row — no tool rows exist to trail).
 * Call-carrying entries anchor at their last tool row instead; tool-only
 * steps never match here because their entries always carry callIds.
 */
export function recapAtStep(entries: readonly RecapEntry[], turn: number, step: number): RecapEntry | undefined {
  for (const entry of entries) {
    if (entry.turn === turn && entry.step === step && noCalls(entry.callIds)) return entry
  }
  return undefined
}

/** The pending chip rendering BELOW the assistant node of (turn, step):
 *  the item of a call-free request at that step. */
export function pendingAtStep(items: readonly RecapPendingItem[], turn: number, step: number): RecapPendingItem | undefined {
  for (const item of items) {
    if (item.turn === turn && item.step === step && item.callIds.length === 0) return item
  }
  return undefined
}

/** The pending chip of a turn's call-free input tail (the turnTail seat). */
export function pendingOfTurnTail(items: readonly RecapPendingItem[], turn: number): RecapPendingItem | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i] as RecapPendingItem
    if (item.turn === turn && item.step === null && item.callIds.length === 0) return item
  }
  return undefined
}

/** The recap entry of a turn's LAST request (the turn-tail row): pure
 *  INPUT-tail entries only — a step-null MERGED delta carries callIds and
 *  anchors at its last tool row, not at the tail. */
export function recapOfTurnTail(entries: readonly RecapEntry[], turn: number): RecapEntry | undefined {
  let best: RecapEntry | undefined
  for (const entry of entries) {
    if (entry.turn !== turn || entry.step !== null || !noCalls(entry.callIds)) continue
    if (best === undefined || entry.index > best.index) best = entry
  }
  return best
}

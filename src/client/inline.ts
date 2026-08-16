/**
 * The inline recap renderer: inserts each distilled sentence directly after
 * the model request that produced it, interleaved with the conversation's
 * real replies — standalone, with no dependency on any other plugin's UI.
 *
 * Why DOM anchoring instead of a slot: the conversation's only per-turn
 * extension hole, `conversation.chat.turnTail`, is a single-winner CHAIN
 * (one occupant renders per turn — dsh-dashboard already elects it for its
 * produced-files row on file-producing turns), so a slot registration would
 * either be displaced or displace another plugin, and it only addresses turn
 * ends anyway. The chat engine, however, stamps every chat row with stable
 * attributes the plugin can address:
 *
 * - `data-chat-anchor-key="14:assistant-step<turn>:<step>"` on each
 *   assistant-step row (the engine's `conversationContextKey` composes
 *   `${kind.length}:${kind}${id}` with the step match id `${turn}:${step}`;
 *   "assistant-step".length === 14), and
 * - `data-turn-tail="<turn>"` on each completed turn's tail element.
 *
 * One wrinkle shapes the placement algorithm: the chat view renders NO row
 * for a settled step whose reply contains only tool calls (no text) —
 * AssistantMarkdown returns null for all-tool-call blocks. Those steps'
 * recaps therefore anchor at the nearest RENDERED assistant row at-or-before
 * their log position (crossing turn boundaries when needed) and stack after
 * that row's contiguous tool block, in log order (a per-anchor cursor keeps
 * the stacking monotone). The DOM exposes no step→tool-row mapping, so a
 * recap may visually trail tool rows of the skipped steps it covers — the
 * relative order of the recaps themselves is always correct.
 *
 * Every chip — entry rows and pending ones alike — carries the durable log
 * coordinate `[T<turn>:S<step>]` (merged/input-tail rows `[T<turn>]`),
 * matching the React path's chips exactly (both render paths must agree on
 * chip coordinates).
 *
 * A MutationObserver over the document reconciles rows against anchors;
 * rows for anchors React has unmounted are removed. The observer ignores
 * mutations this plugin itself caused (re-insert feedback would freeze the
 * page) and per-row content signatures skip unchanged rebuilds. A session
 * fence (the loaded data's session id vs the currently open one, enforced at
 * every reconcile and subscribed to the sessions feed) guarantees a switch
 * never shows the previous conversation's rows on the new one — turn
 * coordinates collide across sessions, so the fence is what keeps the
 * anchor matching honest. Data flows from the host half's /recap/api/list
 * (polled while the page is visible). Everything (observer, style tag,
 * rows, timer) is disposed with the plugin fiber (HMR-safe).
 *
 * Two scopes share this machinery: 'all' (the standalone fallback — every
 * row) and 'calls-only' (the degraded-mode companion of the React takeover:
 * ONLY call-carrying rows — entries and pending items whose request issued
 * tool calls — because the React path already renders the call-free ones:
 * the delegated assistant-step wrapper hosts call-free recaps below their
 * own node, the turnTail chain hosts input tails. The tool-call seat itself
 * CANNOT be taken over while its `tool.call.toolview` child stays declared
 * by the shipped entry, so those rows fall back here). Both render paths
 * agree on chip coordinates (`[T<turn>:S<step>]` on every row);
 * merged-delta entries (step-null with calls) stay here in calls-only mode,
 * landing after the turn tail element exactly as the full fallback places
 * them.
 * @module dsh-recap/client/inline
 */
import type { Context } from '../context-types.ts'
import { t, isZh } from './locales.ts'
import { RECAP_CLASS, RECAP_CSS, RECAP_STYLE_ID } from './style.ts'

/** One recap entry as served by the list API (the slice the rows read). */
interface InlineEntry {
  index: number
  key: string
  turn: number
  step: number | null
  sentence?: string
  status: 'ok' | 'failed'
  error?: string
  /** Root callIds the covered request issued (exact request grouping). */
  callIds?: string[]
}

/** One pending work item as served by the list API (queue stats face). */
interface InlinePendingItem {
  key: string
  turn: number
  step: number | null
  callIds: string[]
  state: 'queued' | 'generating'
}

/** The list API result shape. */
interface InlineListResult {
  entries: InlineEntry[]
  queue: { pending: number; draining: boolean; items?: InlinePendingItem[] }
}

/** Poll cadence of the list fetch while the page is visible. */
const POLL_MS = 2_500

/** Max sentence lines rendered per anchor row (extras fold into a count). */
const MAX_LINES_PER_ROW = 6

/** How long a row tolerates a lost structural neighbor before removal —
 *  rides out the transient unmounts/remounts of streaming re-renders (the
 *  thinking-phase churn) without flickering away. */
const ORPHAN_GRACE_MS = 2_500

const ROW_ATTR = 'data-dsh-recap-row'
/** Anchor identity stamped on each row (`step:turn:step` | `tail:turn` | `pending`). */
const ANCHOR_DS = 'dshRecapAnchor'
// Styles and class names live in the shared style module (both render paths
// inject the same sheet; see style.ts).
const STYLE_ID = RECAP_STYLE_ID
const CLASS = RECAP_CLASS

/** POST one /recap/api method and unwrap the envelope. */
async function recapApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/recap/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { ok: true; value: T } | { ok: false; error: { message: string } }
  if (!json.ok) throw new Error(json.error.message)
  return json.value
}

/**
 * Content signature of one anchor row (locale-dependent copy included). Rows
 * whose signature is unchanged are not rebuilt — this both keeps DOM churn
 * out of every reconcile pass and preserves in-row interaction state.
 */
function rowKey(entries: readonly InlineEntry[]): string {
  const parts = entries.map(e => `${e.step ?? 'in'}:${e.status}:${e.sentence ?? ''}`)
  return `${isZh() ? 'zh' : 'en'}|${parts.join(';')}`
}

/**
 * Whether one mutation record only touches nodes this plugin owns (its rows
 * or its style tag). The observer reconciles on FOREIGN changes only: a
 * callback reacting to its own inserts would re-insert, re-mutate, and
 * re-trigger itself forever — the observer-feedback freeze this guards
 * against.
 */
function isOwnMutation(record: MutationRecord): boolean {
  const own = (node: Node): boolean =>
    node instanceof HTMLElement && (node.hasAttribute(ROW_ATTR) || node.id === STYLE_ID)
  for (const node of record.addedNodes) if (!own(node)) return false
  for (const node of record.removedNodes) if (!own(node)) return false
  return true
}

/** Parse `14:assistant-step<turn>:<step>` anchor keys. */
const STEP_KEY_RE = /^14:assistant-step(\d+):(\d+)$/

/** Escape a callId for embedding in an attribute selector. */
function cssEscape(value: string): string {
  const api = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS
  if (typeof api?.escape === 'function') return api.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

/** Whether `a` precedes-or-equals `b` in document order. */
function precedesOrEquals(a: Element, b: Element): boolean {
  return !(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING)
}

/** The union of callIds across one anchor's entries (one request's calls). */
function callIdsOf(entries: readonly InlineEntry[]): string[] {
  const ids: string[] = []
  for (const entry of entries) for (const id of entry.callIds ?? []) ids.push(id)
  return ids
}

/** One rendered assistant row's coordinates (document order == log order). */
interface RowCoord {
  turn: number
  step: number
  el: Element
}

/** All rendered assistant-step rows, in document order. */
function assistantRows(): RowCoord[] {
  const rows: RowCoord[] = []
  for (const el of document.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    const match = STEP_KEY_RE.exec(el.getAttribute('data-chat-anchor-key') ?? '')
    if (match === null) continue
    rows.push({ turn: Number(match[1]), step: Number(match[2]), el })
  }
  return rows
}

/**
 * The nearest rendered assistant row at or before one log position, crossing
 * turn boundaries: steps whose reply was tool calls only render no row of
 * their own, so their recaps ride the previous visible one.
 */
function anchorBefore(rows: readonly RowCoord[], turn: number, step: number): Element | undefined {
  let best: RowCoord | undefined
  for (const row of rows) {
    if (row.turn < turn || (row.turn === turn && row.step <= step)) best = row
    else break // document order is log order; the first later row ends the scan
  }
  return best?.el
}

/** One rendered anchor row's fresh content (rebuilt only on signature change). */
function buildRow(entries: readonly InlineEntry[], tooltip: string): HTMLElement {
  const root = document.createElement('div')
  root.className = CLASS.root
  root.title = tooltip
  const lines = document.createElement('div')
  lines.className = CLASS.lines
  const shown = entries.slice(0, MAX_LINES_PER_ROW)
  for (const entry of shown) {
    const line = document.createElement('div')
    line.className = CLASS.line
    const chip = document.createElement('span')
    chip.className = CLASS.chip
    chip.textContent = entry.step === null ? `[T${entry.turn}]` : `[T${entry.turn}:S${entry.step}]`
    line.append(chip)
    if (entry.status === 'ok') {
      const text = document.createElement('span')
      text.textContent = entry.sentence ?? ''
      line.append(text)
    } else {
      const text = document.createElement('span')
      text.className = CLASS.failed
      text.textContent = t('inlineFailed')
      text.title = entry.error ?? ''
      line.append(text)
    }
    lines.append(line)
  }
  if (entries.length > shown.length) {
    const more = document.createElement('div')
    more.className = CLASS.more
    more.textContent = t('inlineMore', { count: entries.length - shown.length })
    lines.append(more)
  }
  root.append(lines)
  return root
}

/** One pending work item's 凝练中 chip, labeled with its coordinate — same
 *  card styling as a row, placed at exactly the position the sentence will
 *  occupy (its request's tail). */
function buildPendingChip(item: InlinePendingItem): HTMLElement {
  const root = document.createElement('div')
  root.className = `${CLASS.root} ${CLASS.pending}`
  const line = document.createElement('div')
  line.className = CLASS.line
  const chip = document.createElement('span')
  chip.className = CLASS.chip
  chip.textContent = item.step === null ? `[T${item.turn}]` : `[T${item.turn}:S${item.step}]`
  const text = document.createElement('span')
  text.textContent = t('inlinePendingAt')
  line.append(chip, text)
  root.append(line)
  return root
}

/**
 * Install the inline recap renderer. Returns the disposer removing every
 * trace (observer, style, rows, timer).
 * @param ctx - the client cordis context (sessions feed + locale attached).
 * @param scope - 'all' renders every row (the standalone fallback);
 *  'calls-only' renders ONLY call-carrying rows as the degraded-mode
 *  companion of the React takeover (which owns the call-free rows).
 */
export function registerInlineRecap(ctx: Context, scope: 'all' | 'calls-only' = 'all'): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {} // non-browser composition (tests): nothing to install
  }
  // Stylesheet: one tag per activation.
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-recap'
  style.textContent = RECAP_CSS
  document.head.append(style)

  /** Entries grouped by anchor id (`step:turn:step` | `tail:turn`), oldest first. */
  let byAnchor = new Map<string, InlineEntry[]>()
  let pendingItems: InlinePendingItem[] = []
  let fetchInFlight = false
  /** The session whose data `byAnchor` currently reflects — the session
   *  fence: rows must never outlive the conversation they belong to. */
  let dataFor: string | undefined

  const sessionId = (): string | undefined => {
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

  /** Drop every rendered row and the model behind it (session switch). */
  const clearRows = (): void => {
    for (const row of document.querySelectorAll(`[${ROW_ATTR}]`)) row.remove()
    byAnchor = new Map()
    pendingItems = []
  }

  /**
   * The last flow row of one anchor: the assistant row itself, advanced past
   * the contiguous tool rows that follow (`data-chat-flow-kind="tool-call"`
   * — each tool call renders as its OWN chat node AFTER the assistant row, so
   * the recap of the whole request — reply plus calls plus results — belongs
   * beneath them, not between the reply and its calls).
   */
  const stepTail = (anchor: Element): Element => {
    let cursor = anchor
    for (;;) {
      const next = cursor.nextElementSibling
      if (next === null || next.getAttribute('data-chat-flow-kind') !== 'tool-call') return cursor
      cursor = next
    }
  }

  /** The row previously placed for one anchor id, wherever it sits now. */
  const existingRow = (anchorId: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[${ROW_ATTR}="${anchorId}"]`)

  /** Whether a placed row still sits in its anchor's slot: walking back over
   *  stacked recap rows must land exactly on the placement host. React churn
   *  (streaming re-renders) can relocate or rebuild anchors, leaving an
   *  unchanged-signature row stranded after the WRONG neighbor. */
  const inPosition = (existing: HTMLElement, host: Element): boolean => {
    let prev: Element | null = existing
    while (prev !== null && prev.hasAttribute(ROW_ATTR)) prev = prev.previousElementSibling
    return prev === host
  }

  /** Place (or refresh) one anchor's row after the given host element:
   *  unchanged AND in-position rows are kept as-is; anything else is
   *  rebuilt/relocated to the host (no delete-then-readd flicker). */
  const placeRow = (host: Element, anchorId: string, entries: readonly InlineEntry[], tooltip: string): Element => {
    const existing = existingRow(anchorId)
    if (entries.length === 0) {
      existing?.remove()
      return host
    }
    const signature = rowKey(entries)
    if (existing !== null && existing.dataset.rev === signature && inPosition(existing, host)) return existing
    const row = buildRow(entries, tooltip)
    row.setAttribute(ROW_ATTR, anchorId)
    row.dataset[ANCHOR_DS] = anchorId
    row.dataset.rev = signature
    if (existing !== null && inPosition(existing, host)) existing.replaceWith(row)
    else {
      existing?.remove()
      host.after(row)
    }
    return row
  }

  /** Place (or refresh) one pending item's chip after its host element. */
  const placePending = (host: Element, item: InlinePendingItem): void => {
    const anchorId = `pending:${item.key}`
    const signature = `${isZh() ? 'zh' : 'en'}|${item.turn}|${item.step ?? 'in'}|${item.state}`
    const existing = existingRow(anchorId)
    if (existing !== null && existing.dataset.rev === signature && inPosition(existing, host)) return
    const row = buildPendingChip(item)
    row.setAttribute(ROW_ATTR, anchorId)
    row.dataset[ANCHOR_DS] = anchorId
    row.dataset.rev = signature
    if (existing !== null && inPosition(existing, host)) existing.replaceWith(row)
    else {
      existing?.remove()
      host.after(row)
    }
  }

  /** One reconcile pass: place every entry group after its anchor. */
  const reconcile = (): void => {
    // Session fence first: when the loaded data belongs to another
    // conversation (or none is open), the rows on screen are stale — a
    // freshly switched session renders its own turn 1..N anchors that the
    // old data would otherwise latch onto until the next poll replaces it.
    // Drop everything and re-arm; the fetch for the new session follows.
    const current = sessionId()
    if (dataFor !== current) {
      clearRows()
      dataFor = current
      return
    }
    const rows = assistantRows()
    /** Per anchor row, the element after which the next stacked recap goes. */
    const cursor = new Map<Element, Element>()

    // Step entries in log order, anchored EXACTLY by the request grouping:
    // the durable log recorded which calls one request issued (parallel
    // calls share the entry), and each tool call renders its own chat row
    // keyed `9:tool-call<callId>` — so a recap anchors right after its own
    // request's LAST tool row in document order, interleaving with execution
    // instead of stacking at the nearest visible assistant row.
    const stepGroups: Array<{ turn: number; step: number; anchorId: string; callIds: string[]; entries: InlineEntry[] }> = []
    for (const [anchorId, entries] of byAnchor) {
      if (!anchorId.startsWith('step:')) continue
      const [, turnRaw, stepRaw] = anchorId.split(':')
      stepGroups.push({ turn: Number(turnRaw), step: Number(stepRaw), anchorId, callIds: callIdsOf(entries), entries })
    }
    stepGroups.sort((a, b) => a.turn - b.turn || a.step - b.step)
    for (const group of stepGroups) {
      // Exact anchor: the request's own tool rows.
      let host: Element | undefined
      for (const callId of group.callIds) {
        const row = document.querySelector(`[data-chat-anchor-key="9:tool-call${cssEscape(callId)}"]`)
        if (row !== null && (host === undefined || precedesOrEquals(host, row))) host = row
      }
      if (host === undefined) {
        // No tool rows rendered (text-only reply, or calls not on screen):
        // fall back to the step's own assistant row, then the nearest
        // rendered one at-or-before (tool-only steps render no assistant row).
        const anchor = anchorBefore(rows, group.turn, group.step)
        if (anchor === undefined) continue
        host = cursor.get(anchor) ?? stepTail(anchor)
        const placed = placeRow(host, group.anchorId, group.entries, `T${group.turn}:S${group.step}`)
        cursor.set(anchor, placed)
        continue
      }
      placeRow(host, group.anchorId, group.entries, `T${group.turn}:S${group.step}`)
    }

    // Tail entries: one row after the completed turn's tail element.
    for (const [anchorId, entries] of byAnchor) {
      if (!anchorId.startsWith('tail:')) continue
      const turn = Number(anchorId.slice(5))
      const anchor = document.querySelector(`[data-turn-tail="${turn}"]`)
      if (anchor === null) continue
      placeRow(anchor, anchorId, entries, `T${turn}:input`)
    }

    // Per-item pending chips: each rides its OWN request's tail — the last
    // rendered tool row of its calls (call-free items: the nearest rendered
    // assistant row / the turn tail). One chip per in-flight item, labeled
    // with its coordinate; the sentence replaces it in place.
    const pendingIds = new Set<string>()
    for (const item of pendingItems) {
      pendingIds.add(`pending:${item.key}`)
      let host: Element | undefined
      for (const callId of item.callIds) {
        const row = document.querySelector(`[data-chat-anchor-key="9:tool-call${cssEscape(callId)}"]`)
        if (row !== null && (host === undefined || precedesOrEquals(host, row))) host = row
      }
      if (host === undefined && item.callIds.length === 0) {
        if (item.step === null) {
          host = document.querySelector(`[data-turn-tail="${item.turn}"]`) ?? undefined
        } else {
          const anchor = anchorBefore(rows, item.turn, item.step)
          if (anchor !== undefined) host = cursor.get(anchor) ?? stepTail(anchor)
        }
      }
      if (host !== undefined) placePending(host, item)
    }
    for (const row of document.querySelectorAll(`[${ROW_ATTR}^="pending:"]`)) {
      if (!pendingIds.has(row.getAttribute(ROW_ATTR) ?? '')) row.remove()
    }

    // Orphan sweep with a GRACE PERIOD: during model streaming/thinking the
    // chat re-renders constantly and anchors are transiently unmounted or
    // rebuilt — removing rows on first sight of a lost neighbor is what made
    // recaps vanish mid-generation and return when the reply finished. A row
    // is only deleted after its structural neighbor (walking back over
    // stacked recap rows) has stayed non-structural — not an assistant row,
    // not a tool row, not a turn tail — for longer than the grace window;
    // placement re-seats recovered rows and clears their mark.
    for (const row of document.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)) {
      if ((row.getAttribute(ROW_ATTR) ?? '').startsWith('pending:')) continue // repositioned above
      let prev: Element | null = row.previousElementSibling
      while (prev !== null && prev.hasAttribute(ROW_ATTR)) prev = prev.previousElementSibling
      const key = prev?.getAttribute('data-chat-anchor-key') ?? null
      const structural = prev !== null
        && ((key !== null && STEP_KEY_RE.test(key))
          || prev.getAttribute('data-chat-flow-kind') === 'tool-call'
          || prev.hasAttribute('data-turn-tail'))
      if (structural) {
        delete row.dataset.orphan
        continue
      }
      const markedAt = Number(row.dataset.orphan ?? 0)
      if (markedAt === 0) row.dataset.orphan = String(Date.now())
      else if (Date.now() - markedAt > ORPHAN_GRACE_MS) row.remove()
    }
  }

  /** Fetch the current session's recap list and refresh the model. */
  const refresh = async (): Promise<void> => {
    if (fetchInFlight || document.visibilityState === 'hidden') return
    const id = sessionId()
    if (id === undefined) return
    fetchInFlight = true
    try {
      const value = await recapApi<InlineListResult>('list', { sessionId: id, limit: 500 })
      // Mid-flight session switch: the fetched data describes a conversation
      // the view no longer shows — drop it instead of painting stale rows.
      if (sessionId() !== id) return
      // Group entries by anchor in index order; every chip carries its
      // durable log coordinate, so no renumbering happens here.
      const next = new Map<string, InlineEntry[]>()
      const ordered = [...value.entries].sort((a, b) => a.index - b.index)
      for (const entry of ordered) {
        // The calls-only scope drops call-free entries — the React takeover
        // owns those (below their own node / the turnTail chain), so the DOM
        // keeps exactly the call-carrying rows and the two paths never
        // double-render one entry.
        if (scope === 'calls-only' && (entry.callIds?.length ?? 0) === 0) continue
        const anchorId = entry.step === null ? `tail:${entry.turn}` : `step:${entry.turn}:${entry.step}`
        const list = next.get(anchorId) ?? []
        list.push(entry)
        next.set(anchorId, list)
      }
      byAnchor = next
      dataFor = id
      // Same split for pending chips: call-free items ride the React path,
      // call-carrying ones anchor at their own request's last tool row here.
      pendingItems = scope === 'calls-only'
        ? (value.queue.items ?? []).filter((item) => item.callIds.length > 0)
        : value.queue.items ?? []
      reconcile()
    } catch {
      // Host half not mounted / transient failure: rows simply don't update.
    } finally {
      fetchInFlight = false
    }
  }

  // Coalesce observer-driven reconciles to one per animation frame: the
  // streaming/thinking phase mutates the chat tree many times per token
  // batch, and a reconcile per mutation is wasted work at best.
  let frame = 0
  const scheduleReconcile = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      reconcile()
    })
  }
  const observer = new MutationObserver((mutations) => {
    // Self-inflicted changes (our own row/style inserts, replaces, removes)
    // must not re-enter reconcile — that feedback loop froze the whole page.
    if (mutations.every(isOwnMutation)) return
    scheduleReconcile()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  const timer = setInterval(() => { void refresh() }, POLL_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()

  // The sessions feed reports selection changes the instant they happen —
  // react before the next poll window: clear stale rows and fetch the newly
  // current conversation's chain right away.
  let unsubscribeSessions: (() => void) | undefined
  try {
    const list = (ctx as unknown as { sessions?: { list?: { subscribe?: (fn: () => void) => () => void } } }).sessions?.list
    if (typeof list?.subscribe === 'function') {
      unsubscribeSessions = list.subscribe(() => {
        if (sessionId() !== dataFor) {
          clearRows()
          dataFor = sessionId()
          void refresh()
        }
      })
    }
  } catch {
    // Feed unavailable: the reconcile fence + poll window still bound staleness.
  }

  // Seed immediately (the conversation may already be rendered).
  void refresh()

  return () => {
    observer.disconnect()
    if (frame !== 0) cancelAnimationFrame(frame)
    clearInterval(timer)
    unsubscribeSessions?.()
    for (const row of document.querySelectorAll(`[${ROW_ATTR}]`)) row.remove()
    style.remove()
  }
}

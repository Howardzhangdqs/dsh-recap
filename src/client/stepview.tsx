/**
 * The delegated chat-node renderers. Two seats are taken over with the same
 * mechanics (capture the shipped entry, re-register at priority -1, render
 * the ORIGINAL as an element inside the wrapper):
 *
 * - `assistant-step` — the wrapper appends, BELOW the official assistant
 *   row, the recap row of a request that issued NO tool calls (a text-only
 *   reply's visual block ends at its own row) plus the matching 凝练中 chip;
 * - `tool-call` — the wrapper appends, BELOW the official tool row, the
 *   recap rows / pending chips whose request's LAST issued call is this
 *   call: every call-carrying request's recap lands right after its own
 *   final tool row, closing the request's visual block [assistant row][tool
 *   rows] — REQUEST-EXACT, stationary once rendered.
 *
 * Why not successor-anchored rows (the previous design): a request's tool
 * rows render as separate chat nodes AFTER its assistant row, so hosting the
 * newest recap BELOW its own assistant node parked it between the reply and
 * its tool rows — right before the last tool call — during live
 * conversation, and hosting it above the NEXT request's node depended on
 * that node existing: steps whose reply is tool-calls-only are marked
 * visibility:hidden by the engine and never render, losing whole runs of
 * rows mid-conversation. Anchoring at the request's own last tool row has no
 * neighbour dependency at all.
 *
 * The pending chips are per work-item (queue stats items carry turn/step/
 * callIds): each renders at exactly the position its sentence will occupy —
 * "有几个正在凝练就显示几个". No DOM probing: the previous last-assistant-node
 * probe hopped between nodes on every streaming frame.
 * @module dsh-recap/client/stepview
 */
import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { RecapEntry, RecapPendingItem, RecapViewStore } from './store.ts'
import { pendingAtStep, pendingsAfterCall, recapAtStep, recapsAfterCall } from './store.ts'
import { t } from './locales.ts'
import { RECAP_CLASS } from './style.ts'

/** The `conversation.chat.node` entry shape the delegation captures. */
interface SlotEntry {
  component: unknown
  options: { key?: string }
}

/** The assistant-step node's data slice (engine contract). */
interface StepNodeData {
  turn: number
  step: number
}

/** Structural props of the keyed chat-node rendering we consume. */
interface NodeViewProps {
  node: { kind: string; key?: string; data?: StepNodeData }
  useSession?: <T>(selector: (snapshot: unknown) => T) => T
  [key: string]: unknown
}

/** Parse `9:tool-call<callId>` node keys ("tool-call".length === 9). */
const TOOL_KEY_RE = /^9:tool-call(.+)$/

/** Shared class names (the stylesheet both render paths inject; style.ts). */
const CLASS = RECAP_CLASS

/** The display label of one item's durable log coordinate. */
export function coordinateLabel(item: { turn: number; step: number | null }): string {
  return item.step === null ? `[T${item.turn}]` : `[T${item.turn}:S${item.step}]`
}

/** The copy payload of one entry: coordinate + sentence, one line. */
function copyTextOf(entry: RecapEntry): string {
  const label = entry.step === null ? `[T${entry.turn}:输入]` : `[T${entry.turn}:S${entry.step}]`
  return `${label} ${entry.status === 'ok' ? entry.sentence ?? '' : `(failed: ${entry.error ?? ''})`}`
}

/** Copy on click (navigator.clipboard with a textarea fallback for
 *  non-secure contexts), flashing a Copied state on the row. */
function useCopyFlash(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
  const copy = useCallback((text: string): void => {
    const done = (): void => {
      setCopied(true)
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1_200)
    }
    const nav = navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } }
    if (nav.clipboard !== undefined) {
      void nav.clipboard.writeText(text).then(done, () => fallbackCopy(text, done))
    } else {
      fallbackCopy(text, done)
    }
  }, [])
  return [copied, copy]
}

/** Legacy copy path: hidden textarea + execCommand (non-secure origins). */
function fallbackCopy(text: string, done: () => void): void {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    done()
  } catch {
    // Selection copy still works as the manual fallback.
  }
}

/** One recap row's content — NEVER mutated by copy feedback (the sentence
 *  stays verbatim). The chip is plain selectable TEXT in the durable log
 *  coordinate (`[T2:S3]` / `[T2:输入]`). */
function RecapLines({ entry }: { entry: RecapEntry }): ReactNode {
  return createElement('div', { className: CLASS.lines },
    createElement('div', { className: CLASS.line },
      createElement('span', { className: CLASS.chip }, coordinateLabel(entry)),
      entry.status === 'ok'
        ? createElement('span', null, entry.sentence ?? '')
        : createElement('span', { className: CLASS.failed, title: entry.error ?? '' }, t('inlineFailed')),
    ),
  )
}

/** The row wrapper: durable key, tooltip coordinate, click-to-copy with a
 *  hover/copy toast rendered OUTSIDE the row's layout — the wrapper carries
 *  a position:relative companion class and the toast is position:absolute
 *  pinned below it (top: 100%): "点击复制" while hovered (pure CSS), "✓ 已
 *  复制" for 1.2s after a click (state-driven, replacing the hover one). It
 *  occupies no flow, pushes nothing; the row content is never mutated. A
 *  REAL component (hooks inside) — render via createElement only. */
function RecapRow({ entry }: { entry: RecapEntry }): ReactNode {
  const tooltip = entry.step === null ? `T${entry.turn}:input` : `T${entry.turn}:S${entry.step}`
  const [copied, copy] = useCopyFlash()
  return createElement('div', {
    key: `recap-${entry.key}`,
    className: `${CLASS.root} ${CLASS.wrap}`,
    title: tooltip,
    onClick: (event: MouseEvent) => {
      // Only bare clicks: let text selection drag/copy work undisturbed.
      if (window.getSelection()?.toString() !== '') return
      event.stopPropagation()
      copy(copyTextOf(entry))
    },
  }, null,
    createElement(RecapLines, { key: 'lines', entry }),
    createElement('div', {
      key: 'copy-toast',
      className: `${CLASS.copied} ${copied ? CLASS.copiedActive : ''}`,
      'aria-hidden': true,
    }, copied ? t('inlineCopied') : t('inlineCopyHint')),
  )
}

/** The 凝练中 chip of ONE pending work item, labeled with the coordinate it
 *  belongs to. Renders at exactly the position the sentence will occupy
 *  (its own request's tail) and is REPLACED in place by the row when the
 *  entry lands — no relocation, no hopping. Not clickable (nothing to copy
 *  yet — the root class's pointer cursor is suppressed in CSS). */
export function PendingChip({ item }: { item: RecapPendingItem }): ReactNode {
  return createElement('div', {
    key: `recap-pending-${item.key}`,
    className: `${CLASS.root} ${CLASS.pending}`,
    title: item.state === 'generating' ? t('inlineDraining') : undefined,
  },
    createElement('div', { className: CLASS.line },
      createElement('span', { className: CLASS.chip }, coordinateLabel(item)),
      createElement('span', null, t('inlinePendingAt')),
    ),
  )
}

/** Diagnostics gate (localStorage.dshRecapDebug='off' silences). */
function debugEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('dshRecapDebug') === 'off') return false
  } catch { /* localStorage unavailable — log anyway */ }
  return true
}

/**
 * Build the delegated assistant-step component bound to the view store.
 * @param store - the recap view store (poll-fed).
 * @param original - the captured shipped AssistantNodeView component (a
 *  react.memo OBJECT — it must be rendered through createElement, never
 *  called as a function, or the render throws and the error boundary
 *  abdicates the entry, killing the whole assistant-step cell).
 * @returns the wrapper component registered over the `assistant-step` key.
 */
export function makeStepView(store: RecapViewStore, original: unknown): (props: NodeViewProps) => ReactNode {
  return function RecapStepNode(props: NodeViewProps): ReactNode {
    const state = useStore(store)
    const data = props.node?.data
    const turn = typeof data?.turn === 'number' ? data.turn : undefined
    const step = typeof data?.step === 'number' ? data.step : undefined
    // Delegation: render the shipped view as an ELEMENT (it is a memo
    // object; calling it as a function throws and the error boundary would
    // abdicate the entry, killing the whole assistant-step cell). The stable
    // key keeps it positionally distinct from the recap rows around it.
    const rendered = original !== undefined
      ? createElement(original as never, { ...props, key: 'official' })
      : null
    if (turn === undefined || step === undefined || state.sessionId === undefined) return rendered

    // Below-rows: ONLY the call-free request's own recap + pending chip. A
    // request that issued tool calls anchors at its last tool row (the
    // tool-call wrapper below), never here — its assistant row is followed
    // by its tool rows, so a below-row here would sit ABOVE them.
    const own = recapAtStep(state.entries, turn, step)
    const pending = pendingAtStep(state.pendingItems, turn, step)
    if (debugEnabled()) {
      console.log(`[dsh-recap] step=${turn}:${step} below=${own === undefined ? '-' : own.key} pending=${pending === undefined ? '-' : pending.key}`)
    }
    const children: ReactNode[] = []
    if (rendered !== null) children.push(rendered)
    if (own !== undefined) children.push(createElement(RecapRow, { key: `recap-${own.key}`, entry: own }))
    if (pending !== undefined) children.push(createElement(PendingChip, { key: `recap-pending-${pending.key}`, item: pending }))
    if (children.length === 0) return null
    if (children.length === 1 && rendered !== null) return rendered
    return createElement('div', { className: 'dsh-recap-step-wrap', style: { display: 'contents' } }, ...children)
  }
}

/**
 * Build the delegated tool-call component bound to the view store. The
 * wrapper appends the recap rows / pending chips whose request's LAST issued
 * call is this row's call — the recap of the whole request (reply + calls +
 * results) belongs beneath its final tool row.
 * @param original - the captured shipped ToolCallTree component (rendered
 *  through createElement only — same memo-object rule as the step view).
 * @returns the wrapper component registered over the `tool-call` key.
 */
export function makeToolView(store: RecapViewStore, original: unknown): (props: NodeViewProps) => ReactNode {
  return function RecapToolNode(props: NodeViewProps): ReactNode {
    const state = useStore(store)
    const nodeKey = props.node?.key
    const match = typeof nodeKey === 'string' ? TOOL_KEY_RE.exec(nodeKey) : null
    const rendered = createElement(original as never, { ...props, key: 'official' })
    if (match === null || state.sessionId === undefined) return rendered
    const callId = match[1] as string

    const rows = recapsAfterCall(state.entries, callId)
    const chips = pendingsAfterCall(state.pendingItems, callId)
    if (debugEnabled() && (rows.length > 0 || chips.length > 0)) {
      console.log(`[dsh-recap] call=${callId} after=[${rows.map((row) => row.key).join(',')}] pending=[${chips.map((chip) => chip.key).join(',')}]`)
    }
    if (rows.length === 0 && chips.length === 0) return rendered
    return createElement('div', { className: 'dsh-recap-tool-wrap', style: { display: 'contents' } },
      rendered,
      ...rows.map((entry) => createElement(RecapRow, { key: `recap-${entry.key}`, entry })),
      ...chips.map((item) => createElement(PendingChip, { key: `recap-pending-${item.key}`, item })))
  }
}

/** The store-bound read backing the delegated renderers. */
function useStore(store: RecapViewStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** The turn-tail rows: pure INPUT-tail entries (user input that entered no
 *  step — interrupted/queued turns) plus their pending chip. Request recaps
 *  render under their own request's tail rows via the wrappers above. */
export function makeTurnTailView(store: RecapViewStore): (owner: { turn: { turn: number } }) => ReactNode {
  return function RecapTurnTail(owner: { turn: { turn: number } }): ReactNode {
    const state = useStore(store)
    if (state.sessionId === undefined) return null
    const turn = owner?.turn?.turn
    if (typeof turn !== 'number') return null
    const entry = [...state.entries].reverse()
      .find((row) => row.turn === turn && row.step === null && (row.callIds === undefined || row.callIds.length === 0))
    const pending = [...state.pendingItems].reverse()
      .find((row) => row.turn === turn && row.step === null && row.callIds.length === 0)
    if (entry === undefined && pending === undefined) return null
    const children: ReactNode[] = []
    if (entry !== undefined) children.push(createElement(RecapRow, { key: `recap-${entry.key}`, entry }))
    if (pending !== undefined) children.push(createElement(PendingChip, { key: `recap-pending-${pending.key}`, item: pending }))
    return createElement('div', { className: 'dsh-recap-tail-wrap', style: { display: 'contents' } }, ...children)
  }
}

/** Capture a shipped `conversation.chat.node` entry before takeover (may
 *  miss — load-order change; the caller then keeps/waives its fallback). */
export function captureChatNode(slots: { entries(name: string): Iterable<SlotEntry> }, key: string): unknown {
  try {
    for (const entry of slots.entries('conversation.chat.node')) {
      if (entry.options.key === key) return entry.component
    }
  } catch {
    // Slot not declared yet — the caller keeps the DOM fallback.
  }
  return undefined
}

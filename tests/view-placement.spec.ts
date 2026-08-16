/**
 * Placement-rule specs for the delegated chat-node renderers — REQUEST-EXACT
 * anchoring: a recap row renders at the tail of its own request (after its
 * LAST tool-call row, or below its own assistant node when the request
 * issued no calls), at exactly ONE host, with no dependency on any other
 * request's node rendering (tool-only steps have none). Pure functions over
 * the view-store state (no React, no DOM).
 */
import { describe, expect, it } from 'vitest'
import {
  pendingAtStep, pendingOfTurnTail, pendingsAfterCall,
  recapAtStep, recapOfTurnTail, recapsAfterCall,
  type RecapEntry, type RecapPendingItem,
} from '../src/client/store.ts'

const entry = (index: number, turn: number, step: number | null, callIds: string[] = []): RecapEntry => ({
  index,
  key: step === null ? `${turn}:tail` : `${turn}:${step}`,
  turn,
  step,
  sentence: `句 ${index}`,
  status: 'ok',
  callIds,
})

const pending = (key: string, turn: number, step: number | null, callIds: string[] = []): RecapPendingItem => ({
  key,
  turn,
  step,
  callIds,
  state: 'queued',
})

describe('recap placement rule (request-exact)', () => {
  it('anchors a call-carrying entry after its LAST tool row only', () => {
    const entries = [
      entry(0, 1, 1, ['c1']),
      entry(1, 1, 2, ['c2a', 'c2b']),
    ]
    expect(recapsAfterCall(entries, 'c1').map((row) => row.index)).toEqual([0])
    // Parallel calls share the entry; only the final row in document order hosts it.
    expect(recapsAfterCall(entries, 'c2a')).toEqual([])
    expect(recapsAfterCall(entries, 'c2b').map((row) => row.index)).toEqual([1])
    expect(recapsAfterCall(entries, 'cX')).toEqual([])
  })

  it('anchors a text-only entry below its own node, mid-turn included (no relocation)', () => {
    const entries = [
      entry(0, 1, 1),
      entry(1, 1, 2, ['c2']),
    ]
    // The live-conversation regression: the fresh recap used to sit above its
    // request's tool rows until the NEXT recap arrived. It now stays at its
    // own (call-free) request tail permanently.
    expect(recapAtStep(entries, 1, 1)?.index).toBe(0)
    // A call-carrying entry never rides its own assistant node — its tool
    // rows follow that node, so the below spot would sit ABOVE them.
    expect(recapAtStep(entries, 1, 2)).toBeUndefined()
  })

  it('survives tool-only steps (no successor-node dependency)', () => {
    // T22-like: steps 2..4 reply with tool calls only — the engine marks
    // their assistant nodes visibility:hidden and renders no row at all.
    // Their entries still anchor at their own last tool rows.
    const run = [
      entry(0, 22, 1, ['a']),
      entry(1, 22, 2, ['b']),
      entry(2, 22, 3, ['c']),
      entry(3, 22, 4, ['d']),
      entry(4, 22, 5, ['e']),
    ]
    for (const e of run) {
      const last = (e.callIds as string[]).at(-1) as string
      expect(recapsAfterCall(run, last)).toEqual([e])
    }
  })

  it('never piles a backlog: one host per entry across 36 backlogged steps', () => {
    const many = Array.from({ length: 36 }, (_, i) => entry(i, 24, i + 1, [`c${i}`]))
    for (let i = 0; i < 36; i += 1) {
      expect(recapsAfterCall(many, `c${i}`)).toHaveLength(1)
    }
    expect(recapsAfterCall(many, 'cOther')).toEqual([])
  })

  it('input-tail entries ride the turn tail; merged step-null deltas do not', () => {
    const entries = [
      entry(0, 1, 1, ['c1']),
      entry(1, 3, null),
      entry(2, 2, null, ['m1']),
    ]
    expect(recapOfTurnTail(entries, 3)?.index).toBe(1)
    // A merged delta carries callIds → anchors at its last tool row instead.
    expect(recapOfTurnTail(entries, 2)).toBeUndefined()
    expect(recapOfTurnTail(entries, 1)).toBeUndefined()
  })

  it('pending items mirror the entry placement (one chip per work item)', () => {
    const items = [
      pending('1:1', 1, 1, ['c1']),
      pending('1:2', 1, 2),
      pending('merged:1', 1, null, ['c9']),
    ]
    expect(pendingsAfterCall(items, 'c1')).toEqual([items[0]])
    expect(pendingsAfterCall(items, 'c9')).toEqual([items[2]])
    expect(pendingAtStep(items, 1, 2)).toBe(items[1])
    expect(pendingAtStep(items, 1, 1)).toBeUndefined()
    expect(pendingOfTurnTail(items, 1)).toBeUndefined()
  })

  it('treats a missing recap history as empty', () => {
    expect(recapsAfterCall([], 'c1')).toEqual([])
    expect(recapAtStep([], 1, 1)).toBeUndefined()
    expect(recapOfTurnTail([], 1)).toBeUndefined()
    expect(pendingsAfterCall([], 'c1')).toEqual([])
    expect(pendingAtStep([], 1, 1)).toBeUndefined()
    expect(pendingOfTurnTail([], 1)).toBeUndefined()
  })
})

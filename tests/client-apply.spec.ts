/**
 * Client activation spec: run the client apply() against a mock runtime
 * (locale + sessions + slots with a realistic conversation.chat.node
 * declaration carrying memo-wrapped official assistant-step AND tool-call
 * entries), then RENDER the delegated wrappers through React's server
 * renderer (hooks need a dispatcher — calling the component directly is not
 * a valid test path). The regression guard for the "recap disappeared
 * entirely" failure class, plus the request-exact placement: recap rows and
 * 总结中 chips land at their own request's tail. Also pins the tool-call
 * takeover's declaration gate: the seat is taken over (children table and
 * all) ONLY while `tool.call.toolview` is still undeclared — re-declaring
 * an already-declared child throws at register time in the real runtime
 * (the mock has no such probe, hence the explicit declared/undeclared
 * cases), so the declared case must degrade to the DOM companion instead.
 */
import { describe, expect, it, vi } from 'vitest'
import { memo, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** Build the mock client context. `opts.toolViewChildDeclared` (default
 * true) is what the slots mock's `spec()` reports for `tool.call.toolview`
 * — the default mirrors the realistic composition (the shipped ui-tool
 * entry declared it first); pass false to simulate a runtime where the
 * child is undeclared. An explicit flag rather than a spec value, so
 * "undeclared" cannot be swallowed by a default parameter. */
function mockCtx(officialStep: unknown, officialTool?: unknown, opts?: { toolViewChildDeclared?: boolean }) {
  const toolViewChildDeclared = opts?.toolViewChildDeclared !== false
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
  const slotEntries = [
    ...(officialStep === undefined ? [] : [{ component: officialStep, options: { key: 'assistant-step' } }]),
    ...(officialTool === undefined ? [] : [{ component: officialTool, options: { key: 'tool-call' } }]),
  ]
  const ctx = {
    locale: {
      getSnapshot: () => ({ active: 'zh' }),
      register: () => () => {},
    },
    sessions: {
      list: { getSnapshot: () => ({ current: 's-test' }), subscribe: () => () => {} },
    },
    slots: {
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
      inject: (key: string, callback: () => (() => void) | void) => {
        if (key === 'conversation.chat.node' || key === 'settings.section') callback() // declared now
        return () => {}
      },
      entries: (name: string) => (name === 'conversation.chat.node' ? slotEntries : []),
      spec: (key: string) => (key === 'tool.call.toolview' && toolViewChildDeclared ? { kind: 'keyed', scope: 'session' } : undefined),
      onEntryError: () => () => {},
    },
    effect: (fn: () => (() => void) | void) => {
      fn()
      return undefined
    },
  }
  return { ctx, registrations }
}

/** Flush the poller's first refresh (a microtask + timer chain). */
const flushPoll = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('client apply', () => {
  it('delegates the official assistant-step entry and renders without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, value: { entries: [], queue: { pending: 0, draining: false, items: [] } } }),
    }))
    try {
      const officialStep = memo(function OfficialStep() { return null })
      const { ctx, registrations } = mockCtx(officialStep)
      const mod = await import('../src/client/index.ts')
      expect(() => mod.apply(ctx as never)).not.toThrow()
      const step = registrations.find((row) => row.options['key'] === 'assistant-step')
      expect(step).toBeDefined()
      expect(step?.options['priority']).toBe(-1)
      // The tool-call seat is NOT taken over when its official entry is
      // absent — this exercises the takeover's miss branch (warn + the
      // calls-only DOM companion, a safe no-op in this document-less env).
      expect(registrations.find((row) => row.options['key'] === 'tool-call')).toBeUndefined()
      // Render through React (a dispatcher for the wrapper's hooks).
      const Step = step?.component as never
      expect(() => renderToStaticMarkup(createElement(Step, { node: { kind: 'assistant-step', data: { turn: 1, step: 1 } } } as never))).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('registers the recap settings section into the settings shell', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, value: { entries: [], queue: { pending: 0, draining: false, items: [] } } }),
    }))
    try {
      const officialStep = memo(function OfficialStep() { return null })
      const { ctx, registrations } = mockCtx(officialStep)
      const mod = await import('../src/client/index.ts')
      expect(() => mod.apply(ctx as never)).not.toThrow()
      const section = registrations.find((row) => row.options['name'] === 'settings.section')
      expect(section).toBeDefined()
      expect(section?.options['id']).toBe('recap')
      expect(section?.options['order']).toBe(200)
      expect(typeof section?.options['label']).toBe('function')
      // The nav label is a locale-following thunk; the mock locale is zh.
      expect((section?.options['label'] as () => string)()).toBe('会话回顾')
      // The entry declares NO children table — the slot red lines (lifetime
      // child-slot exclusivity) cannot apply to it.
      expect(section?.options['children']).toBeUndefined()
      // The section component renders through React (hooks need a dispatcher;
      // the server renderer skips effects, so the mount-time fetch never runs
      // and the static branch is the unavailable notice).
      const Section = section?.component as never
      const html = renderToStaticMarkup(createElement(Section, { close: () => {} } as never))
      expect(html).toContain('dsh-recap-settings-unavailable')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('degrades without the tool-call takeover while the toolview child is already declared', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        value: {
          entries: [
            { index: 0, key: '1:1', turn: 1, step: 1, sentence: '第一句总结', status: 'ok', callIds: [] },
            { index: 1, key: '1:2', turn: 1, step: 2, sentence: '第二句总结', status: 'ok', callIds: ['c2a', 'c2b'] },
          ],
          queue: { pending: 0, draining: false, items: [] },
        },
      }),
    }))
    try {
      const officialStep = memo(function OfficialStep() { return null })
      const officialTool = memo(function OfficialTool() { return null })
      // The realistic composition: the shipped tool-call entry precedes us,
      // so its children table already owns `tool.call.toolview`.
      const { ctx, registrations } = mockCtx(officialStep, officialTool)
      const mod = await import('../src/client/index.ts')
      expect(() => mod.apply(ctx as never)).not.toThrow()
      await flushPoll()
      // Degradation must NOT take over the tool-call seat…
      expect(registrations.find((row) => row.options['key'] === 'tool-call')).toBeUndefined()
      // …and must NOT drag down the assistant-step takeover.
      const step = registrations.find((row) => row.options['key'] === 'assistant-step')
      expect(step).toBeDefined()
      expect(step?.options['priority']).toBe(-1)
      // The call-free request's recap still renders BELOW its own assistant
      // row; the call-carrying one hosts nothing below (its rows belong to
      // the calls-only DOM companion, a no-op in this document-less env).
      const Step = step?.component as never
      const markupS1 = renderToStaticMarkup(createElement(Step, { node: { kind: 'assistant-step', data: { turn: 1, step: 1 } } } as never))
      expect(markupS1).toContain('第一句总结')
      const markupS2 = renderToStaticMarkup(createElement(Step, { node: { kind: 'assistant-step', data: { turn: 1, step: 2 } } } as never))
      expect(markupS2).not.toContain('第二句总结')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('takes over the tool-call seat (children declared) only while the toolview child is undeclared', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        value: {
          entries: [
            { index: 0, key: '1:1', turn: 1, step: 1, sentence: '第一句总结', status: 'ok', callIds: [] },
            { index: 1, key: '1:2', turn: 1, step: 2, sentence: '第二句总结', status: 'ok', callIds: ['c2a', 'c2b'] },
          ],
          queue: {
            pending: 1,
            draining: false,
            items: [{ key: '1:3', turn: 1, step: 3, callIds: ['c3'], state: 'generating' }],
          },
        },
      }),
    }))
    try {
      const officialStep = memo(function OfficialStep() { return null })
      const officialTool = memo(function OfficialTool() { return null })
      // A runtime where nothing declared the child yet — only then may the
      // takeover own the children table (the declared case above must NOT
      // re-declare it: the real runtime's probe throws at register time).
      const { ctx, registrations } = mockCtx(officialStep, officialTool, { toolViewChildDeclared: false })
      const mod = await import('../src/client/index.ts')
      mod.apply(ctx as never)
      await flushPoll()
      const step = registrations.find((row) => row.options['key'] === 'assistant-step')
      const tool = registrations.find((row) => row.options['key'] === 'tool-call')
      expect(tool).toBeDefined()
      expect(tool?.options['priority']).toBe(-1)
      // The nested toolview slot declaration rides the takeover ONLY on this path.
      expect(tool?.options['children']).toEqual({ 'tool.call.toolview': { kind: 'keyed', scope: 'session' } })
      const Step = step?.component as never
      const Tool = tool?.component as never

      // The LAST tool row of request 1:2 hosts its recap — the exact spot
      // where the sentence belongs (after its own request's tools), during
      // live conversation included. Rows carry hooks — rendering through
      // React proves they run INSIDE a render.
      const markupLast = renderToStaticMarkup(createElement(Tool, { node: { kind: 'tool-call', key: '9:tool-callc2b' } } as never))
      expect(markupLast).toContain('第二句总结')
      expect(markupLast).toContain('[T1:S2]')
      // The earlier parallel call row hosts nothing.
      const markupFirst = renderToStaticMarkup(createElement(Tool, { node: { kind: 'tool-call', key: '9:tool-callc2a' } } as never))
      expect(markupFirst).not.toContain('第二句总结')
      // The pending item's chip rides ITS request's last tool row, labeled
      // with the coordinate it belongs to.
      const markupPending = renderToStaticMarkup(createElement(Tool, { node: { kind: 'tool-call', key: '9:tool-callc3' } } as never))
      expect(markupPending).toContain('[T1:S3]')
      expect(markupPending).toContain('总结中')

      // The call-free request's recap renders BELOW its own assistant row…
      const markupS1 = renderToStaticMarkup(createElement(Step, { node: { kind: 'assistant-step', data: { turn: 1, step: 1 } } } as never))
      expect(markupS1).toContain('第一句总结')
      // …while the call-carrying request's assistant row hosts NOTHING below
      // (its tool rows follow — a below-row there would sit above them).
      const markupS2 = renderToStaticMarkup(createElement(Step, { node: { kind: 'assistant-step', data: { turn: 1, step: 2 } } } as never))
      expect(markupS2).not.toContain('第二句总结')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('installs the DOM fallback when the official entry cannot be captured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, value: { entries: [], queue: { pending: 0, draining: false, items: [] } } }),
    }))
    try {
      const { ctx, registrations } = mockCtx(undefined) // capture misses
      const mod = await import('../src/client/index.ts')
      expect(() => mod.apply(ctx as never)).not.toThrow()
      expect(registrations.find((row) => row.options['key'] === 'assistant-step')).toBeUndefined()
      // Both DOM renderers (the full fallback here, the calls-only companion
      // of the takeover path) are safe no-ops without a document — apply()
      // must never throw merely because the env is not a browser.
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

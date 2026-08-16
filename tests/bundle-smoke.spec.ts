/**
 * Built-bundle smoke: execute the REAL lib/client.js artifact inside a
 * simulated module-table environment (window.__ModuleLoader__ + react
 + react/jsx-runtime externals) and drive its exported apply() through a
 * mock runtime — the definitive check that the shipped bundle loads and
 * activates at all (the "nothing renders" class of failure lives here,
 * before any React rendering happens).
 */
import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as react from 'react'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The module-table stub for @deepseek-ai/dsh-client-ui-primitives: the
 * bundle value-imports its Input atom, and the SelectMenu's Button anchor +
 * Menu list; activation only needs the bindings to resolve to callable
 * components (the closed Menu renders just its anchor wrapper). */
const uiPrimitivesStub = {
  Input: react.forwardRef(function Input(props: Record<string, unknown>) {
    return react.createElement('input', props)
  }),
  Button: function Button(props: { children?: unknown; [key: string]: unknown }) {
    return react.createElement('button', props)
  },
  Menu: function Menu(props: { anchor?: react.ReactNode }) {
    return react.createElement('span', null, props.anchor)
  },
}

/** Execute one built client bundle and return its exports. */
async function loadBundle(rel: string): Promise<Record<string, unknown>> {
  const source = await readFile(join(root, rel), 'utf8')
  const exportsMap = new Map<string, unknown>()
  const globalThisAny = globalThis as unknown as Record<string, unknown>
  const previousLoader = globalThisAny['__ModuleLoader__']
  const previousWindow = globalThisAny['window']
  const jsxRuntime = await import('react/jsx-runtime')
  // The bundle's banner addresses window.__ModuleLoader__ (browser module
  // table); Node evaluation provides the same global.
  globalThisAny['window'] = globalThis
  globalThisAny['__ModuleLoader__'] = {
    load: (spec: { id: string; factory: (require: (id: string) => unknown) => unknown }) => {
      exportsMap.set(spec.id, spec.factory((id: string) => {
        if (id === 'react') return react
        if (id === 'react/jsx-runtime') return jsxRuntime
        if (id === '@deepseek-ai/dsh-client-ui-primitives') return uiPrimitivesStub
        throw new Error(`module table miss: ${id}`)
      }))
    },
  }
  try {
    // Evaluate the bundle script (CommonJS closure registering itself).
    new Function(source)()
  } finally {
    if (previousLoader === undefined) delete globalThisAny['__ModuleLoader__']
    else globalThisAny['__ModuleLoader__'] = previousLoader
    if (previousWindow === undefined) delete globalThisAny['window']
    else globalThisAny['window'] = previousWindow
  }
  const entry = [...exportsMap.values()][0]
  if (entry === undefined || typeof entry !== 'object') throw new Error('bundle registered no exports')
  return entry as Record<string, unknown>
}

/** A mock client runtime sufficient for activation (no rendering). */
function mockCtx() {
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
  const official = react.memo(function Official() { return null })
  return {
    registrations,
    ctx: {
      locale: { getSnapshot: () => ({ active: 'zh' }), register: () => () => {} },
      sessions: { list: { getSnapshot: () => ({ current: 's-test' }), subscribe: () => () => {} } },
      slots: {
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
        inject: (key: string, callback: () => (() => void) | void) => {
          if (key === 'conversation.chat.node') callback()
          return () => {}
        },
        entries: (key: string) =>
          key === 'conversation.chat.node'
            ? [{ component: official, options: { key: 'assistant-step' } }]
            : [],
        onEntryError: () => () => {},
      },
      effect: (fn: () => (() => void) | void) => { fn(); return undefined },
    } as never,
  }
}

describe('built client bundle', () => {
  it('loads, activates, and registers the delegated assistant-step entry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, value: { entries: [], queue: { pending: 0, draining: false } } }),
    }))
    try {
      const exports_ = await loadBundle('lib/client.js')
      expect(exports_['apply']).toBeTypeOf('function')
      expect(exports_['inject']).toEqual(['locale', 'sessions', 'slots'])
      expect(exports_['inject']).toEqual(['locale', 'sessions', 'slots'])
      const apply = exports_['apply'] as (ctx: unknown) => void
      const { ctx, registrations } = mockCtx()
      expect(() => apply(ctx)).not.toThrow()
      const step = registrations.find((row) => row.options['key'] === 'assistant-step')
      expect(step).toBeDefined()
      expect(step?.options['priority']).toBe(-1)
      // The wrapper component is callable (not a crash at definition time).
      expect(typeof step?.component).toBe('function')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * The settings section spec: parseSettings' defensive normalization (the
 * schemastery-free browser-side mirror of the host resolver), the rows'
 * static render, and the route picker's pure-render faces (hooks components
 * must render through React's server renderer — calling them as functions is
 * not a valid path; effects never run server-side, so the picker's fetch
 * lifecycle is covered by the activation specs, not here).
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseSettings, RecapSettingsSection, SettingsRows } from '../src/client/SettingsSection.tsx'
import { RouteInputs, RouteSelects } from '../src/client/RoutePicker.tsx'
import { resolveRecapSettings } from '../src/config.ts'
import { zh } from '../src/client/locales.ts'

describe('parseSettings (client-side normalization)', () => {
  it('fills defaults from an absent or empty document', () => {
    const expected = resolveRecapSettings(undefined)
    expect(parseSettings(undefined)).toEqual(expected)
    expect(parseSettings({})).toEqual(expected)
    expect(parseSettings(null)).toEqual(expected)
  })

  it('drops a half-set or whitespace route pair like the host resolver', () => {
    expect(parseSettings({ provider: 'deepseek', model: '' }).provider).toBeUndefined()
    expect(parseSettings({ provider: '  ', model: 'chat' }).model).toBeUndefined()
    expect(parseSettings({ provider: 'deepseek', model: 'chat' })).toMatchObject({ provider: 'deepseek', model: 'chat' })
  })

  it('clamps a bad interval to the 1..50 window', () => {
    expect(parseSettings({ interval: 0 }).interval).toBe(1)
    expect(parseSettings({ interval: -3 }).interval).toBe(1)
    expect(parseSettings({ interval: Number.NaN }).interval).toBe(1)
    expect(parseSettings({ interval: '4' as unknown as number }).interval).toBe(1)
    expect(parseSettings({ interval: 4.9 }).interval).toBe(4)
    expect(parseSettings({ interval: 500 }).interval).toBe(50)
  })

  it('keeps only known efforts', () => {
    expect(parseSettings({ effort: 'low' }).effort).toBe('low')
    expect(parseSettings({ effort: 'turbo' as never }).effort).toBe('off')
  })
})

describe('SettingsRows render', () => {
  const base = resolveRecapSettings({ enabled: true, effort: 'off', interval: 3 })

  it('renders every row with its copy and committed values', () => {
    const onPatch = vi.fn()
    const html = renderToStaticMarkup(createElement(SettingsRows, {
      settings: { ...base, provider: 'deepseek', model: 'cheap-model' },
      error: null,
      onPatch,
    }))
    expect(html).toContain(zh.settingsEnabledTitle)
    expect(html).toContain(zh.settingsIntervalTitle)
    expect(html).toContain(zh.settingsEffortTitle)
    expect(html).toContain(zh.settingsRouteTitle)
    // The committed values paint: interval draft 3, the checked master
    // switch, the effort anchor showing its current label, and the route
    // anchors showing the persisted pair (the menu lists are closed
    // server-side; a SelectMenu renders just its Button anchor).
    expect(html).toContain('value="3"')
    expect(html).toContain('checked=""')
    expect(html).toContain('aria-label="思考力度"')
    expect(html).toContain(`>${zh.settingsEffortOff}</span>`)
    expect(html).toContain('aria-label="Provider"')
    expect(html).toContain('>deepseek</span>')
    expect(html).toContain('aria-label="Model"')
    expect(html).toContain('>cheap-model</span>')
  })

  it('surfaces the wire error inline', () => {
    const html = renderToStaticMarkup(createElement(SettingsRows, {
      settings: base,
      error: 'boom',
      onPatch: () => {},
    }))
    expect(html).toContain('boom')
  })
})

describe('RouteSelects render', () => {
  it('anchors the provider row on the current value (a set unknown id included)', () => {
    const html = renderToStaticMarkup(createElement(RouteSelects, {
      providers: { phase: 'ok', list: ['deepseek', 'siliconflow'] },
      models: { phase: 'idle', list: [] },
      provider: 'custom-route',
      model: '',
      onProvider: () => {},
      onModel: () => {},
    }))
    // The anchor shows the pinned unknown current, not a blank native select;
    // with a provider picked the model row is enabled showing the follow
    // placeholder (its list is idle — nothing to pick yet).
    expect(html).toContain('aria-label="Provider"')
    expect(html).toContain('>custom-route</span>')
    expect(html).toContain('aria-label="Model"')
    expect(html).toContain(`>${zh.settingsRoutePlaceholder}</span>`)
    expect(html).not.toContain('disabled=""')
  })

  it('anchors the model row on the picked model once the list loads', () => {
    const loaded = renderToStaticMarkup(createElement(RouteSelects, {
      providers: { phase: 'ok', list: ['deepseek'] },
      models: { phase: 'ok', list: ['deepseek-chat', 'deepseek-coder'] },
      provider: 'deepseek',
      model: 'deepseek-chat',
      onProvider: () => {},
      onModel: () => {},
    }))
    expect(loaded).toContain('aria-label="Model"')
    expect(loaded).toContain('>deepseek-chat</span>')
    expect(loaded).not.toContain('disabled=""')
  })

  it('shows the follow-default placeholder on an unset provider anchor', () => {
    const html = renderToStaticMarkup(createElement(RouteSelects, {
      providers: { phase: 'ok', list: ['deepseek'] },
      models: { phase: 'idle', list: [] },
      provider: '',
      model: '',
      onProvider: () => {},
      onModel: () => {},
    }))
    expect(html).toContain(`>${zh.settingsRoutePlaceholder}</span>`)
    // No provider picked: the model anchor disables and shows the idle hint.
    expect(html).toContain('disabled=""')
    expect(html).toContain(`>${zh.settingsRouteModelIdle}</span>`)
  })
})

describe('RouteInputs render (the manual fallback)', () => {
  it('renders both rows by default with the drafts', () => {
    const html = renderToStaticMarkup(createElement(RouteInputs, {
      modelDraft: 'm1',
      onModelDraft: () => {},
      onCommit: () => {},
      providerDraft: 'p1',
      onProviderDraft: () => {},
    }))
    expect(html).toContain(zh.settingsProvider)
    expect(html).toContain(zh.settingsModel)
    expect(html).toContain('value="p1"')
    expect(html).toContain('value="m1"')
  })

  it('renders the model row alone in providerOnly mode', () => {
    const html = renderToStaticMarkup(createElement(RouteInputs, {
      modelDraft: 'm1',
      onModelDraft: () => {},
      onCommit: () => {},
      providerOnly: true,
    }))
    expect(html).toContain(zh.settingsModel)
    expect(html).not.toContain(zh.settingsProvider)
  })
})

describe('RecapSettingsSection entry render', () => {
  it('renders the unavailable notice before the mount read settles (no effects server-side)', () => {
    const html = renderToStaticMarkup(createElement(RecapSettingsSection, { close: () => {} } as never))
    expect(html).toContain(zh.settingsUnavailable)
  })
})

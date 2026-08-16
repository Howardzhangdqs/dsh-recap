/**
 * The “会话回顾 / Recap” settings section: one page inside the DSH settings
 * shell, mounted through the `settings.section` slot (the shell projects the
 * slot ledger into its navigation). Reads and writes the plugin's `recap`
 * settings namespace through the plugin's OWN fenced routes —
 * /recap/api/settings + /recap/api/settings.update — because the DSH settings
 * RPC domain does not serve third-party namespaces to configuration clients
 * (the same constraint that shaped dsh-dashboard's side-card section).
 *
 * Rows: the master switch, the distill interval (one sentence per N
 * requests), the reasoning effort, and the model route (a cascading
 * provider/model picker over the host inventory — RoutePicker.tsx). Writes
 * are optimistic, serialized, and revision-free — the host route stamps the
 * latest revision itself; a failed write reverts the row and surfaces the
 * wire error inline. The value shape is normalized locally (parseSettings)
 * instead of importing the schemastery schema, so the browser bundle stays
 * free of it (the same split dsh-dashboard ships with
 * SIDEBAR_PREFS_DEFAULTS).
 */
import { useEffect, useRef, useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RecapEffort, RecapSettings } from '../config.ts'
import { SETTINGS_CLASS } from './settings-style.ts'
import { t } from './locales.ts'
import { RoutePicker } from './RoutePicker.tsx'
import { SelectMenu } from './SelectMenu.tsx'

/** The resolved settings the /recap/api/settings routes serve. */
type SettingsWireResult = { ok: true; value: unknown } | { ok: false; error: { message?: string } }

/**
 * Client-side normalization of the wire value (deliberately schemastery-free,
 * see the module doc): the server already serves a resolved object, this only
 * guards against a stale/foreign shape so a bad read degrades to defaults
 * instead of crashing the section. An empty/whitespace route string counts as
 * unset, matching the host's resolver.
 */
export function parseSettings(value: unknown): RecapSettings {
  const record = (value ?? {}) as Partial<RecapSettings>
  const provider = typeof record.provider === 'string' && record.provider.trim() !== '' ? record.provider : undefined
  const model = typeof record.model === 'string' && record.model.trim() !== '' ? record.model : undefined
  const intervalRaw = record.interval
  const effort: RecapEffort = record.effort === 'low' || record.effort === 'follow' ? record.effort : 'off'
  return {
    enabled: record.enabled !== false,
    provider: provider !== undefined && model !== undefined ? provider : undefined,
    model: provider !== undefined && model !== undefined ? model : undefined,
    effort,
    interval: typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) && intervalRaw >= 1
      ? Math.min(Math.floor(intervalRaw), 50)
      : 1,
  }
}

/** One patch through the settings route (throws with the wire message). */
async function writeSettings(patch: Record<string, unknown>): Promise<RecapSettings> {
  const res = await fetch('/recap/api/settings.update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch }),
  })
  const json = (await res.json()) as SettingsWireResult
  if (!json.ok) throw new Error(json.error.message ?? t('settingsSaveFailed'))
  return parseSettings(json.value)
}

/** Map a wire failure to the inline message. */
function messageOf(error: unknown): string {
  return `${t('settingsSaveFailed')} ${error instanceof Error ? error.message : String(error)}`
}

/**
 * The section's rows, extracted so they render without the fetch lifecycle
 * (server-renderable in tests). Every control commits through
 * {@link onPatch} — an optimistic patch the parent persists or reverts.
 */
export function SettingsRows(props: { settings: RecapSettings; error: string | null; onPatch: (patch: Record<string, unknown>) => void }) {
  const { settings, error, onPatch } = props
  const [intervalDraft, setIntervalDraft] = useState(String(settings.interval))
  // Re-seed the interval draft when the committed value changes (a failed
  // commit's revert or another tab's write must repaint the input).
  useEffect(() => {
    setIntervalDraft(String(settings.interval))
  }, [settings.interval])

  const commitInterval = (): void => {
    const parsed = Number.parseInt(intervalDraft, 10)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 50 && parsed !== settings.interval) {
      onPatch({ interval: parsed })
    } else {
      setIntervalDraft(String(settings.interval)) // revert an invalid draft
    }
  }

  return (
    <div className={SETTINGS_CLASS.root}>
      <span className={SETTINGS_CLASS.heading}>{t('settingsNav')}</span>
      <div className={SETTINGS_CLASS.rows}>
        <label className={SETTINGS_CLASS.row}>
          <span className={SETTINGS_CLASS.text}>
            <span className={SETTINGS_CLASS.title}>{t('settingsEnabledTitle')}</span>
            <span className={SETTINGS_CLASS.desc}>{t('settingsEnabledDesc')}</span>
          </span>
          <span className={SETTINGS_CLASS.control}>
            <input
              type="checkbox"
              className={SETTINGS_CLASS.toggle}
              checked={settings.enabled}
              aria-label={t('settingsEnabledTitle')}
              onChange={(event) => { onPatch({ enabled: event.currentTarget.checked }) }}
            />
          </span>
        </label>
        <label className={SETTINGS_CLASS.row}>
          <span className={SETTINGS_CLASS.text}>
            <span className={SETTINGS_CLASS.title}>{t('settingsIntervalTitle')}</span>
            <span className={SETTINGS_CLASS.desc}>{t('settingsIntervalDesc')}</span>
          </span>
          <span className={SETTINGS_CLASS.control}>
            <Input
              type="text"
              inputMode="numeric"
              className={SETTINGS_CLASS.input}
              value={intervalDraft}
              aria-label={t('settingsIntervalTitle')}
              onChange={(event) => { setIntervalDraft(event.currentTarget.value) }}
              onBlur={commitInterval}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            />
          </span>
        </label>
        <label className={SETTINGS_CLASS.row}>
          <span className={SETTINGS_CLASS.text}>
            <span className={SETTINGS_CLASS.title}>{t('settingsEffortTitle')}</span>
          </span>
          <span className={SETTINGS_CLASS.control}>
            <SelectMenu
              value={settings.effort}
              options={[
                { value: 'off', label: t('settingsEffortOff') },
                { value: 'low', label: t('settingsEffortLow') },
                { value: 'follow', label: t('settingsEffortFollow') },
              ]}
              ariaLabel={t('settingsEffortTitle')}
              onSelect={(value) => { onPatch({ effort: value }) }}
            />
          </span>
        </label>
      </div>
      <span className={SETTINGS_CLASS.heading}>{t('settingsRouteTitle')}</span>
      <RoutePicker
        key={`route:${settings.provider ?? ''}:${settings.model ?? ''}`}
        provider={settings.provider}
        model={settings.model}
        onCommit={(provider, model) => {
          onPatch(provider === '' ? { provider: '', model: '' } : { provider, model })
        }}
      />
      <span className={SETTINGS_CLASS.error} role="status">{error}</span>
    </div>
  )
}

/**
 * The settings section entry: loads the persisted settings once on mount,
 * then renders {@link SettingsRows} with optimistic, serialized writes.
 * @param _props - the shell's section props (owner share: close, unused).
 * @returns the section element tree, or the unavailable notice.
 */
export function RecapSettingsSection(_props: PropsRuntime<'settings.section'>) {
  const [settings, setSettings] = useState<RecapSettings | undefined>(undefined)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Serialize commits: a queued write must observe the previous write's
  // outcome; a failed write must not poison the queue for later ones.
  const inFlightRef = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    void fetch('/recap/api/settings')
      .then(async (res) => {
        const json = (await res.json()) as SettingsWireResult
        if (cancelled) return
        if (json.ok) setSettings(parseSettings(json.value))
        else setUnavailable(true)
      })
      .catch(() => { if (!cancelled) setUnavailable(true) })
    return () => { cancelled = true }
  }, [])

  if (unavailable || settings === undefined) {
    return <div className={SETTINGS_CLASS.unavailable}>{t('settingsUnavailable')}</div>
  }

  const onPatch = (patch: Record<string, unknown>): void => {
    const previous = settings
    setSettings({ ...previous, ...parseSettings({ ...previous, ...patch }) })
    setError(null)
    const run = inFlightRef.current.then(async () => writeSettings(patch))
    inFlightRef.current = run.then(() => undefined, () => undefined)
    void run.catch((caught: unknown) => {
      setSettings(previous) // revert; a later write may still succeed
      setError(messageOf(caught))
    })
  }

  return <SettingsRows settings={settings} error={error} onPatch={onPatch} />
}

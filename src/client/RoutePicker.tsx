/**
 * The recap route picker: cascading selects over the host's provider/model
 * inventory, served by the plugin's own /recap/api/providers route (it calls
 * `ctx.llm.listProviders()` / `listModels()` — the same service face the
 * host's model seat uses). The provider list loads once on mount; each
 * provider's model list loads on demand and caches per provider.
 *
 * Commit semantics: the pair commits only when COMPLETE — both sides picked,
 * or both cleared back to “follow the session route” (the empty option, an
 * immediate commit). Switching provider resets the model and parks the
 * commit until one is picked (the old pair stays in force meanwhile). A
 * value that is set but absent from the loaded inventory rides along as a
 * pinned first option, so a stored custom route never renders as a blank
 * select. A failed inventory load degrades the affected row(s) to manual
 * text inputs — a list-less provider never blocks configuration.
 */
import { useEffect, useRef, useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { SETTINGS_CLASS } from './settings-style.ts'
import { t } from './locales.ts'
import { SelectMenu, type SelectMenuOption } from './SelectMenu.tsx'

/** The picker's commit face: a complete pair (both empty = follow). */
export interface RoutePickerProps {
  provider: string | undefined
  model: string | undefined
  onCommit: (provider: string, model: string) => void
}

type WireResult = { ok: true; value: unknown } | { ok: false; error: { message?: string } }

/** Fetch one inventory level: providers (no arg) or one provider's models. */
async function fetchInventory(provider?: string): Promise<string[]> {
  const res = await fetch('/recap/api/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(provider === undefined ? {} : { provider }),
  })
  const json = (await res.json()) as WireResult
  if (!json.ok) throw new Error(json.error.message ?? 'inventory failed')
  const value = json.value as { providers?: Array<{ id?: unknown; name?: unknown }>; models?: Array<{ id?: unknown; name?: unknown }> }
  const rows = provider === undefined ? value.providers : value.models
  return (rows ?? []).map((row) => String(row?.id ?? row?.name ?? '')).filter((id) => id !== '')
}

/** Load phases of one inventory level ('idle' = no provider picked yet). */
type Phase = 'idle' | 'loading' | 'ok' | 'failed'

/** A list plus its pinned current value (a set value missing from the list
 *  rides along as the first option so the select never paints blank). */
function optionsOf(list: readonly string[], current: string): string[] {
  return current !== '' && !list.includes(current) ? [current, ...list] : [...list]
}

/**
 * The cascading dropdowns (pure render, server-renderable in tests). The
 * model row disables while its provider is unpicked or its list is in
 * flight. Each row is a SelectMenu (primitives Button anchor + Menu list),
 * matching the settings shell's own control styling.
 */
export function RouteSelects(props: {
  providers: { phase: Phase; list: string[] }
  models: { phase: Phase; list: string[] }
  provider: string
  model: string
  onProvider: (next: string) => void
  onModel: (next: string) => void
}) {
  const { providers, models, provider, model, onProvider, onModel } = props
  const modelsDisabled = provider === '' || models.phase === 'loading'
  const modelPlaceholder = provider === ''
    ? t('settingsRouteModelIdle')
    : models.phase === 'loading'
      ? t('settingsRouteLoading')
      : t('settingsRoutePlaceholder')
  const providerOptions: SelectMenuOption[] = [
    { value: '', label: t('settingsRoutePlaceholder') },
    ...optionsOf(providers.list, provider).map((id) => ({ value: id, label: id })),
  ]
  const modelOptions: SelectMenuOption[] = [
    // The unpicked placeholder row (kept clickable-parity with the native
    // select; choosing it is a no-op in onModel).
    ...(model === '' ? [{ value: '', label: modelPlaceholder }] : []),
    ...optionsOf(models.list, model).map((id) => ({ value: id, label: id })),
  ]
  return (
    <div className={SETTINGS_CLASS.rows}>
      <label className={SETTINGS_CLASS.row}>
        <span className={SETTINGS_CLASS.text}>
          <span className={SETTINGS_CLASS.title}>{t('settingsProvider')}</span>
          <span className={SETTINGS_CLASS.desc}>{t('settingsRouteDesc')}</span>
        </span>
        <span className={SETTINGS_CLASS.control}>
          <SelectMenu
            value={provider}
            options={providerOptions}
            ariaLabel={t('settingsProvider')}
            onSelect={onProvider}
          />
        </span>
      </label>
      <label className={SETTINGS_CLASS.row}>
        <span className={SETTINGS_CLASS.text}>
          <span className={SETTINGS_CLASS.title}>{t('settingsModel')}</span>
        </span>
        <span className={SETTINGS_CLASS.control}>
          <SelectMenu
            value={model}
            options={modelOptions}
            ariaLabel={t('settingsModel')}
            onSelect={onModel}
            disabled={modelsDisabled}
            placeholder={modelPlaceholder}
          />
        </span>
      </label>
    </div>
  )
}

/**
 * The manual fallback inputs (pure render): both rows when the provider
 * inventory failed, or the model row alone (`providerOnly`) beside its
 * provider select when one provider's model list failed. Commits on
 * blur/Enter; the pair rule itself lives in the container.
 */
export function RouteInputs(props: {
  modelDraft: string
  onModelDraft: (value: string) => void
  onCommit: () => void
  providerOnly?: boolean
  providerDraft?: string
  onProviderDraft?: (value: string) => void
}) {
  const { modelDraft, onModelDraft, onCommit, providerOnly, providerDraft, onProviderDraft } = props
  const blurCommit = (): void => onCommit()
  const keyCommit = (event: { key: string; currentTarget: { blur: () => void } }): void => {
    if (event.key === 'Enter') event.currentTarget.blur()
  }
  return (
    <div className={SETTINGS_CLASS.rows}>
      {!providerOnly && (
        <label className={SETTINGS_CLASS.row}>
          <span className={SETTINGS_CLASS.text}>
            <span className={SETTINGS_CLASS.title}>{t('settingsProvider')}</span>
            <span className={SETTINGS_CLASS.desc}>{t('settingsRouteDesc')}</span>
          </span>
          <span className={SETTINGS_CLASS.control}>
            <Input
              type="text"
              className={SETTINGS_CLASS.input}
              value={providerDraft ?? ''}
              aria-label={t('settingsProvider')}
              onChange={(event) => { onProviderDraft?.(event.currentTarget.value) }}
              onBlur={blurCommit}
              onKeyDown={keyCommit}
            />
          </span>
        </label>
      )}
      <label className={SETTINGS_CLASS.row}>
        <span className={SETTINGS_CLASS.text}>
          <span className={SETTINGS_CLASS.title}>{t('settingsModel')}</span>
        </span>
        <span className={SETTINGS_CLASS.control}>
          <Input
            type="text"
            className={SETTINGS_CLASS.input}
            value={modelDraft}
            aria-label={t('settingsModel')}
            onChange={(event) => { onModelDraft(event.currentTarget.value) }}
            onBlur={blurCommit}
            onKeyDown={keyCommit}
          />
        </span>
      </label>
    </div>
  )
}

/**
 * The route picker container: owns the inventory fetch lifecycle, the edit
 * state (a provider switch parks the pair until a model is picked), and the
 * manual-fallback validation. Re-mounted by the parent on every committed
 * change (the parent keys the element), so the edit state always starts from
 * the persisted pair.
 */
export function RoutePicker(props: RoutePickerProps) {
  const committed = { provider: props.provider ?? '', model: props.model ?? '' }
  const [edit, setEdit] = useState(committed)
  const [providers, setProviders] = useState<{ phase: Phase; list: string[] }>({ phase: 'loading', list: [] })
  const [models, setModels] = useState<{ phase: Phase; list: string[] }>({ phase: 'idle', list: [] })
  const modelsCache = useRef(new Map<string, string[]>())
  // The manual fallback's drafts and its validation notice.
  const [providerDraft, setProviderDraft] = useState(committed.provider)
  const [modelDraft, setModelDraft] = useState(committed.model)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchInventory()
      .then((list) => { if (!cancelled) setProviders({ phase: 'ok', list }) })
      .catch(() => { if (!cancelled) setProviders({ phase: 'failed', list: [] }) })
    return () => { cancelled = true }
  }, [])

  // The model list follows the edited provider — the committed pair's
  // provider included (a configured route shows its list from the start).
  useEffect(() => {
    const id = edit.provider
    if (id === '') {
      setModels({ phase: 'idle', list: [] })
      return
    }
    const cached = modelsCache.current.get(id)
    if (cached !== undefined) {
      setModels({ phase: 'ok', list: cached })
      return
    }
    let cancelled = false
    setModels({ phase: 'loading', list: [] })
    fetchInventory(id)
      .then((list) => {
        modelsCache.current.set(id, list)
        if (!cancelled) setModels({ phase: 'ok', list })
      })
      .catch(() => { if (!cancelled) setModels({ phase: 'failed', list: [] }) })
    return () => { cancelled = true }
  }, [edit.provider])

  const onProvider = (next: string): void => {
    setNotice(null)
    setEdit({ provider: next, model: '' })
    if (next === '') props.onCommit('', '') // back to “follow”: a complete (empty) pair
  }

  const onModel = (next: string): void => {
    if (edit.provider === '' || next === '') return
    setEdit({ provider: edit.provider, model: next })
    props.onCommit(edit.provider, next)
  }

  /** Both rows manual (provider inventory failed): the pair rule on drafts. */
  const onManualPairCommit = (): void => {
    const provider = providerDraft.trim()
    const model = modelDraft.trim()
    if (provider === '' && model === '') {
      setNotice(null)
      if (committed.provider !== '') props.onCommit('', '')
      return
    }
    if (provider === '' || model === '') {
      setNotice(t('settingsRoutePairError'))
      return
    }
    setNotice(null)
    if (provider !== committed.provider || model !== committed.model) props.onCommit(provider, model)
  }

  /** Model manual beside its provider select (that provider's list failed):
   *  the pair completes against the SELECTED provider, not a draft. */
  const onManualModelCommit = (): void => {
    const model = modelDraft.trim()
    if (edit.provider === '' || model === '') {
      setNotice(t('settingsRoutePairError'))
      return
    }
    setNotice(null)
    if (model !== committed.model || edit.provider !== committed.provider) props.onCommit(edit.provider, model)
  }

  // The parked pair: a provider is picked but no model yet — the old pair
  // stays in force until the second select completes it.
  const inline = notice ?? (edit.provider !== '' && edit.model === '' && models.phase === 'ok' ? t('settingsRouteCommitPending') : null)

  return (
    <div className={SETTINGS_CLASS.root}>
      {providers.phase === 'failed' ? (
        <>
          <RouteInputs
            modelDraft={modelDraft}
            onModelDraft={setModelDraft}
            onCommit={onManualPairCommit}
            providerDraft={providerDraft}
            onProviderDraft={setProviderDraft}
          />
          <span className={SETTINGS_CLASS.desc}>{t('settingsRouteListFailed')}</span>
        </>
      ) : models.phase === 'failed' ? (
        <>
          <RouteSelects
            providers={providers}
            models={{ phase: 'ok', list: [] }}
            provider={edit.provider}
            model=""
            onProvider={onProvider}
            onModel={() => {}}
          />
          <RouteInputs
            modelDraft={modelDraft}
            onModelDraft={setModelDraft}
            onCommit={onManualModelCommit}
            providerOnly
          />
          <span className={SETTINGS_CLASS.desc}>{t('settingsRouteModelsFailed')}</span>
        </>
      ) : (
        <RouteSelects
          providers={providers}
          models={models}
          provider={edit.provider}
          model={edit.model}
          onProvider={onProvider}
          onModel={onModel}
        />
      )}
      {inline !== null && <span className={SETTINGS_CLASS.error} role="status">{inline}</span>}
    </div>
  )
}

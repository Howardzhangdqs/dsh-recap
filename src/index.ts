/**
 * dsh-recap host half: captures every session's model-request deltas (seed
 * replay + live append feed, idempotently merged), generates one distilled
 * sentence per request through auxiliary `ctx.llm.stream` calls (parallel to
 * the agent loop, thinking disabled, never touching the session log), and
 * persists the chain under the plugin's own store. Exposes the /recap/api
 * routes behind the browser-trust fence, the user-facing `recap` settings
 * namespace (model route selection), and two opt-in model tools.
 *
 * Zero-footprint contract towards the agent loop:
 * - capture listeners are synchronous pass-throughs (they never mutate the
 *   request; the events are already frozen);
 * - generation is a fire-and-forget promise chain the loop never awaits;
 * - nothing is ever appended to the session log or injected into any
 *   surface — recap state lives exclusively in plugin-owned files;
 * - the recap calls carry `purpose: 'recap'` and are not loop-built, so any
 *   observer (including this plugin's own capture) can filter them out.
 * @module dsh-recap
 */
import { RecapSettingsSchema, RECAP_SETTINGS_NS, resolveRecapConfig, resolveRecapSettings, type RecapConfig, type RecapSettings } from './config.ts'
import type { RecapSettingsScope } from './context-types.ts'
import { RecapCapture } from './capture.ts'
import { RecapQueue } from './queue.ts'
import { RecapStore } from './store.ts'
import { registerRecapRoutes } from './http.ts'
import { registerRecapTools } from './tools.ts'
import type { Context } from './context-types.ts'

export { Config } from './config.ts'
export type { RecapConfig, ResolvedRecapConfig, RecapSettings, RecapTrigger, RecapEffort } from './config.ts'
export { resolveRecapConfig, resolveRecapSettings, RECAP_SETTINGS_NS, RecapSettingsSchema } from './config.ts'
export { RecapStore, defaultStoreDir } from './store.ts'
export { RecapCapture, boundUtf8, frameDelta } from './capture.ts'
export type { StepDelta, DeltaItem } from './capture.ts'
export { RecapQueue } from './queue.ts'
export type { RecapQueueStats } from './queue.ts'
export { generateRecap, recapSystemPrompt, frameHistory, frameUserMessage, normalizeSentence } from './generator.ts'
export { isTrustedApiRequest, isLoopbackHostname } from './http.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-recap'

/** Services required before mounting: the model-call API, the session store
 *  (seed replay), and the webserver (the /recap/api routes). Settings and
 *  tools are optional injects below. */
export const inject = ['llm', 'sessions', 'webServer']

/**
 * Host plugin body.
 * @param ctx - host cordis context.
 * @param config - Loader-validated plugin configuration.
 */
export function apply(ctx: Context, config?: RecapConfig): void {
  const resolved = resolveRecapConfig(config)
  const store = new RecapStore(resolved.storeDir, resolved.storeMaxEntries)

  // ── User-facing settings (live; settings service optional) ──────────────
  let settings: RecapSettings = resolveRecapSettings(undefined)
  let settingsWriter: ((patch: Record<string, unknown>, expectedRevision?: number) => Promise<void>) | undefined
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(RECAP_SETTINGS_NS, RecapSettingsSchema, { applies: 'live' }) as RecapSettingsScope<RecapSettings>
    const sync = (): void => {
      settings = resolveRecapSettings(scope.get())
    }
    sync()
    const revisionOf = (): number | undefined =>
      sctx.settings.describe({ redactSecrets: true }).find((descriptor) => descriptor.ns === RECAP_SETTINGS_NS)?.revision
    settingsWriter = async (patch, expectedRevision) => {
      await sctx.settings.update(RECAP_SETTINGS_NS, patch, expectedRevision ?? revisionOf())
    }
    ctx.effect(() => scope.watch(sync), 'dsh-recap: settings watcher')
  })

  // ── Capture + queue (the delta pipeline) ─────────────────────────────────
  const queue = new RecapQueue({
    ctx,
    config: resolved,
    store,
    settings: () => settings,
    log: (message, error) => console.warn(`[dsh-recap] ${message}`, error ?? ''),
  })
  const capture = new RecapCapture(resolved, {
    onDelta(sessionId, delta) {
      queue.offer(sessionId, delta)
      // The cadence gate: at interval 1 (default) every delta triggers — the
      // per-request cadence; a wider interval fires only every N-th delta.
      if (resolved.trigger === 'step-end' && queue.intervalElapsed(sessionId)) queue.schedule(sessionId)
    },
  })
  queue.routeLookup = (sessionId) => capture.routeOf(sessionId)

  // Live append feed: fold + trigger. Listeners are synchronous and only read.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    capture.handleEvent(sessionId, event)
    if (resolved.trigger === 'turn-end' && event.type === 'turn/end') queue.schedule(sessionId)
  }), 'dsh-recap: session event mirror')
  ctx.effect(() => ctx.on('session/disposed', (session) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    queue.abort(sessionId)
    capture.forget(sessionId)
  }), 'dsh-recap: session dispose')

  // Seed every live session (store snapshot + covered-entry resume). Live
  // events for these sessions buffer inside the capture until each seed done.
  for (const session of ctx.sessions.list()) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') continue
    capture.beginSeed(sessionId)
    void capture
      .prime(sessionId, store, ctx.sessions.get(sessionId)?.events ?? [])
      .then(() => {
        // Replay may have closed deltas whose scheduling events (turn/end)
        // happened before the restart — no live event will ever drain them.
        // Route them through the same debounced gate the live trigger uses.
        if (resolved.trigger !== 'manual') queue.schedule(sessionId)
      })
      .catch((error: unknown) => console.warn('[dsh-recap] seed failed for', sessionId, error))
  }

  // ── HTTP API ─────────────────────────────────────────────────────────────
  ctx.effect(() => registerRecapRoutes(ctx, store, queue, () => settings, (patch, expectedRevision) => {
    if (settingsWriter === undefined) return Promise.reject(new Error('settings service unavailable'))
    return settingsWriter(patch, expectedRevision)
  }), 'dsh-recap: api routes')

  // ── Optional model tools (opt-in: schemas are request state) ─────────────
  if (resolved.toolsEnabled) {
    ctx.inject(['tools'], (tctx) => {
      ctx.effect(() => registerRecapTools(tctx, store, queue), 'dsh-recap: model tools')
    })
  }

  // ── Teardown ─────────────────────────────────────────────────────────────
  ctx.effect(() => () => queue.dispose(), 'dsh-recap: queue teardown')
}

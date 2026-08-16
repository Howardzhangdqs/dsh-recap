/**
 * Client half of dsh-recap: renders the recap chain INLINE in the
 * conversation through the official slot system — a delegated wrapper over
 * the `assistant-step` chat-node key (React-native placement, immune to
 * streaming churn) plus a turn-tail row — falling back to DOM anchoring
 * (inline.ts) when the shipped assistant view cannot be captured for
 * delegation. See stepview.tsx for the composition mechanics and store.ts
 * for the placement rule. The bundle is a module-table consumer (react +
 * the locale service + the slots service).
 */
import type { Context } from '../context-types.ts'
import { LOCALE_NS, attachLocale, t, zh, en } from './locales.ts'
import { RecapViewStore } from './store.ts'
import { captureChatNode, makeStepView, makeToolView, makeTurnTailView } from './stepview.tsx'
import { registerInlineRecap } from './inline.ts'
import { injectRecapStyles } from './style.ts'
import { injectRecapSettingsStyles } from './settings-style.ts'
import { RecapSettingsSection } from './SettingsSection.tsx'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['locale', 'sessions', 'slots']

/**
 * Client plugin body.
 * @param ctx - the client cordis context (sessions feed + locale + slots).
 */
export function apply(ctx: Context): void {
  // The shared stylesheet: injected for BOTH render paths up front — the
  // React delegation renders rows with these classes from the first paint,
  // and the DOM fallback reuses the same tag (idempotent insert).
  ctx.effect(() => injectRecapStyles(), 'dsh-recap: shared stylesheet')
  // The settings section's stylesheet rides the same lifetime (the shell
  // mounts the section lazily; the tag must predate its first paint).
  ctx.effect(() => injectRecapSettingsStyles(), 'dsh-recap: settings stylesheet')

  // i18n: attach the locale service and register the plugin's dictionaries;
  // disposers ride the fiber so re-activation (HMR) re-registers cleanly.
  attachLocale(ctx.locale as unknown as { getSnapshot(): { active: string } })
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh as unknown as Record<string, string>)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en as unknown as Record<string, string>)
    return () => { offZh(); offEn() }
  }, 'dsh-recap: dictionaries')

  // The shared view store (poll-fed; every renderer subscribes to it).
  const store = new RecapViewStore(ctx)
  store.start()
  ctx.effect(() => {
    const unsubscribe = store.bindSessionsFeed()
    return () => {
      unsubscribe?.()
      store.stop()
    }
  }, 'dsh-recap: view store poller')

  // Entry-error mirror: the slot runtime's error boundary contains a crashed
  // entry and ABDICATES it (retired for the registration's life) — the exact
  // "rendered nothing, silently" failure shape. Mirror every report to the
  // console so the cause is visible instead of vanishing.
  ctx.effect(() => ctx.slots.onEntryError((key, entry, error, info) => {
    console.error('[dsh-recap] slot entry error', {
      slot: key,
      registrant: (entry.options as { registrant?: string } | undefined)?.registrant,
      abdicated: info.abdicated,
      error,
    })
  }), 'dsh-recap: entry error mirror')

  // The settings section: one page in the DSH settings shell, projected into
  // its navigation from this slot's ledger. The section reads/writes the
  // `recap` settings namespace through the plugin's own /recap/api routes
  // (the DSH settings RPC domain does not serve third-party namespaces), so
  // nothing is injected here — the component owns its fetch lifecycle. No
  // children table is declared, so the slot red lines do not apply.
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'recap',
      order: 200,
      label: () => t('settingsNav'),
      registrant: 'dsh-recap',
    },
    RecapSettingsSection as unknown as (props: unknown) => unknown,
  ))

  // Primary path: delegate the shipped chat-node seats and attach recap
  // rows inside React. slots.inject waits for the slot's declaration; the
  // shipped entries (registered by the same declaring plugins) are captured
  // BEFORE the takeover registrations. An assistant-step miss (load-order
  // change) skips the takeover and keeps the full DOM fallback below; a
  // tool-call miss OR an already-declared toolview child (the shipped entry
  // owns it — see the takeover block below) starts the calls-only DOM
  // companion for call-carrying rows. The two paths' row sets are disjoint
  // by construction, so no double rendering.
  let fallback: (() => void) | undefined
  /** The calls-only DOM companion of the React takeover (degraded tool-call seat). */
  let callsFallback: (() => void) | undefined
  ctx.slots.inject('conversation.chat.node', () => {
    const originalStep = captureChatNode(ctx.slots, 'assistant-step')
    if (originalStep === undefined) {
      fallback = registerInlineRecap(ctx)
      return
    }
    const offStep = ctx.slots.register(
      {
        name: 'conversation.chat.node',
        key: 'assistant-step',
        priority: -1,
        // The shipped entry declares locale: 'conversation' (its `t` prop);
        // the delegation must keep receiving the same locale props.
        locale: 'conversation',
        registrant: 'dsh-recap',
      },
      makeStepView(store, originalStep) as unknown as (props: unknown) => unknown,
    )
    // The request-exact anchor: recap rows land right after their request's
    // LAST tool-call row. Three ways this can go:
    //
    // 1. The shipped tool-call entry (dsh-client-ui-tool's ToolCallTree) is
    //    missing (load-order change) — nothing to delegate.
    // 2. It is present, and its `children` table already declares the keyed
    //    `tool.call.toolview` sub-slot. The runtime allows ONE declaring
    //    entry per child slot for the whole ledger lifetime — re-declaring,
    //    even verbatim, throws at register time — and the shipped entry
    //    stays on the ledger while shadowed, so a takeover entry can never
    //    re-supply the `renderSlot` prop the delegated ToolCallTree needs
    //    (the kit only injects it under the entry's OWN children table).
    //    SlotCore.register is synchronous-atomic (entry booked and child
    //    declared in one call), hence "captured" and "child declared" are
    //    the same fact: there is no window where this plugin could declare
    //    the child first without breaking the shipped entry's registration.
    // 3. A hypothetical future runtime where the child is NOT declared —
    //    the takeover then carries the children table legitimately.
    //
    // Ways 1 and 2 both degrade to the calls-only DOM companion (inline.ts)
    // — same placement rule (after the request's last tool row), DOM-anchored
    // instead of React-native.
    const offTool = (() => {
      const originalTool = captureChatNode(ctx.slots, 'tool-call')
      if (originalTool === undefined) {
        console.warn('[dsh-recap] tool-call entry not captured; call-carrying recap rows anchored via DOM fallback')
        callsFallback = registerInlineRecap(ctx, 'calls-only')
        return () => {}
      }
      if (ctx.slots.spec?.('tool.call.toolview') !== undefined) {
        console.info('[dsh-recap] tool.call.toolview already declared by the shipped tool-call entry; tool-call takeover skipped, call-carrying rows anchored via DOM fallback')
        callsFallback = registerInlineRecap(ctx, 'calls-only')
        return () => {}
      }
      return ctx.slots.register(
        {
          name: 'conversation.chat.node',
          key: 'tool-call',
          priority: -1,
          locale: 'conversation',
          registrant: 'dsh-recap',
          children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
        },
        makeToolView(store, originalTool) as unknown as (props: unknown) => unknown,
      )
    })()
    // The turn tail: the LAST request's recap under the completed turn — a
    // chain slot; dsh-dashboard's entry declines on non-file turns, and this
    // entry declines unless the turn owns a recap, so the two compose.
    const offTail = ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
      {
        name: 'conversation.chat.turnTail',
        priority: 0,
        registrant: 'dsh-recap',
        select: (owner: unknown) => {
          const turn = (owner as { turn?: { turn?: unknown } } | null)?.turn?.turn
          return typeof turn === 'number' ? { turn } : null
        },
      },
      makeTurnTailView(store) as unknown as (props: unknown) => unknown,
    ))
    ctx.effect(() => () => { offStep(); offTool() }, 'dsh-recap: step delegation disposers')
  })

  // The DOM renderers' lifecycle rides the fiber when they were installed
  // (the full fallback, or the calls-only degraded companion).
  ctx.effect(() => () => { fallback?.(); callsFallback?.() }, 'dsh-recap: inline fallback teardown')
}

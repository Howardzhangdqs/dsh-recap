/**
 * Minimal zh/en copy for the inline recap rows. The copy follows the DSH i18n
 * system: the client apply attaches the locale service (`ctx.locale`,
 * provided by @deepseek-ai/dsh-client-locale) through {@link attachLocale},
 * and `t()` resolves the active locale from it — the Host-backed
 * `locale.preference` wins over the raw browser language. Without an
 * attached service (standalone/test compositions) the browser language is
 * used. The dictionaries are also registered into the DSH locale registry
 * under {@link LOCALE_NS}.
 */

/** The zh dictionary (also registered into the DSH locale registry). */
export const zh = {
  inlineBadge: '回顾',
  inlinePending: '{count} 个请求待总结',
  inlinePendingAt: '总结中…',
  inlineDraining: '总结中…',
  inlineRetrying: '限流等待中，{seconds}s 后重试…',
  inlineFailed: '（总结失败）',
  inlineCopied: '✓ 已复制',
  inlineCopyHint: '点击复制',
  inlineMore: '还有 {count} 条…',
  settingsNav: '会话回顾',
  settingsEnabledTitle: '启用总结',
  settingsEnabledDesc: '关闭后暂停生成，新增数据继续累积，重新开启后继续',
  settingsIntervalTitle: '总结间隔',
  settingsIntervalDesc: '每 N 个请求合并总结成一句（1 = 每个请求一句）',
  settingsEffortTitle: '思考力度',
  settingsEffortOff: '关闭',
  settingsEffortLow: '低',
  settingsEffortFollow: '跟随默认',
  settingsRouteTitle: '总结模型路由',
  settingsRouteDesc: '可选；从宿主已注册的路由中选择，留空则跟随会话路由或宿主默认',
  settingsProvider: 'Provider',
  settingsModel: 'Model',
  settingsRoutePlaceholder: '跟随会话 / 宿主默认',
  settingsRouteModelIdle: '先选择 provider',
  settingsRouteLoading: '加载中…',
  settingsRouteCommitPending: '选择模型后生效',
  settingsRouteListFailed: '路由列表加载失败，可手动输入',
  settingsRouteModelsFailed: '模型列表加载失败，可手动输入',
  settingsRoutePairError: 'provider 与 model 需成对填写',
  settingsSaveFailed: '保存失败',
  settingsUnavailable: '设置服务不可用（宿主未挂载或远程浏览器）',
} as const

/** The en dictionary. */
export const en = {
  inlineBadge: 'Recap',
  inlinePending: '{count} requests pending',
  inlinePendingAt: 'distilling…',
  inlineDraining: 'Distilling…',
  inlineRetrying: 'Rate limited, retrying in {seconds}s…',
  inlineFailed: '(distillation failed)',
  inlineCopied: '✓ Copied',
  inlineCopyHint: 'Click to copy',
  inlineMore: '{count} more…',
  settingsNav: 'Recap',
  settingsEnabledTitle: 'Distillation enabled',
  settingsEnabledDesc: 'Off parks generation; new data keeps accumulating and resumes when re-enabled',
  settingsIntervalTitle: 'Distill interval',
  settingsIntervalDesc: 'One sentence per N requests (1 = one per request)',
  settingsEffortTitle: 'Reasoning effort',
  settingsEffortOff: 'Off',
  settingsEffortLow: 'Low',
  settingsEffortFollow: 'Follow default',
  settingsRouteTitle: 'Recap model route',
  settingsRouteDesc: 'Optional; pick from the host-registered routes — leave empty to follow the session route or the host default',
  settingsProvider: 'Provider',
  settingsModel: 'Model',
  settingsRoutePlaceholder: 'Follow session / host default',
  settingsRouteModelIdle: 'Pick a provider first',
  settingsRouteLoading: 'Loading…',
  settingsRouteCommitPending: 'Applies once a model is picked',
  settingsRouteListFailed: 'Route list failed to load; enter manually',
  settingsRouteModelsFailed: 'Model list failed to load; enter manually',
  settingsRoutePairError: 'provider and model must be set as a pair',
  settingsSaveFailed: 'Failed to save',
  settingsUnavailable: 'Settings service unavailable (host half not mounted, or a remote browser)',
} as const

/** The DSH locale namespace this plugin registers its dictionaries under. */
export const LOCALE_NS = 'recap'

/** The DSH locale service attached by the client apply (absent → browser detection). */
let localeService: { getSnapshot(): { active: string } } | undefined

/** Attach (or detach, with undefined) the DSH locale service. */
export function attachLocale(service: { getSnapshot(): { active: string } } | undefined): void {
  localeService = service
}

/** The active locale id: the attached service's snapshot, else the browser language. */
function activeLocale(): string {
  return localeService?.getSnapshot().active
    ?? (typeof navigator !== 'undefined' ? navigator.language : '')
    ?? 'en'
}

/** Translate a copy key; `{name}` placeholders interpolate from `params`. */
export type CopyKey = keyof typeof zh
export function t(key: CopyKey, params?: Record<string, string | number>): string {
  const dict = activeLocale().toLowerCase().startsWith('zh') ? zh : en
  let text: string = dict[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** Whether the active locale is Chinese (used for selectors). */
export function isZh(): boolean {
  return activeLocale().toLowerCase().startsWith('zh')
}

/**
 * The recap rows' stylesheet, shared by BOTH render paths (the React slot
 * delegation and the DOM fallback): the style tag lives for the plugin
 * fiber's lifetime, injected at apply time regardless of which path wins.
 * Without it the rows render as bare unstyled text — the delegation-shipped
 * without-styles bug (sentences technically present, visually gone).
 * @module dsh-recap/client/style
 */

/** The style tag's DOM id (one per activation). */
export const RECAP_STYLE_ID = 'dsh-recap-inline-style'

/** Row class names (the stylesheet and both render paths share these). */
export const RECAP_CLASS = {
  root: 'dsh-recap-inline',
  wrap: 'dsh-recap-inline-wrap',
  lines: 'dsh-recap-inline-lines',
  line: 'dsh-recap-inline-line',
  chip: 'dsh-recap-inline-chip',
  pending: 'dsh-recap-inline-pending',
  failed: 'dsh-recap-inline-failed',
  more: 'dsh-recap-inline-more',
  copied: 'dsh-recap-inline-copied',
  copiedActive: 'dsh-recap-inline-copied-active',
} as const

/** The stylesheet: white bold body copy at the conversation's own size,
 *  cards marked by a left accent rule and a faint background. */
export const RECAP_CSS = `
.${RECAP_CLASS.root} {
  margin: 2px 0 6px;
  padding: 2px 10px 3px;
  border-left: 2px solid var(--dsh-recap-accent, rgba(90, 140, 220, 0.55));
  border-radius: 4px;
  background: var(--dsh-recap-bg, rgba(128, 128, 128, 0.06));
  font-size: inherit;
  line-height: 1.55;
  color: var(--dsh-recap-fg, #ffffff);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.${RECAP_CLASS.root}:hover { background: var(--dsh-recap-bg-hover, rgba(128, 128, 128, 0.1)); }
.${RECAP_CLASS.lines} { display: flex; flex-direction: column; gap: 1px; }
.${RECAP_CLASS.line} { display: flex; gap: 6px; align-items: baseline; }
.${RECAP_CLASS.line} > span { font-weight: 400; }
/* Re-enable selection even when an ancestor (chat surface/theme) disables
 * it — the rows' text is meant to be quoted, coordinates first. Click
 * copies the row (coordinate + sentence); drags still select text. */
.${RECAP_CLASS.root}, .${RECAP_CLASS.root} * { user-select: text; -webkit-user-select: text; }
.${RECAP_CLASS.root} { cursor: pointer; }
.${RECAP_CLASS.chip} {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78em;
  font-weight: 400;
  opacity: 0.65;
  /* Selectable on purpose: the chip is the durable log coordinate
     ([T2:S3]) the user copies into feedback — no user-select:none. */
}
.${RECAP_CLASS.pending} {
  font-size: inherit;
  font-weight: 400;
  opacity: 0.7;
}
/* A pending chip reuses the row card (left rule + faint bg) but is NOT a
 * copy target — nothing to copy yet. */
.${RECAP_CLASS.root}.${RECAP_CLASS.pending} { cursor: default; }
.${RECAP_CLASS.root}.${RECAP_CLASS.pending}:hover { background: var(--dsh-recap-bg, rgba(128, 128, 128, 0.06)); }
.${RECAP_CLASS.failed} { opacity: 0.6; }
.${RECAP_CLASS.more} { font-size: 0.85em; opacity: 0.6; font-weight: 400; }
/* Copy toast: absolutely positioned UNDER the row (outside its flow — no
 * row height, pushes nothing, blocks nothing). Hidden by default; HOVER
 * reveals the "click to copy" hint; the .copied-active state (set for 1.2s
 * after a successful copy) shows the confirmation regardless of hover. */
.${RECAP_CLASS.wrap} { position: relative; }
.${RECAP_CLASS.copied} {
  position: absolute;
  top: 100%;
  left: 10px;
  margin-top: 2px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.78em;
  white-space: nowrap;
  color: #ffffff;
  background: rgba(60, 70, 90, 0.95);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  pointer-events: none;
  z-index: 10;
  opacity: 0;
  transform: translateY(-3px);
  transition: opacity 120ms ease-out, transform 120ms ease-out;
}
.${RECAP_CLASS.wrap}:hover .${RECAP_CLASS.copied},
.${RECAP_CLASS.copiedActive} {
  opacity: 1;
  transform: translateY(0);
}
`

/**
 * Inject the shared stylesheet. Returns the remover (idempotent per
 * activation: a second insert while the tag lives is a no-op).
 */
export function injectRecapStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(RECAP_STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = RECAP_STYLE_ID
  style.dataset.plugin = 'dsh-recap'
  style.textContent = RECAP_CSS
  document.head.append(style)
  return () => { style.remove() }
}

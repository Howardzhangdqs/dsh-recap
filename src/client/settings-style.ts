/**
 * The settings section's stylesheet: the rows the DSH settings shell mounts
 * inside its content column when the user opens the “会话回顾 / Recap” page.
 * Separate from the inline rows' stylesheet (style.ts) because the two
 * surfaces have different containers — this one targets the settings panel's
 * own width and typography rather than the conversation flow.
 * @module dsh-recap/client/settings-style
 */

/** The style tag's DOM id (one per activation). */
export const RECAP_SETTINGS_STYLE_ID = 'dsh-recap-settings-style'

/** Section class names (the stylesheet and the section component share these). */
export const SETTINGS_CLASS = {
  root: 'dsh-recap-settings',
  heading: 'dsh-recap-settings-heading',
  rows: 'dsh-recap-settings-rows',
  row: 'dsh-recap-settings-row',
  text: 'dsh-recap-settings-text',
  title: 'dsh-recap-settings-title',
  desc: 'dsh-recap-settings-desc',
  control: 'dsh-recap-settings-control',
  input: 'dsh-recap-settings-input',
  selectMenu: 'dsh-recap-settings-select',
  selectMenuLabel: 'dsh-recap-settings-select-label',
  selectCaret: 'dsh-recap-settings-select-caret',
  toggle: 'dsh-recap-settings-toggle',
  error: 'dsh-recap-settings-error',
  unavailable: 'dsh-recap-settings-unavailable',
} as const

export const RECAP_SETTINGS_CSS = `
.${SETTINGS_CLASS.root} {
  display: flex;
  flex-direction: column;
  gap: 18px;
  font-size: inherit;
  line-height: 1.5;
  color: inherit;
}
.${SETTINGS_CLASS.heading} {
  margin: 0;
  font-size: 0.85em;
  font-weight: 600;
  opacity: 0.65;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.${SETTINGS_CLASS.rows} {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.${SETTINGS_CLASS.row} {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.${SETTINGS_CLASS.text} {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.${SETTINGS_CLASS.title} { font-weight: 500; }
.${SETTINGS_CLASS.desc} {
  font-size: 0.82em;
  font-weight: 400;
  opacity: 0.6;
}
.${SETTINGS_CLASS.control} { flex: none; }
.${SETTINGS_CLASS.input} { width: 180px; box-sizing: border-box; }
/* The SelectMenu anchor: the primitives Button supplies the token styling
 * (border, fill, radius); this only fixes the row geometry — same width as
 * the text inputs, label and caret at the two ends, long ids ellipsize. */
.${SETTINGS_CLASS.selectMenu} {
  width: 180px;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.${SETTINGS_CLASS.selectMenuLabel} {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${SETTINGS_CLASS.selectCaret} { flex: none; }
.${SETTINGS_CLASS.toggle} { width: 16px; height: 16px; margin: 0; }
.${SETTINGS_CLASS.error} {
  font-size: 0.85em;
  color: #e06c75;
  min-height: 1.2em;
}
.${SETTINGS_CLASS.unavailable} {
  font-size: 0.9em;
  opacity: 0.65;
}
`

/**
 * Inject the settings stylesheet (idempotent per activation, mirroring
 * {@link injectRecapStyles}). Returns the remover.
 */
export function injectRecapSettingsStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(RECAP_SETTINGS_STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = RECAP_SETTINGS_STYLE_ID
  style.dataset.plugin = 'dsh-recap'
  style.textContent = RECAP_SETTINGS_CSS
  document.head.append(style)
  return () => { style.remove() }
}

/**
 * SelectMenu: the settings rows' dropdown — a select rebuilt as a primitives
 * `Button` anchor (outline variant, token-styled like every other DSH
 * control) opening the primitives `Menu` list, instead of a bare native
 * `<select>` that ignores the theme. The component owns only the open
 * state; options and selection live with the caller.
 */
import { useState } from 'react'
import { Button, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { SETTINGS_CLASS } from './settings-style.ts'

/** A tiny downward caret (the icon set ships no chevron). */
function CaretDown(): JSX.Element {
  return (
    <svg width="8" height="4" viewBox="0 0 8 4" aria-hidden="true" focusable="false" className={SETTINGS_CLASS.selectCaret}>
      <path d="M0 0h8L4 4z" fill="currentColor" />
    </svg>
  )
}

/** One selectable row. */
export interface SelectMenuOption {
  value: string
  label: string
}

/**
 * Render one dropdown: anchor button showing the current label, menu list on
 * click. An empty value shows the placeholder; a disabled anchor never
 * opens. The list portals into the body so the settings panel's scroll
 * container cannot crop it, right-aligned under the anchor.
 */
export function SelectMenu(props: {
  value: string
  options: readonly SelectMenuOption[]
  ariaLabel: string
  onSelect: (value: string) => void
  disabled?: boolean
  /** Label shown while the value is empty. */
  placeholder?: string
}) {
  const { value, options, ariaLabel, onSelect, disabled, placeholder } = props
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  const items: MenuEntry[] = options.map((option) => ({ id: option.value, label: option.label }))
  return (
    <Menu
      open={open && disabled !== true}
      onClose={() => { setOpen(false) }}
      items={items}
      selectedId={value === '' ? undefined : value}
      onSelect={(id) => {
        setOpen(false)
        onSelect(id)
      }}
      portal
      align="end"
      anchor={(
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={SETTINGS_CLASS.selectMenu}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={() => { setOpen((previous) => !previous) }}
        >
          <span className={SETTINGS_CLASS.selectMenuLabel}>{current?.label ?? placeholder ?? ''}</span>
          <CaretDown />
        </Button>
      )}
    />
  )
}

export type ThemeId = 'dark' | 'light' | 'dracula' | 'synthwave' | 'nord' | 'system'

// Ledger Dark/Light are Jinn's own palette. dracula/synthwave/nord port real,
// currently-shipping daisyUI palettes (packages/daisyui/src/themes/*.css on
// saadeghi/daisyui@master) into Jinn's own --bg/--accent/etc. token set and
// data-theme switcher — see docs/tengu/17-daisyui.md (D18). No daisyUI plugin
// is installed; these are just more entries in Jinn's existing registry.
export const THEMES: { id: ThemeId; label: string; emoji: string }[] = [
  { id: 'dark',      label: 'Dark',      emoji: '🌑' },
  { id: 'light',     label: 'Light',     emoji: '☀️' },
  { id: 'dracula',   label: 'Dracula',   emoji: '🦇' },
  { id: 'synthwave', label: 'Synthwave', emoji: '🌆' },
  { id: 'nord',      label: 'Nord',      emoji: '❄️' },
  { id: 'system',    label: 'System',    emoji: '⚙️' },
]

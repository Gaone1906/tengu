export type ThemeId =
  | 'dark'
  | 'glass'
  | 'color'
  | 'light'
  | 'atelier'
  | 'console'
  | 'ember'
  | 'system'

export const THEMES: { id: ThemeId; label: string; emoji: string }[] = [
  { id: 'atelier', label: 'Atelier', emoji: '📜' },
  { id: 'console', label: 'Console', emoji: '🎛️' },
  { id: 'ember',   label: 'Ember',   emoji: '🔥' },
  { id: 'dark',    label: 'Dark',    emoji: '🌑' },
  { id: 'glass',   label: 'Glass',   emoji: '🪟' },
  { id: 'color',   label: 'Color',   emoji: '🎨' },
  { id: 'light',   label: 'Light',   emoji: '☀️' },
  { id: 'system',  label: 'System',  emoji: '⚙️' },
]

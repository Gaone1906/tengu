import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { EnginesResponse } from '@/lib/api'

// ModelSelectorRow calls useQueryClient() (for refreshModels), so renders must
// be wrapped in a QueryClientProvider — otherwise the hook throws on mount.
function renderRow(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

// jsdom lacks several DOM APIs Radix (and the in-place panel transition) rely on.
// matchMedia → reduced-motion = true, so panels swap instantly (no rAF needed).
beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  if (!g.ResizeObserver) {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
})

const REG: EnginesResponse = {
  default: 'claude',
  engines: {
    claude: {
      name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'claude-flag',
      models: [
        { id: 'opus', label: 'Opus 4.8', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
      ],
    },
    antigravity: {
      name: 'antigravity', available: true, defaultModel: 'gemini-3-flash-preview', effortMechanism: 'none',
      models: [{ id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', supportsEffort: false, effortLevels: [] }],
    },
    codex: {
      name: 'codex', available: true, defaultModel: 'gpt-5.5', effortMechanism: 'codex-config',
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh'], contextWindow: 258400 }],
    },
  },
}

// A claude entry with a featured set (opus/sonnet/fable) plus two non-featured
// concrete ids — exercises the collapsed/expand picker behaviour.
const FEATURED_REG: EnginesResponse = {
  default: 'claude',
  engines: {
    claude: {
      name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'claude-flag',
      models: [
        { id: 'opus', label: 'Opus (Latest)', supportsEffort: true, effortLevels: ['low', 'medium', 'high'], featured: true },
        { id: 'sonnet', label: 'Sonnet (Latest)', supportsEffort: true, effortLevels: ['low', 'medium', 'high'], featured: true },
        { id: 'fable', label: 'Fable (Latest)', supportsEffort: true, effortLevels: ['low', 'medium', 'high'], featured: true },
        { id: 'claude-opus-4-8', label: 'Opus 4.8', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
      ],
    },
  },
}

// Mutable holder so a test can swap the registry the mocked hook returns.
const regHolder: { current: EnginesResponse } = { current: REG }

// Mock only the query hook; keep the real pure helpers.
vi.mock('@/hooks/use-model-registry', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-model-registry')>()
  return { ...actual, useModelRegistry: () => ({ data: regHolder.current, isLoading: false }) }
})

import { ModelSelectorRow } from '../model-selector-row'
import type { SelectorValue } from '../model-selector-row'

/** Controlled harness so onChange propagates back into `value` (the real wiring). */
function Harness({
  initial,
  onChange,
  mode = 'new',
}: {
  initial: SelectorValue
  onChange?: (v: SelectorValue) => void
  mode?: 'new' | 'existing'
}) {
  const [val, setVal] = useState<SelectorValue>(initial)
  return (
    <ModelSelectorRow
      mode={mode}
      value={val}
      onChange={(v) => {
        setVal(v)
        onChange?.(v)
      }}
    />
  )
}

function openMenu() {
  const chip = screen.getByRole('button', { name: /model and effort/i })
  fireEvent.keyDown(chip, { key: 'Enter' })
}

describe('ModelSelectorRow chip', () => {
  it('renders a single chip trigger labelled with the model + effort', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={() => {}} />)
    const chip = screen.getByRole('button', { name: /model and effort/i })
    expect(chip).toBeTruthy()
    // Model label is always visible on the chip surface (effort is responsive).
    expect(screen.getByText('Opus 4.8')).toBeTruthy()
    expect(chip.getAttribute('aria-label')).toContain('Opus 4.8')
    expect(chip.getAttribute('aria-label')).toContain('High')
  })

  it('reflects the selected model on the chip', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'claude-sonnet-4-6', effortLevel: 'medium' }} onChange={() => {}} />)
    expect(screen.getByText('Sonnet 4.6')).toBeTruthy()
  })

  it('omits effort from the chip label for effort-less engines (antigravity)', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'antigravity', model: 'gemini-3-flash-preview' }} onChange={() => {}} />)
    const chip = screen.getByRole('button', { name: /model and effort/i })
    expect(chip.getAttribute('aria-label')).toBe('Model and effort: Gemini 3 Flash')
  })

  it('renders nothing extra (one trigger) — engine/model/effort all live in one dropdown', () => {
    renderRow(<ModelSelectorRow mode="existing" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} />)
    // The old inline Engine/Model/Effort buttons are gone; just the chip remains.
    expect(screen.queryByRole('button', { name: 'Engine' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('ModelSelectorRow in-place engine panel', () => {
  it('"Switch engine…" transitions the SAME surface to the engine panel (no second menu)', async () => {
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()

    // Main panel: model list is visible, engine "Back" control is not.
    expect(await screen.findByRole('menuitemradio', { name: /opus 4\.8/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^back$/i })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: /switch engine/i }))

    // Engine panel: every engine listed + a Back control — all within ONE menu.
    expect(await screen.findByRole('menuitem', { name: /^back$/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /antigravity/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /codex/i })).toBeTruthy()
    // Exactly one menu surface — proves it isn't a nested/second menu.
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    // The model radio list is no longer mounted while on the engine panel.
    expect(screen.queryByRole('menuitemradio', { name: /opus 4\.8/i })).toBeNull()
  })

  it('"Switch engine…" row does not include every engine name in the button label', async () => {
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()

    const item = await screen.findByRole('menuitem', { name: /^switch engine…$/i })
    expect(item.textContent).toBe('Switch engine…')
    expect(screen.queryByRole('menuitem', { name: /switch engine.*codex/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /switch engine.*antigravity/i })).toBeNull()
  })

  it('Back returns to the model/effort panel', async () => {
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^back$/i }))

    // Back on the main panel: model list returns, engine list/Back gone.
    expect(await screen.findByRole('menuitemradio', { name: /opus 4\.8/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^back$/i })).toBeNull()
  })

  it('selecting an engine auto-returns to main, reflects the new engine models, and fires onChange', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={onChange} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /codex/i }))

    // onChange fired with the new engine + its default model (cascade preserved).
    expect(onChange).toHaveBeenCalledWith({ engine: 'codex', model: 'gpt-5.5', effortLevel: 'medium' })
    // Auto-returned to the main panel (Back gone) now showing codex's model
    // (the menu is modal while open, so the chip itself isn't queryable here).
    expect(await screen.findByRole('menuitemradio', { name: /gpt-5\.5/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^back$/i })).toBeNull()
  })

  it('effort selection callback still fires (engine/model preserved)', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={onChange} />)
    openMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'low' }))
    expect(onChange).toHaveBeenCalledWith({ engine: 'claude', model: 'opus', effortLevel: 'low' })
  })

  it('uses a scrollable effort row for long effort sets', async () => {
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()
    const row = await screen.findByTestId('effort-levels')
    expect(row.className).toContain('overflow-x-auto')
    expect(screen.getByRole('button', { name: 'xhigh' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'max' })).toBeTruthy()
  })

  it('model selection callback still fires (effort clamped to a valid level)', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={onChange} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /sonnet 4\.6/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ engine: 'claude', model: 'claude-sonnet-4-6' }))
  })

  it('existing-chat can switch engines in-place', async () => {
    const onChange = vi.fn()
    renderRow(
      <ModelSelectorRow
        mode="existing"
        value={{ engine: 'claude', model: 'opus', effortLevel: 'high' }}
        onChange={onChange}
      />,
    )
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /codex/i }))
    expect(onChange).toHaveBeenCalledWith({ engine: 'codex', model: 'gpt-5.5', effortLevel: 'medium' })
  })
})

describe('ModelSelectorRow featured / expand', () => {
  beforeEach(() => {
    regHolder.current = FEATURED_REG
    if (typeof localStorage !== 'undefined') localStorage.clear()
  })
  afterEach(() => {
    regHolder.current = REG
    if (typeof localStorage !== 'undefined') localStorage.clear()
  })

  it('collapsed: shows exactly the featured models, hiding the rest behind "More models…"', async () => {
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()
    await screen.findByRole('menuitemradio', { name: /opus \(latest\)/i })

    const radios = screen.getAllByRole('menuitemradio')
    expect(radios.map((r) => r.textContent)).toEqual(['Opus (Latest)', 'Sonnet (Latest)', 'Fable (Latest)'])
    // The two non-featured concrete ids are not listed while collapsed.
    expect(screen.queryByRole('menuitemradio', { name: /opus 4\.8/i })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: /haiku 4\.5/i })).toBeNull()
    // Expand affordance names the hidden count.
    expect(screen.getByRole('menuitem', { name: /more models \(2\)/i })).toBeTruthy()
  })

  it('expanded: "More models…" reveals the full registry and swaps to "Show fewer"', async () => {
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /more models/i }))

    // All five models now listed.
    const radios = screen.getAllByRole('menuitemradio')
    expect(radios).toHaveLength(5)
    expect(screen.getByRole('menuitemradio', { name: /opus 4\.8/i })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /haiku 4\.5/i })).toBeTruthy()
    // Toggle flips to collapse.
    expect(screen.getByRole('menuitem', { name: /show fewer/i })).toBeTruthy()
  })

  it('include-current-always: a non-featured pinned model still shows collapsed', async () => {
    renderRow(<Harness initial={{ engine: 'claude', model: 'claude-haiku-4-5', effortLevel: 'medium' }} />)
    openMenu()
    await screen.findByRole('menuitemradio', { name: /haiku 4\.5/i })

    const radios = screen.getAllByRole('menuitemradio')
    // 3 featured + the current (non-featured) haiku = 4; only opus-4-8 stays hidden.
    expect(radios.map((r) => r.textContent)).toEqual([
      'Opus (Latest)', 'Sonnet (Latest)', 'Fable (Latest)', 'Haiku 4.5',
    ])
    expect(screen.getByRole('menuitem', { name: /more models \(1\)/i })).toBeTruthy()
  })

  it('persists the expand choice across remounts (localStorage)', async () => {
    const { unmount } = renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /more models/i }))
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    unmount()

    // Fresh mount reads the persisted pref — full list without re-expanding.
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()
    expect(await screen.findByRole('menuitem', { name: /show fewer/i })).toBeTruthy()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
  })

  it('engines with no featured marking keep the full list (no expand affordance)', async () => {
    regHolder.current = REG // claude entry here has no featured flags
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} />)
    openMenu()
    await screen.findByRole('menuitemradio', { name: /opus 4\.8/i })
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
    expect(screen.queryByRole('menuitem', { name: /more models/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /show fewer/i })).toBeNull()
  })
})

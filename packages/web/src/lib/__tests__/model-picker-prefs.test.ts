import { describe, it, expect, beforeEach } from 'vitest'
import { loadExpandedByEngine, isEngineExpanded, setEngineExpanded } from '../model-picker-prefs'

describe('model-picker-prefs', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear()
  })

  it('defaults to not-expanded for an unknown engine', () => {
    expect(isEngineExpanded('claude')).toBe(false)
    expect(loadExpandedByEngine()).toEqual({})
  })

  it('persists and reads back per-engine expand flags', () => {
    setEngineExpanded('claude', true)
    expect(isEngineExpanded('claude')).toBe(true)
    expect(isEngineExpanded('hermes')).toBe(false)
    expect(loadExpandedByEngine()).toEqual({ claude: true })
  })

  it('updates one engine without clobbering the others', () => {
    setEngineExpanded('claude', true)
    setEngineExpanded('hermes', true)
    setEngineExpanded('claude', false)
    expect(loadExpandedByEngine()).toEqual({ claude: false, hermes: true })
  })

  it('tolerates corrupt storage without throwing', () => {
    localStorage.setItem('jinn-model-picker-expanded', '{not json')
    expect(loadExpandedByEngine()).toEqual({})
    expect(isEngineExpanded('claude')).toBe(false)
  })
})

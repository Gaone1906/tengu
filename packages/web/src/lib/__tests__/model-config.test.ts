import { describe, expect, it } from 'vitest'
import {
  addModelOverride,
  hideModelOverride,
  type ModelsConfigShape,
  resetEngineModelOverrides,
  showModelOverride,
} from '../model-config'

describe('model config helpers', () => {
  it('adds a custom model entry with Claude effort defaults', () => {
    const next = addModelOverride({} as ModelsConfigShape, 'claude', { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' })
    expect(next.models?.claude?.models).toEqual([
      {
        id: 'claude-sonnet-4-6',
        label: 'Sonnet 4.6',
        supportsEffort: true,
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ])
  })

  it('uses discovered Claude effort levels when supplied for a custom model', () => {
    const next = addModelOverride({} as ModelsConfigShape, 'claude', {
      id: 'claude-ultra-preview',
      label: 'Ultra Preview',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    })

    expect(next.models?.claude?.models[0]?.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })

  it('hides, restores, and resets model overrides without duplicating ids', () => {
    const hidden = hideModelOverride({} as ModelsConfigShape, 'claude', 'sonnet')
    expect(hidden.models?.claude?.hidden).toEqual(['sonnet'])

    const stillHidden = hideModelOverride(hidden, 'claude', 'sonnet')
    expect(stillHidden.models?.claude?.hidden).toEqual(['sonnet'])

    const restored = showModelOverride(stillHidden, 'claude', 'sonnet')
    expect(restored.models?.claude?.hidden).toEqual([])

    const reset = resetEngineModelOverrides(addModelOverride(hidden, 'claude', { id: 'custom' }), 'claude')
    expect(reset.models?.claude).toBeUndefined()
  })
})

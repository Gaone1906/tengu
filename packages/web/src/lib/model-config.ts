const DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ModelConfigEntry {
  id: string
  label?: string
  supportsEffort?: boolean
  effortLevels?: string[]
  contextWindow?: number
}

export interface EngineModelsConfig {
  default?: string
  effortMechanism?: string
  hidden?: string[]
  models: ModelConfigEntry[]
}

export interface ModelsConfigShape {
  models?: Record<string, EngineModelsConfig | undefined>
  [key: string]: unknown
}

function cloneConfig<T extends ModelsConfigShape>(config: T): T {
  return structuredClone(config)
}

function ensureBlock<T extends ModelsConfigShape>(config: T, engine: string): EngineModelsConfig {
  config.models ??= {}
  config.models[engine] ??= { models: [] }
  config.models[engine].models ??= []
  return config.models[engine]
}

export function addModelOverride<T extends ModelsConfigShape>(
  config: T,
  engine: string,
  entry: { id: string; label?: string; effortLevels?: string[] },
): T {
  const id = entry.id.trim()
  if (!id) return config
  const next = cloneConfig(config)
  const block = ensureBlock(next, engine)
  const existing = block.models.find((m) => m.id === id)
  const model: ModelConfigEntry = {
    id,
    ...(entry.label?.trim() ? { label: entry.label.trim() } : {}),
    supportsEffort: engine === 'claude',
    effortLevels: engine === 'claude' ? [...(entry.effortLevels?.length ? entry.effortLevels : DEFAULT_EFFORT_LEVELS)] : [],
  }
  if (existing) Object.assign(existing, model)
  else block.models.push(model)
  block.hidden = (block.hidden ?? []).filter((hiddenId) => hiddenId !== id)
  return next
}

export function hideModelOverride<T extends ModelsConfigShape>(config: T, engine: string, id: string): T {
  const modelId = id.trim()
  if (!modelId) return config
  const next = cloneConfig(config)
  const block = ensureBlock(next, engine)
  block.hidden = Array.from(new Set([...(block.hidden ?? []), modelId]))
  return next
}

export function showModelOverride<T extends ModelsConfigShape>(config: T, engine: string, id: string): T {
  const modelId = id.trim()
  if (!modelId) return config
  const next = cloneConfig(config)
  const block = ensureBlock(next, engine)
  block.hidden = (block.hidden ?? []).filter((hiddenId) => hiddenId !== modelId)
  return next
}

export function resetEngineModelOverrides<T extends ModelsConfigShape>(config: T, engine: string): T {
  const next = cloneConfig(config)
  if (next.models) {
    delete next.models[engine]
    if (Object.keys(next.models).length === 0) delete next.models
  }
  return next
}

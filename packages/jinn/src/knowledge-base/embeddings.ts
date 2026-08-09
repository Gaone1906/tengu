import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers"

export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5"
export const EMBEDDING_DIMENSIONS = 384

export interface EmbedOptions {
  model?: string
}

interface LoadedPipeline {
  modelName: string
  promise: Promise<FeatureExtractionPipeline>
}

let loaded: LoadedPipeline | null = null

function loadPipeline(modelName: string): Promise<FeatureExtractionPipeline> {
  if (loaded && loaded.modelName === modelName) return loaded.promise
  const promise = pipeline("feature-extraction", modelName) as Promise<FeatureExtractionPipeline>
  loaded = { modelName, promise }
  return promise
}

export async function embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return []
  const modelName = options.model ?? DEFAULT_EMBEDDING_MODEL
  const extractor = await loadPipeline(modelName)
  const output = await extractor(texts, { pooling: "mean", normalize: true })
  const vectors = output.tolist() as number[][]
  return vectors
}

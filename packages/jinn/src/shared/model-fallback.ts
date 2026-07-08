import type { ModelInfo } from "./types.js";
import { claudeFallbackCandidates } from "./claude-models.js";

const NON_MODEL_FAILURES = /\b(rate[_ -]?limit|quota|billing|credit|unauthori[sz]ed|forbidden|auth|api key|network|timeout|econn|dns|socket)\b/i;
const MODEL_AVAILABILITY = /\b(model|models)\b.*\b(not found|not available|unavailable|invalid|unsupported|does not exist|unknown)\b/i;
const INVALID_MODEL = /\b(invalid|unsupported|unknown)\b.*\b(model|models)\b/i;
const API_404_MODEL = /\b(404|not_found_error)\b.*\bmodel\b/i;

export function isModelAvailabilityError(error: string | undefined | null): boolean {
  if (!error) return false;
  if (NON_MODEL_FAILURES.test(error)) return false;
  return MODEL_AVAILABILITY.test(error) || INVALID_MODEL.test(error) || API_404_MODEL.test(error);
}

export function selectClaudeModelFallback(opts: {
  engine: string;
  requestedModel?: string;
  error?: string | null;
  models: ModelInfo[];
}): string | undefined {
  if (opts.engine !== "claude") return undefined;
  if (!isModelAvailabilityError(opts.error)) return undefined;
  return claudeFallbackCandidates(opts.models, opts.requestedModel)[0];
}

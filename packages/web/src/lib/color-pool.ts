/**
 * Curated pool of visually distinct, accessible colors for employee avatars.
 * Each hex is chosen to stay legible as a ring/accent in both light and dark themes.
 */
export const COLOR_POOL = [
  "#F87171", "#FB923C", "#FBBF24", "#A3E635", "#4ADE80",
  "#34D399", "#2DD4BF", "#22D3EE", "#38BDF8", "#60A5FA",
  "#818CF8", "#A78BFA", "#C084FC", "#E879F9", "#F472B6",
  "#FB7185", "#FCA5A5", "#FDBA74", "#FDE047", "#BEF264",
] as const

export type PoolColor = (typeof COLOR_POOL)[number]

/** Deterministic hash → color index from a name string */
export function colorForName(name: string): string {
  if (!name) return COLOR_POOL[0]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  }
  return COLOR_POOL[Math.abs(hash) % COLOR_POOL.length]
}

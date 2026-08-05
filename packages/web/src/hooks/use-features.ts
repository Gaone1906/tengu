import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import type { StaleChatPolicy } from "@/lib/stale-chat"

export interface Features {
  notesEnabled: boolean
  staleChat: StaleChatPolicy
}

const DISABLED_STALE_CHAT: StaleChatPolicy = {
  enabled: false,
  tokenThreshold: 300_000,
  staleAfterMinutes: 60,
}

export function useFeatures() {
  const [features, setFeatures] = useState<Features | undefined>()
  const [isPending, setIsPending] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.getFeatures()
      .then((next) => { if (!cancelled) setFeatures(next) })
      .catch(() => { if (!cancelled) setFeatures({ notesEnabled: false, staleChat: DISABLED_STALE_CHAT }) })
      .finally(() => { if (!cancelled) setIsPending(false) })
    return () => { cancelled = true }
  }, [])

  return { data: features, isPending }
}

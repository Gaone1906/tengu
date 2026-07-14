import { useEffect, useState } from "react"
import { api } from "@/lib/api"

export interface Features {
  notesEnabled: boolean
}

export function useFeatures() {
  const [features, setFeatures] = useState<Features | undefined>()
  const [isPending, setIsPending] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.getFeatures()
      .then((next) => { if (!cancelled) setFeatures(next) })
      .catch(() => { if (!cancelled) setFeatures({ notesEnabled: false }) })
      .finally(() => { if (!cancelled) setIsPending(false) })
    return () => { cancelled = true }
  }, [])

  return { data: features, isPending }
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ChatPin, type PinsResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

const LEGACY_PIN_STORAGE_KEY = 'jinn-pinned-sessions'

function readLegacyPins(): { present: boolean; keys: string[] } {
  if (typeof localStorage === 'undefined') return { present: false, keys: [] }
  try {
    const raw = localStorage.getItem(LEGACY_PIN_STORAGE_KEY)
    if (raw === null) return { present: false, keys: [] }
    const parsed = JSON.parse(raw)
    const keys = Array.isArray(parsed)
      ? [...new Set(parsed.filter((key): key is string => typeof key === 'string' && key.length > 0))]
      : []
    return { present: true, keys }
  } catch {
    return { present: true, keys: [] }
  }
}

function optimisticPin(key: string): ChatPin {
  return {
    key,
    kind: key.startsWith('emp:') ? 'employee' : 'session',
    pinnedAt: new Date().toISOString(),
  }
}

async function fetchPins(): Promise<PinsResponse> {
  const server = await api.getPins()
  const legacy = readLegacyPins()
  if (!legacy.present) return server

  const serverKeys = new Set(server.pins.map((pin) => pin.key))
  const missing = legacy.keys.filter((key) => !serverKeys.has(key))
  await Promise.all(missing.map((key) => api.pinChat(key)))
  localStorage.removeItem(LEGACY_PIN_STORAGE_KEY)
  return { pins: [...server.pins, ...missing.map(optimisticPin)] }
}

const selectPinKeys = (response: PinsResponse) => new Set(response.pins.map((pin) => pin.key))

export function usePins() {
  return useQuery({
    queryKey: queryKeys.pins,
    queryFn: fetchPins,
    select: selectPinKeys,
  })
}

export function useTogglePin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, pinned }: { key: string; pinned: boolean }) => (
      pinned ? api.pinChat(key) : api.unpinChat(key)
    ),
    onMutate: async ({ key, pinned }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.pins })
      const previous = queryClient.getQueryData<PinsResponse>(queryKeys.pins)
      queryClient.setQueryData<PinsResponse>(queryKeys.pins, (current = { pins: [] }) => ({
        pins: pinned
          ? current.pins.some((pin) => pin.key === key)
            ? current.pins
            : [...current.pins, optimisticPin(key)]
          : current.pins.filter((pin) => pin.key !== key),
      }))
      return { previous }
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(queryKeys.pins, context?.previous)
    },
  })
}

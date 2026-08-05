import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

export function useExperiments() {
  return useQuery({
    queryKey: ["experiments"],
    queryFn: () => api.listExperiments(),
    staleTime: 15_000,
  })
}

export function useExperiment(id: string | undefined) {
  return useQuery({
    queryKey: ["experiments", id],
    queryFn: () => api.getExperiment(id!),
    enabled: !!id,
    staleTime: 15_000,
  })
}

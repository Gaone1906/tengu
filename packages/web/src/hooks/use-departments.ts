import { useQuery } from "@tanstack/react-query"
import { api, type DepartmentSummaryWire } from "@/lib/api"

export function useDepartments() {
  return useQuery({
    queryKey: ["departments"],
    queryFn: async (): Promise<DepartmentSummaryWire[]> => (await api.getDepartments()).departments,
    staleTime: 60_000,
  })
}

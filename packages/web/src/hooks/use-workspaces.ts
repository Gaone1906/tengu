import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type WorkspaceInfo } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"

export function useWorkspaces() {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: api.listWorkspaces,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}

export function useStartWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: ["workspaces", "start"],
    mutationFn: api.startWorkspace,
    onSuccess: (started) => {
      queryClient.setQueryData<WorkspaceInfo[]>(queryKeys.workspaces, (workspaces) => (
        workspaces?.map((workspace) => workspace.id === started.id ? started : workspace)
      ))
    },
  })
}

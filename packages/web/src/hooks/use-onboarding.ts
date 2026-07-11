import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

/**
 * Shared onboarding-status query. Both the SettingsProvider (which syncs the
 * portal/operator names from the backend) and the DeferredOnboardingWizard
 * consume this single react-query key, so a clean load fires exactly one
 * `/api/onboarding` request instead of two.
 *
 * Status is effectively immutable within a session, so it never goes stale and
 * is not retried — a failed fetch is treated as "best-effort" by callers.
 */
export function useOnboarding(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.onboarding,
    queryFn: () => api.getOnboarding(),
    enabled: options?.enabled ?? true,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

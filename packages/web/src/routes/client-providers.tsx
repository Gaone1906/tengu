
import type { ReactNode } from "react"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { ThemeProvider } from "@/routes/providers"
import { SettingsProvider, DocumentTitle } from "@/routes/settings-provider"
import { useQueryInvalidation } from '@/hooks/use-query-invalidation'
import { BreadcrumbProvider } from '@/context/breadcrumb-context'
import { EmojiFavicon } from '@/components/emoji-favicon'
import { GatewayProvider } from '@/hooks/use-gateway'
import { AuthGate, AuthProvider } from "@/routes/auth-provider"
import { InstanceMigrationGate } from "@/components/migration/instance-migration-gate"

function QueryInvalidationBridge() {
  useQueryInvalidation()
  return null
}

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BreadcrumbProvider>
          <AuthProvider>
            <AuthGate>
              <SettingsProvider>
                <GatewayProvider>
                  <InstanceMigrationGate />
                  {children}
                  <DocumentTitle />
                  <EmojiFavicon />
                  <QueryInvalidationBridge />
                </GatewayProvider>
              </SettingsProvider>
            </AuthGate>
          </AuthProvider>
        </BreadcrumbProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

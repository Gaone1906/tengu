"use client"

import type { ReactNode } from "react"
import { ThemeProvider } from "@/app/providers"
import { SettingsProvider, DocumentTitle } from "@/app/settings-provider"
import { NotificationProvider } from "@/components/notifications/notification-provider"

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <NotificationProvider>
          {children}
          <DocumentTitle />
        </NotificationProvider>
      </SettingsProvider>
    </ThemeProvider>
  )
}

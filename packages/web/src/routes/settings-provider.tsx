
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import {
  type JinnSettings,
  type EmployeeOverride,
  DEFAULTS,
  loadSettings,
  saveSettings,
  hexToAccentFill,
  hexToContrastText,
} from '@/lib/settings'
import { useOnboarding } from '@/hooks/use-onboarding'

interface EmployeeDisplay {
  emoji: string
  profileImage?: string
  emojiOnly?: boolean
}

interface SettingsContextValue {
  settings: JinnSettings
  setAccentColor: (color: string | null) => void
  setCompanyName: (name: string | null) => void
  setPortalName: (name: string | null) => void
  setPortalSubtitle: (subtitle: string | null) => void
  setPortalEmoji: (emoji: string | null) => void
  setPortalIcon: (icon: string | null) => void
  setIconBgHidden: (hidden: boolean) => void
  setEmojiOnly: (emojiOnly: boolean) => void
  setOperatorName: (name: string | null) => void
  setLanguage: (language: string) => void
  setEmployeeOverride: (employeeId: string, override: EmployeeOverride) => void
  clearEmployeeOverride: (employeeId: string) => void
  getEmployeeDisplay: (employee: { name: string; emoji: string; id: string }) => EmployeeDisplay
  resetAll: () => void
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: { accentColor: null, companyName: null, portalName: null, portalSubtitle: null, portalEmoji: null, portalIcon: null, iconBgHidden: false, emojiOnly: false, operatorName: null, language: "English", employeeOverrides: {} },
  setAccentColor: () => {},
  setCompanyName: () => {},
  setPortalName: () => {},
  setPortalSubtitle: () => {},
  setPortalEmoji: () => {},
  setPortalIcon: () => {},
  setIconBgHidden: () => {},
  setEmojiOnly: () => {},
  setOperatorName: () => {},
  setLanguage: () => {},
  setEmployeeOverride: () => {},
  clearEmployeeOverride: () => {},
  getEmployeeDisplay: (employee) => ({ emoji: employee.emoji }),
  resetAll: () => {},
})

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  // Initialize with defaults so server and client render the same HTML.
  // Hydrate from localStorage after mount to avoid hydration mismatch.
  const [settings, setSettings] = useState<JinnSettings>({ ...DEFAULTS })

  // Onboarding status/names come from the shared react-query key so the whole
  // app fires exactly one /api/onboarding request (the wizard consumes it too).
  const { data: onboarding } = useOnboarding()

  // Hydrate from localStorage on mount.
  useEffect(() => {
    setSettings(loadSettings())
  }, [])

  // Then sync companyName/portalName/operatorName from backend config (source of truth) once
  // the shared onboarding query resolves. This ensures the correct COO name
  // shows up even if localStorage has stale values from a previous onboarding.
  useEffect(() => {
    if (!onboarding || (!onboarding.companyName && !onboarding.portalName && !onboarding.operatorName)) return
    setSettings((prev) => {
      const merged = {
        ...prev,
        ...(onboarding.companyName ? { companyName: onboarding.companyName } : {}),
        ...(onboarding.portalName ? { portalName: onboarding.portalName } : {}),
        ...(onboarding.operatorName ? { operatorName: onboarding.operatorName } : {}),
      }
      saveSettings(merged)
      return merged
    })
  }, [onboarding])

  // Apply accent color CSS variables when settings change
  useEffect(() => {
    const el = document.documentElement.style
    if (settings.accentColor) {
      el.setProperty('--accent', settings.accentColor)
      el.setProperty('--accent-fill', hexToAccentFill(settings.accentColor))
      el.setProperty('--accent-contrast', hexToContrastText(settings.accentColor))
    } else {
      el.removeProperty('--accent')
      el.removeProperty('--accent-fill')
      el.removeProperty('--accent-contrast')
    }
  }, [settings.accentColor])

  const update = useCallback((updater: (prev: JinnSettings) => JinnSettings) => {
    setSettings((prev) => {
      const next = updater(prev)
      saveSettings(next)
      return next
    })
  }, [])

  const setAccentColor = useCallback(
    (color: string | null) => {
      update((prev) => ({ ...prev, accentColor: color }))
    },
    [update],
  )

  const setPortalName = useCallback(
    (name: string | null) => {
      update((prev) => ({ ...prev, portalName: name || null }))
    },
    [update],
  )

  const setCompanyName = useCallback(
    (name: string | null) => {
      update((prev) => ({ ...prev, companyName: name || null }))
    },
    [update],
  )

  const setPortalSubtitle = useCallback(
    (subtitle: string | null) => {
      update((prev) => ({ ...prev, portalSubtitle: subtitle || null }))
    },
    [update],
  )

  const setPortalEmoji = useCallback(
    (emoji: string | null) => {
      update((prev) => ({ ...prev, portalEmoji: emoji || null }))
    },
    [update],
  )

  const setPortalIcon = useCallback(
    (icon: string | null) => {
      update((prev) => ({ ...prev, portalIcon: icon }))
    },
    [update],
  )

  const setIconBgHidden = useCallback(
    (hidden: boolean) => {
      update((prev) => ({ ...prev, iconBgHidden: hidden }))
    },
    [update],
  )

  const setEmojiOnly = useCallback(
    (emojiOnly: boolean) => {
      update((prev) => ({ ...prev, emojiOnly }))
    },
    [update],
  )

  const setOperatorName = useCallback(
    (name: string | null) => {
      update((prev) => ({ ...prev, operatorName: name || null }))
    },
    [update],
  )

  const setLanguage = useCallback(
    (language: string) => {
      update((prev) => ({ ...prev, language: language || "English" }))
    },
    [update],
  )

  const setEmployeeOverride = useCallback(
    (employeeId: string, override: EmployeeOverride) => {
      update((prev) => {
        const existing = prev.employeeOverrides[employeeId] || {}
        return {
          ...prev,
          employeeOverrides: {
            ...prev.employeeOverrides,
            [employeeId]: { ...existing, ...override },
          },
        }
      })
    },
    [update],
  )

  const clearEmployeeOverride = useCallback(
    (employeeId: string) => {
      update((prev) => {
        const { [employeeId]: _, ...rest } = prev.employeeOverrides
        return { ...prev, employeeOverrides: rest }
      })
    },
    [update],
  )

  const getEmployeeDisplay = useCallback(
    (employee: { name: string; emoji: string; id: string }): EmployeeDisplay => {
      const override = settings.employeeOverrides[employee.id]
      return {
        emoji: override?.emoji || employee.emoji,
        profileImage: override?.profileImage,
        emojiOnly: settings.emojiOnly,
      }
    },
    [settings.employeeOverrides, settings.emojiOnly],
  )

  const resetAll = useCallback(() => {
    update(() => ({
      accentColor: null,
      companyName: null,
      portalName: null,
      portalSubtitle: null,
      portalEmoji: null,
      portalIcon: null,
      iconBgHidden: false,
      emojiOnly: false,
      operatorName: null,
      language: "English",
      employeeOverrides: {},
    }))
  }, [update])

  return (
    <SettingsContext.Provider
      value={{
        settings,
        setAccentColor,
        setCompanyName,
        setPortalName,
        setPortalSubtitle,
        setPortalEmoji,
        setPortalIcon,
        setIconBgHidden,
        setEmojiOnly,
        setOperatorName,
        setLanguage,
        setEmployeeOverride,
        clearEmployeeOverride,
        getEmployeeDisplay,
        resetAll,
      }}
    >
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => useContext(SettingsContext)

/** Sets document.title from the portal name setting. One-time write per change —
 *  no MutationObserver (it raced with Next.js metadata / breadcrumb-context). */
export function DocumentTitle() {
  const { settings } = useSettings()

  useEffect(() => {
    const name = settings.portalName || 'Jinn'
    const desired = `${name} - AI Gateway`
    if (document.title !== desired) {
      document.title = desired
    }
  }, [settings.portalName])

  return null
}

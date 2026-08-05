import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../page'

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getOrg: vi.fn(),
  sttStatus: vi.fn(),
  sttUpdateConfig: vi.fn(),
  sttDownload: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/context/breadcrumb-context', () => ({ useBreadcrumbs: vi.fn() }))
vi.mock('@/routes/providers', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({
    settings: {},
    setAccentColor: vi.fn(),
    setCompanyName: vi.fn(),
    setPortalName: vi.fn(),
    setPortalSubtitle: vi.fn(),
    setOperatorName: vi.fn(),
    setPortalEmoji: vi.fn(),
    setLanguage: vi.fn(),
    resetAll: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-model-registry', () => ({ useModelRegistry: () => ({ data: undefined }) }))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({
    authState: {},
    devices: [],
    createPairingCode: vi.fn(),
    logout: vi.fn(),
    unpairDevice: vi.fn(),
  }),
}))

describe('Settings stale chat controls', () => {
  beforeEach(() => {
    apiMocks.getConfig.mockResolvedValue({
      sessions: {
        staleChat: {
          enabled: false,
          tokenThreshold: 50_000,
          staleAfterMinutes: 20,
        },
      },
    })
    apiMocks.updateConfig.mockResolvedValue({})
    apiMocks.getOrg.mockResolvedValue({ employees: [] })
    apiMocks.sttStatus.mockResolvedValue({
      available: false,
      model: null,
      downloading: false,
      progress: 0,
      languages: ['en'],
    })
    apiMocks.sttUpdateConfig.mockResolvedValue({})
    apiMocks.sttDownload.mockResolvedValue({})
  })

  it('writes the policy fields and disables thresholds with the toggle off', async () => {
    render(<SettingsPage />)

    const toggle = await screen.findByRole('switch', { name: 'Suggest fresh chats' })
    const tokenThreshold = screen.getByRole('spinbutton', { name: 'Context token threshold' })
    const idleMinutes = screen.getByRole('spinbutton', { name: 'Idle minutes' })
    expect(toggle.className).toContain('h-[34px]')
    expect(tokenThreshold.hasAttribute('disabled')).toBe(true)
    expect(idleMinutes.hasAttribute('disabled')).toBe(true)

    fireEvent.click(toggle)
    expect(tokenThreshold.hasAttribute('disabled')).toBe(false)
    expect(idleMinutes.hasAttribute('disabled')).toBe(false)
    fireEvent.change(tokenThreshold, { target: { value: '450000' } })
    fireEvent.change(idleMinutes, { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }))

    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      sessions: {
        staleChat: {
          enabled: true,
          tokenThreshold: 450_000,
          staleAfterMinutes: 90,
        },
      },
    })))
  })
})

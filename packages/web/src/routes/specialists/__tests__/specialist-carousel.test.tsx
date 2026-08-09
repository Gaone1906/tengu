import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpecialistCarousel, type CarouselSpecialist } from '../specialist-carousel'

vi.mock('@/components/ui/employee-avatar', () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`}>{name.charAt(0)}</span>,
}))

const roster: CarouselSpecialist[] = [
  { name: 'billing-api', displayName: 'Billing API Specialist', repo: '~/repos/billing-api', model: 'sonnet', effortLevel: 'medium' },
  { name: 'web-frontend', displayName: 'Web Frontend Specialist', repo: '~/repos/web-frontend', model: 'sonnet', effortLevel: 'high' },
  { name: 'infra', displayName: 'Infra Specialist', repo: '~/repos/infra' },
]

function noop() {}

function renderCarousel(overrides: Partial<React.ComponentProps<typeof SpecialistCarousel>> = {}) {
  const onChangeIndex = vi.fn<(index: number) => void>()
  const props: React.ComponentProps<typeof SpecialistCarousel> = {
    specialists: roster,
    activeIndex: 0,
    onChangeIndex,
    kbManifest: null,
    kbExists: false,
    kbLoading: false,
    onStartChat: vi.fn(),
    teachingAvailable: false,
    onTriggerTeaching: vi.fn(),
    onTriggerIncrementalLearning: vi.fn(),
    incrementalPending: false,
    incrementalTriggered: false,
    ...overrides,
  }
  const utils = render(<SpecialistCarousel {...props} />)
  return { onChangeIndex, props, ...utils }
}

describe('SpecialistCarousel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --- Roster rendering ---

  it('renders the active card from the roster', () => {
    renderCarousel({ activeIndex: 0 })
    expect(screen.getByText('Billing API Specialist')).toBeDefined()
    expect(screen.getByText('~/repos/billing-api')).toBeDefined()
  })

  it('renders only one card at a time', () => {
    renderCarousel({ activeIndex: 1 })
    expect(screen.getByText('Web Frontend Specialist')).toBeDefined()
    expect(screen.queryByText('Billing API Specialist')).toBeNull()
    expect(screen.queryByText('Infra Specialist')).toBeNull()
  })

  it('shows model and effort as a badge when present', () => {
    renderCarousel({ activeIndex: 0 })
    expect(screen.getByText('sonnet · medium')).toBeDefined()
  })

  // --- Paging: prev/next ---

  it('advances to the next specialist on next click', () => {
    const { onChangeIndex } = renderCarousel({ activeIndex: 0 })
    fireEvent.click(screen.getByTestId('carousel-next'))
    expect(onChangeIndex).toHaveBeenCalledWith(1)
  })

  it('goes to the previous specialist on prev click', () => {
    const { onChangeIndex } = renderCarousel({ activeIndex: 1 })
    fireEvent.click(screen.getByTestId('carousel-prev'))
    expect(onChangeIndex).toHaveBeenCalledWith(0)
  })

  it('wraps around from the last card to the first on next', () => {
    const { onChangeIndex } = renderCarousel({ activeIndex: 2 })
    fireEvent.click(screen.getByTestId('carousel-next'))
    expect(onChangeIndex).toHaveBeenCalledWith(0)
  })

  it('wraps around from the first card to the last on prev', () => {
    const { onChangeIndex } = renderCarousel({ activeIndex: 0 })
    fireEvent.click(screen.getByTestId('carousel-prev'))
    expect(onChangeIndex).toHaveBeenCalledWith(2)
  })

  // --- Paging: keyboard ---

  it('pages with ArrowRight/ArrowLeft', () => {
    const { onChangeIndex } = renderCarousel({ activeIndex: 0 })
    const group = screen.getByTestId('specialist-carousel')
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(onChangeIndex).toHaveBeenCalledWith(1)
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(onChangeIndex).toHaveBeenCalledWith(2)
  })

  // --- Paging: dots ---

  it('jumps directly to a card via its dot', () => {
    const { onChangeIndex } = renderCarousel({ activeIndex: 0 })
    fireEvent.click(screen.getByTestId('carousel-dot-infra'))
    expect(onChangeIndex).toHaveBeenCalledWith(2)
  })

  it('marks the active dot as selected', () => {
    renderCarousel({ activeIndex: 1 })
    expect(screen.getByTestId('carousel-dot-web-frontend').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('carousel-dot-billing-api').getAttribute('aria-selected')).toBe('false')
  })

  it('hides prev/next dots when there is only one specialist', () => {
    renderCarousel({ specialists: [roster[0]], activeIndex: 0 })
    expect(screen.getByTestId('carousel-prev').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('carousel-next').hasAttribute('disabled')).toBe(true)
    expect(screen.queryByTestId('carousel-dot-billing-api')).toBeNull()
  })

  // --- Empty roster ---

  it('shows an empty state and no paging controls when the roster is empty', () => {
    renderCarousel({ specialists: [], activeIndex: 0 })
    expect(screen.getByTestId('specialist-carousel-empty')).toBeDefined()
    expect(screen.getByText(/no specialists yet/i)).toBeDefined()
    expect(screen.queryByTestId('carousel-next')).toBeNull()
  })

  // --- Chat action (chat-employee-picker.tsx's persona-binding pattern) ---

  it('starts a chat with the active specialist', () => {
    const onStartChat = vi.fn()
    renderCarousel({ activeIndex: 1, onStartChat })
    fireEvent.click(screen.getByTestId('action-chat'))
    expect(onStartChat).toHaveBeenCalledWith('web-frontend')
  })

  // --- Specialist-only actions ---

  it('triggers incremental learning for the active specialist', () => {
    const onTriggerIncrementalLearning = vi.fn()
    renderCarousel({ activeIndex: 0, onTriggerIncrementalLearning })
    fireEvent.click(screen.getByTestId('action-incremental-learning'))
    expect(onTriggerIncrementalLearning).toHaveBeenCalledWith('billing-api')
  })

  it('shows the incremental-learning button as pending and disabled while running', () => {
    renderCarousel({ activeIndex: 0, incrementalPending: true })
    expect(screen.getByTestId('action-incremental-learning').hasAttribute('disabled')).toBe(true)
  })

  it('shows "Triggered" once incremental learning has fired for this card', () => {
    renderCarousel({ activeIndex: 0, incrementalTriggered: true })
    expect(screen.getByTestId('action-incremental-learning').textContent).toContain('Triggered')
  })

  it('disables the teaching action and labels it not-yet-available when teachingAvailable is false', () => {
    renderCarousel({ activeIndex: 0, teachingAvailable: false })
    const btn = screen.getByTestId('action-teach')
    expect(btn.hasAttribute('disabled')).toBe(true)
    expect(btn.textContent).toMatch(/not yet available/i)
  })

  it('enables the teaching action once teachingAvailable is true', () => {
    const onTriggerTeaching = vi.fn()
    renderCarousel({ activeIndex: 0, teachingAvailable: true, onTriggerTeaching })
    const btn = screen.getByTestId('action-teach')
    expect(btn.hasAttribute('disabled')).toBe(false)
    fireEvent.click(btn)
    expect(onTriggerTeaching).toHaveBeenCalledWith('billing-api')
  })

  // --- KB panel ---

  it('shows a loading state for the KB panel', () => {
    renderCarousel({ activeIndex: 0, kbLoading: true })
    expect(screen.getByTestId('kb-loading')).toBeDefined()
  })

  it('shows a "no knowledge base yet" placeholder when the KB does not exist', () => {
    renderCarousel({ activeIndex: 0, kbLoading: false, kbExists: false, kbManifest: null })
    expect(screen.getByTestId('kb-empty')).toBeDefined()
  })

  it('surfaces manifest fields when the KB exists', () => {
    renderCarousel({
      activeIndex: 0,
      kbLoading: false,
      kbExists: true,
      kbManifest: {
        employeeName: 'billing-api',
        repo: '~/repos/billing-api',
        lastIndexedAt: '2026-08-01T12:00:00.000Z',
        lastIndexedGitSha: 'abc123',
        fileCount: 42,
        chunkCount: 918,
        embeddingModel: 'Xenova/bge-small-en-v1.5',
        schemaVersion: 1,
      },
    })
    expect(screen.queryByTestId('kb-empty')).toBeNull()
    expect(screen.getByText('42')).toBeDefined()
    expect(screen.getByText('918')).toBeDefined()
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatScopeMenu } from '../chat-scope-menu'

const projects = [
  { id: 'camera-app', label: 'Camera App', count: 3 },
  { id: 'platform', label: 'Platform', count: 5 },
]

describe('ChatScopeMenu', () => {
  it('reads as a plain scope control with an honest selected count', () => {
    render(
      <ChatScopeMenu
        value="project:platform"
        projects={projects}
        totalCount={10}
        needsCount={2}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Chat scope: Platform, 5 chats' })).toBeTruthy()
    expect(screen.getByText('Platform')).toBeTruthy()
    expect(screen.getByText('5 chats')).toBeTruthy()
  })

  it('selects global attention and project scopes from one menu', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <ChatScopeMenu
        value="all"
        projects={projects}
        totalCount={10}
        needsCount={2}
        onChange={onChange}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Chat scope: All chats, 10 chats' }))
    await user.click(screen.getByRole('menuitemradio', { name: /Needs you/i }))
    expect(onChange).toHaveBeenLastCalledWith('needs')

    await user.click(screen.getByRole('button', { name: 'Chat scope: All chats, 10 chats' }))
    await user.click(screen.getByRole('menuitemradio', { name: /Camera App/i }))
    expect(onChange).toHaveBeenLastCalledWith('project:camera-app')
  })

  it('keeps zero-attention state available without suggesting hidden work', async () => {
    const user = userEvent.setup()
    render(
      <ChatScopeMenu
        value="all"
        projects={projects}
        totalCount={8}
        needsCount={0}
        onChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Chat scope: All chats, 8 chats' }))
    expect(screen.getByRole('menuitemradio', { name: /Needs you/i }).textContent).toContain('0')
  })
})

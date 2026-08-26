// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { exportConversationToMarkdown } from '../src/client/export/markdown.ts'
import { ExportMarkdownAction, type ExportMarkdownActionProps } from '../src/client/export/ExportMarkdownAction.tsx'

describe('exportConversationToMarkdown', () => {
  it('formats user and assistant nodes with reasoning into structured markdown', () => {
    const snapshot = {
      sessionId: 'session-123' as SessionId,
      nodes: [
        {
          kind: 'user',
          seq: 1,
          time: 1000,
          content: [{ type: 'text', text: 'Hello, what is 2+2?' }],
        },
        {
          kind: 'assistant',
          seq: 2,
          time: 2000,
          turn: 1,
          step: 1,
          blocks: [
            { kind: 'reasoning', text: 'The user is asking a basic arithmetic question.' },
            { kind: 'text', text: '2 + 2 is 4.' },
          ],
        },
      ],
    } as unknown as ConversationSnapshot

    const markdown = exportConversationToMarkdown(snapshot, 'Math Query')
    expect(markdown).toContain('# Math Query')
    expect(markdown).toContain('*Session ID:* `session-123`')
    expect(markdown).toContain('## 👤 User')
    expect(markdown).toContain('Hello, what is 2+2?')
    expect(markdown).toContain('## 🤖 Assistant')
    expect(markdown).toContain('> **Thinking:**\n> The user is asking a basic arithmetic question.')
    expect(markdown).toContain('2 + 2 is 4.')
  })

  it('handles image attachments and steering messages', () => {
    const snapshot = {
      sessionId: 'session-456' as SessionId,
      nodes: [
        {
          kind: 'steering',
          seq: 1,
          time: 1000,
          content: [
            { type: 'text', text: 'Analyze this chart' },
            { type: 'image', attachment: { id: 'img-1', originalName: 'chart.png' } },
          ],
        },
      ],
    } as unknown as ConversationSnapshot

    const markdown = exportConversationToMarkdown(snapshot)
    expect(markdown).toContain('# DeepSeek Harness Conversation')
    expect(markdown).toContain('*Session ID:* `session-456`')
    expect(markdown).toContain('Analyze this chart')
    expect(markdown).toContain('![chart.png](attachment)')
  })
})

describe('ExportMarkdownAction', () => {
  it('returns null when snapshot has no user or assistant nodes', () => {
    const emptySnapshot = {
      sessionId: 'session-123' as SessionId,
      nodes: [],
    } as unknown as ConversationSnapshot

    const props = {
      sessionId: 'session-123' as SessionId,
      useSession: (selector: (s: ConversationSnapshot) => unknown) => selector(emptySnapshot),
      useSessions: () => undefined,
      t: (key: string) => key,
    } as unknown as ExportMarkdownActionProps

    const { container } = render(<ExportMarkdownAction {...props} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders download button and triggers export when clicked', () => {
    const snapshot = {
      sessionId: 'session-123' as SessionId,
      nodes: [
        {
          kind: 'user',
          seq: 1,
          time: 1000,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ],
    } as unknown as ConversationSnapshot

    const createObjectURL = vi.fn().mockReturnValue('blob:http://localhost/test')
    const revokeObjectURL = vi.fn()
    window.URL.createObjectURL = createObjectURL
    window.URL.revokeObjectURL = revokeObjectURL

    const props = {
      sessionId: 'session-123' as SessionId,
      useSession: (selector: (s: ConversationSnapshot) => unknown) => selector(snapshot),
      useSessions: (selector: (s: { byId: Record<string, { displayTitle: string }> }) => unknown) =>
        selector({ byId: { 'session-123': { displayTitle: 'My Test Session' } } }),
      t: () => 'Export to Markdown',
    } as unknown as ExportMarkdownActionProps

    render(<ExportMarkdownAction {...props} />)
    const btn = screen.getByRole('button', { name: 'Export to Markdown' })
    expect(btn).toBeDefined()

    fireEvent.click(btn)
    expect(createObjectURL).toHaveBeenCalled()
  })
})

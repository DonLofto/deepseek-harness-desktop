// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { exportConversationToMarkdown } from '../src/client/export/markdown.ts'

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
})

/**
 * Export conversation session transcript as clean GitHub-flavored Markdown.
 */
import type { ConversationSnapshot, AssistantBlock, UserMessageNode } from '@deepseek-ai/dsh-client-runtime/client'

type UserContentBlock = UserMessageNode['content'][number]

/**
 * Convert user/steering content blocks to plain text.
 */
function contentToText(content: readonly UserContentBlock[]): string {
  return content.map((item) => {
    if (item.type === 'text') return item.text
    if (item.type === 'image') {
      const name = (item.attachment as { originalName?: string } | undefined)?.originalName ?? 'Image'
      return `![${name}](attachment)`
    }
    return ''
  }).filter(Boolean).join('\n\n')
}

/**
 * Convert assistant blocks (text, thinking) to formatted Markdown.
 */
function assistantBlocksToMarkdown(blocks: readonly AssistantBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.kind === 'text') {
      parts.push(block.text)
    } else if (block.kind === 'reasoning') {
      parts.push(`> **Thinking:**\n> ${block.text.split('\n').join('\n> ')}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * Format an entire conversation snapshot into structured GitHub-flavored Markdown.
 * @param snapshot - conversation snapshot with historical nodes.
 * @param sessionTitle - optional session title.
 * @returns formatted markdown string.
 */
export function exportConversationToMarkdown(
  snapshot: ConversationSnapshot,
  sessionTitle?: string,
): string {
  const title = sessionTitle ?? 'DeepSeek Harness Conversation'
  const lines: string[] = [
    `# ${title}`,
    '',
    `*Session ID:* \`${snapshot.sessionId}\``,
    `*Exported on:* ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ]

  for (const node of snapshot.nodes) {
    if (node.kind === 'user' || node.kind === 'steering') {
      const text = contentToText(node.content)
      lines.push('## 👤 User', '', text, '', '---', '')
    } else if (node.kind === 'assistant') {
      const text = assistantBlocksToMarkdown(node.blocks)
      if (text.length > 0) {
        lines.push('## 🤖 Assistant', '', text, '', '---', '')
      }
    }
  }

  return lines.join('\n')
}

/**
 * Trigger download of Markdown file in browser / Electron environment.
 * @param filename - target filename.
 * @param text - markdown content string.
 */
export function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.md') ? filename : `${filename}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

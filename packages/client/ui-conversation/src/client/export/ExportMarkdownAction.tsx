/**
 * Session header utility action for exporting the conversation transcript to Markdown.
 */
import { useCallback } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconDownloadOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../locales.ts'
import { exportConversationToMarkdown, downloadMarkdown } from './markdown.ts'
import css from './ExportMarkdownAction.module.css'

/** Full props for the session-header export action. */
export type ExportMarkdownActionProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS>

/**
 * Render the session-header action button that exports the conversation to Markdown.
 * @param props - session standard props and locale translator.
 * @returns the export button or null if the session has no conversational content.
 */
export function ExportMarkdownAction({ sessionId, useSession, useSessions, t }: ExportMarkdownActionProps) {
  const snapshot = useSession(s => s)
  const sessionSummary = useSessions(s => s.byId[sessionId])
  const sessionTitle = sessionSummary?.displayTitle

  const onExport = useCallback(() => {
    if (!snapshot) return
    const md = exportConversationToMarkdown(snapshot, sessionTitle)
    const rawName = sessionTitle
      ? sessionTitle.toLowerCase().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '')
      : sessionId
    const filename = `${rawName || 'session'}.md`
    downloadMarkdown(filename, md)
  }, [snapshot, sessionTitle, sessionId])

  const hasNodes = snapshot.nodes.some(n => n.kind === 'user' || n.kind === 'assistant')
  if (!hasNodes) return null

  const label = t('session.export.markdown')

  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className={css.button}
        aria-label={label}
        onClick={onExport}
      >
        <IconDownloadOutline16 size={14} className={css.icon} />
        <span className={css.label}>{label}</span>
      </button>
    </Tooltip>
  )
}

/**
 * The preset list of one pi-ai provider profile (e.g. OpenRouter presets).
 *
 * Presets are custom `@preset/<slug>` model definitions served alongside
 * the provider's built-in catalog or configured models without replacing it.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { formatCapacity, parseCapacity } from './DeepSeekModelsEditor.tsx'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** One configured preset row, structurally open. */
export type PresetDraft = DeepSeekModelDraft

/** A row's text field, or the empty string when unset or not a string. */
function textOf(preset: PresetDraft, key: string): string {
  const value = preset[key]
  return typeof value === 'string' ? value : ''
}

/** A row's numeric field, or `undefined` when unset or not a number. */
function numberOf(preset: PresetDraft, key: string): number | undefined {
  const value = preset[key]
  return typeof value === 'number' ? value : undefined
}

/** Props of {@link PresetListEditor}. */
export interface PresetListEditorProps {
  /** The preset rows as currently drafted. */
  presets: readonly PresetDraft[]
  /** Replace the drafted preset rows. */
  onChange: (presets: PresetDraft[]) => void
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
}

/** Disclosure chevron; rotates to point down while its row is open. */
function IconChevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Removal glyph for one preset row. */
function IconTrash(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** The two token counts edited as K/M-suffixed text behind a row's disclosure. */
type CapacityField = 'contextWindow' | 'maxTokens'

const CAPACITY_HINT: Readonly<Record<CapacityField, string>> = {
  contextWindow: '256K',
  maxTokens: '32K',
}

function capacitySpelling(value: number | undefined): string {
  return value === undefined ? '' : formatCapacity(value)
}

/**
 * Render the preset list editor.
 * @param props - the drafted preset rows, change callback, copy, and disabled state.
 * @returns the preset-list editor element.
 */
export function PresetListEditor(props: PresetListEditorProps): ReactNode {
  const { presets, onChange, t, disabled } = props
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(new Map())

  const bufferKey = (index: number, field: CapacityField): string => `${String(index)}:${field}`

  const editCapacity = (index: number, field: CapacityField, text: string): void => {
    setEditing(current => new Map(current).set(bufferKey(index, field), text))
    patch(index, { [field]: parseCapacity(text) })
  }

  const capacityText = (preset: PresetDraft, index: number, field: CapacityField): string =>
    editing.get(bufferKey(index, field)) ?? capacitySpelling(numberOf(preset, field))

  const reindexOnRemove = (
    current: ReadonlyMap<string, string>,
    index: number,
  ): Map<string, string> => {
    const next = new Map<string, string>()
    for (const [key, value] of current) {
      const at = Number(key.slice(0, key.indexOf(':')))
      if (at === index) continue
      next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value)
    }
    return next
  }

  const toggleExpanded = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  const patch = (index: number, next: Record<string, string | number | boolean | undefined>): void => {
    onChange(presets.map((preset, at) => {
      if (at !== index) return preset
      const cleared = new Set(
        Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key),
      )
      return Object.fromEntries(
        Object.entries({ ...preset, ...next }).filter(([key]) => !cleared.has(key)),
      )
    }))
  }

  return (
    <section className={styles['modelCatalog']} aria-label={t('presets')}>
      <div className={styles['modelListHead']}>
        <div className={styles['modelCatalogHeading']}>
          <span className={styles['modelCatalogTitle']}>{t('presets')}</span>
        </div>
      </div>
      {presets.length === 0 ? <p className={styles['modelEmpty']}>{t('presetsEmpty')}</p> : null}
      {presets.map((preset, index) => (
        <div key={index} className={styles['modelEntry']}>
          <div className={styles['modelRow']}>
            <input
              className={styles['input']}
              type="text"
              value={textOf(preset, 'id')}
              placeholder={t('presetId')}
              aria-label={`${t('presetId')} ${index + 1}`}
              disabled={disabled}
              onChange={(event) => { patch(index, { id: event.target.value }) }}
            />
            <input
              className={styles['input']}
              type="text"
              value={textOf(preset, 'name')}
              placeholder={t('presetName')}
              aria-label={`${t('presetName')} ${index + 1}`}
              disabled={disabled}
              onChange={(event) => { patch(index, { name: event.target.value === '' ? undefined : event.target.value }) }}
            />
            <button
              type="button"
              className={styles['iconButton']}
              aria-label={`${t('modelAdvanced')} ${index + 1}`}
              aria-expanded={expanded.has(index)}
              title={t('modelAdvanced')}
              onClick={() => { toggleExpanded(index) }}
            >
              <IconChevron open={expanded.has(index)} />
            </button>
            <button
              type="button"
              className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
              aria-label={`${t('removePreset')} ${index + 1}`}
              title={t('removePreset')}
              disabled={disabled}
              onClick={() => {
                onChange(presets.filter((_preset, at) => at !== index))
                setExpanded((current) => {
                  const next = new Set<number>()
                  for (const at of current) {
                    if (at < index) next.add(at)
                    else if (at > index) next.add(at - 1)
                  }
                  return next
                })
                setEditing(current => reindexOnRemove(current, index))
              }}
            >
              <IconTrash />
            </button>
          </div>
          {expanded.has(index)
            ? (
              <div className={styles['modelAdvanced']}>
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelContextWindow')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(preset, index, 'contextWindow')}
                    placeholder={CAPACITY_HINT.contextWindow}
                    aria-label={`${t('modelContextWindow')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'contextWindow', event.target.value) }}
                  />
                </label>
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelMaxTokens')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(preset, index, 'maxTokens')}
                    placeholder={CAPACITY_HINT.maxTokens}
                    aria-label={`${t('modelMaxTokens')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'maxTokens', event.target.value) }}
                  />
                </label>
                <label className={styles['modelField']}>
                  <input
                    type="checkbox"
                    checked={preset['reasoning'] === true}
                    aria-label={`${t('presetReasoning')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => {
                      patch(index, { reasoning: event.target.checked ? true : undefined })
                    }}
                  />
                  <span className={styles['modelFieldLabel']}>{t('presetReasoning')}</span>
                </label>
              </div>
            )
            : null}
        </div>
      ))}
      <button
        type="button"
        className={styles['addModelButton']}
        disabled={disabled}
        onClick={() => { onChange([...presets, { id: '' }]) }}
      >
        {t('addPreset')}
      </button>
    </section>
  )
}

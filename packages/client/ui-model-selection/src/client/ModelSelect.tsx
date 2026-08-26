/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; exact-model reasoning metadata and the selected effort come
 * from the Host rather than a client-owned vocabulary. A rejected selection
 * announces through the shared transient Toast anchored to the composer
 * card; the in-menu strip with Retry remains the catalog-load surface.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { formatModelPricing, formatTokenCapacity } from './format.ts'
import { loadPinnedModelKeys, togglePinnedModelKey } from './pins.ts'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [search, setSearch] = useState('')
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])

  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(() => loadPinnedModelKeys())

  const query = search.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    const baseGroups = state.groups
      .map((group) => {
        if (!query) return group
        const matchesGroup = group.name.toLowerCase().includes(query)
        const models = group.models.filter(model =>
          matchesGroup
          || model.name.toLowerCase().includes(query)
          || model.id.toLowerCase().includes(query)
          || (model.description !== undefined && model.description.toLowerCase().includes(query)),
        )
        return { ...group, models }
      })
      .filter(group => group.models.length > 0)

    if (pinnedKeys.size === 0) return baseGroups

    const pinnedModels: Array<{ group: (typeof state.groups)[number]; model: (typeof state.groups)[number]['models'][number] }> = []
    for (const group of state.groups) {
      for (const model of group.models) {
        if (pinnedKeys.has(`${group.id}/${model.id}`)) {
          if (!query
            || model.name.toLowerCase().includes(query)
            || model.id.toLowerCase().includes(query)
            || (model.description !== undefined && model.description.toLowerCase().includes(query))) {
            pinnedModels.push({ group, model })
          }
        }
      }
    }

    if (pinnedModels.length === 0) return baseGroups

    const pinnedGroup = {
      id: '__pinned__',
      name: '⭐ Pinned',
      models: pinnedModels.map(p => ({
        ...p.model,
        description: p.model.description ? `${p.group.name} · ${p.model.description}` : p.group.name,
      })),
    }

    return [pinnedGroup, ...baseGroups]
  }, [state.groups, query, pinnedKeys])

  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // Mount-time load resolves the trigger label; every open refreshes.
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useEffect(() => {
    if (open && pane === 'model') {
      searchInputRef.current?.focus()
    }
  }, [open, pane])

  if (!available) return null

  const show = (): void => {
    setSearch('')
    setPane('root')
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setSearch('')
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const firstItem = itemRefs.current.find(item => item !== null)
      firstItem?.focus()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const firstGroup = filteredGroups[0]
      const firstModel = firstGroup?.models[0]
      if (firstGroup && firstModel) {
        choose({ provider: firstGroup.id, model: firstModel.id })
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (search.length > 0) {
        setSearch('')
      } else {
        setPane('root')
      }
    }
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root') {
        setSearch('')
        setPane('root')
      } else {
        close(true)
      }
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (document.activeElement === searchInputRef.current && event.key === 'ArrowDown') {
        event.preventDefault()
        const firstItem = itemRefs.current.find(item => item !== null)
        firstItem?.focus()
        return
      }
      if (document.activeElement !== searchInputRef.current) {
        event.preventDefault()
        moveFocus(event.key === 'ArrowDown' ? 1 : -1)
      }
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const choose = (selection: ModelSelection): void => {
    let target = selection
    if (selection.provider === '__pinned__') {
      const match = choices.find(c => c.selection.model === selection.model)
      if (match !== undefined) {
        target = match.selection
      }
    }
    if (state.current?.provider === target.provider && state.current.model === target.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(target).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('model') }}>
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
              {reasoning !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              <div className={css.searchWrapper}>
                <input
                  ref={searchInputRef}
                  type="text"
                  className={css.searchInput}
                  placeholder={t('search.placeholder')}
                  value={search}
                  onChange={(e) => { setSearch(e.target.value) }}
                  onKeyDown={onSearchKeyDown}
                />
              </div>
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div className={clsx(css.groups, 'scrollable')}>
                {filteredGroups.map((group) => {
                  const headingId = `${id}-${group.id}`
                  return (
                    <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                      <div className={css.groupTitle} id={headingId}>{group.name}</div>
                      {group.models.map((model) => {
                        const realProvider = group.id === '__pinned__'
                          ? choices.find(c => c.selection.model === model.id)?.selection.provider ?? group.id
                          : group.id
                        const selected = state.current?.provider === realProvider && state.current.model === model.id
                        const pinKey = `${realProvider}/${model.id}`
                        const isPinned = pinnedKeys.has(pinKey)
                        return (
                          <button
                            ref={itemRef()}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            className={clsx(css.option, selected && css.selected)}
                            key={group.id === '__pinned__' ? `pinned:${model.id}` : model.id}
                            title={model.name}
                            disabled={busy}
                            onClick={() => { choose({ provider: group.id, model: model.id }) }}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.modelHeader}>
                                <span className={css.modelName}>{model.name}</span>
                                <span className={css.badges}>
                                  {model.contextWindow !== undefined && (
                                    <span className={css.contextBadge}>
                                      {formatTokenCapacity(model.contextWindow)}
                                    </span>
                                  )}
                                  {model.pricing !== undefined && (
                                    <span className={css.pricingBadge}>
                                      {formatModelPricing(model.pricing)}
                                    </span>
                                  )}
                                </span>
                              </span>
                              {model.description !== undefined && (
                                <span className={css.description}>{model.description}</span>
                              )}
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              className={clsx(css.starButton, isPinned && css.starButtonPinned)}
                              title={isPinned ? 'Unstar model' : 'Star model'}
                              aria-label={isPinned ? 'Unstar model' : 'Star model'}
                              onClick={(e) => {
                                e.stopPropagation()
                                const next = togglePinnedModelKey(pinKey)
                                setPinnedKeys(new Set(next))
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  const next = togglePinnedModelKey(pinKey)
                                  setPinnedKeys(new Set(next))
                                }
                              }}
                            >
                              <svg viewBox="0 0 16 16" width="13" height="13" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3">
                                <polygon points="8,1.5 10,5.8 14.8,6.4 11.2,9.8 12.2,14.5 8,12 3.8,14.5 4.8,9.8 1.2,6.4 6,5.8" />
                              </svg>
                            </span>
                            <span className={css.check}>
                              {selected ? <IconCheckOutline16 /> : null}
                            </span>
                          </button>
                        )
                      })}
                    </section>
                  )
                })}
              </div>
              {state.status === 'ready' && choices.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
              {state.status === 'ready' && choices.length > 0 && filteredGroups.length === 0 && query.length > 0 && (
                <div className={css.empty}>{t('empty.search')}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                      {level.description !== undefined && (
                        <span className={css.description}>{level.description}</span>
                      )}
                    </span>
                    <span className={css.check}>
                      {effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                ))}
            </>
          )}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}

import type { ModelEntry, ProviderCatalogStatus } from '@openharness/protocol'
import { ChevronsUpDown } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { RefreshOutcome } from '../../hooks/use-models'
import { formatContextWindow } from '../../lib/format'
import { groupModelsByProvider } from '../../lib/models'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

/**
 * The model picker: a searchable list, grouped by provider, plus a free-text way out.
 *
 * Not a native `<select>` — its popup cannot be styled or followed through the theme, which
 * is what #87 was about. This is the app's own listbox with the shadcn popover tokens
 * (`bg-popover`, dark-mode aware), built as a combobox: the search field keeps focus and
 * drives `aria-activedescendant`, arrows move, Enter picks, Escape closes and hands focus
 * back to the trigger. Every model row shows the catalog's display name, the `provider/model`
 * id and — when the catalog knows it — the context window. "Other model ID…" swaps the list
 * for a free-text id field: the router accepts models this catalog does not list.
 *
 * The picker only ever offers what the server sent (providers the caller has a key for, C5);
 * it does not know provider names of its own.
 *
 * Since epic #116 it is the app's one model control, in two sizes: `full` in Settings
 * (Default model), and `compact` as the composer's inline selector — "gpt-4.1-mini ▾" in the
 * input area, with its panel opening upward. Refresh lives in the panel's foot so every
 * surface that offers the catalog can rebuild it where the list is.
 */

/** One navigable row: a catalog model, or the escape hatch at the end of the list. */
type PickerOption =
  { readonly kind: 'model'; readonly entry: ModelEntry } | { readonly kind: 'other' }

/** What the picker takes. */
export interface ModelPickerProps {
  /** The catalog's models, sorted by provider then name. */
  models: readonly ModelEntry[]
  /** One catalog status per provider, for the fallback note. */
  providers: readonly ProviderCatalogStatus[]
  /** The selected model id, or `null` before anything was chosen. */
  value: string | null
  /** A model was chosen — from the list, or typed as a free-text id. */
  onChange: (modelId: string) => void
  /** `full` is the form-width trigger; `compact` is the composer's inline control. */
  variant?: 'full' | 'compact'
  /** Where the panel opens. `below` by default; `above` for a control at the screen's foot. */
  placement?: 'below' | 'above'
  /** Whether a refresh is in flight; only meaningful with {@link onRefresh}. */
  refreshing?: boolean
  /**
   * When given, the panel carries a Refresh control: a deliberate bypass of the server's
   * per-user catalog cache (a refresh inside its window answers 429, shown as a note, not an
   * error — the list on screen is still the one the server last sent).
   */
  onRefresh?: (() => Promise<RefreshOutcome>) | undefined
}

export function ModelPicker({
  models,
  providers,
  value,
  onChange,
  variant = 'full',
  placement = 'below',
  refreshing = false,
  onRefresh,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  // The list, or the free-text form "Other model ID…" opens.
  const [mode, setMode] = useState<'list' | 'custom'>('list')
  const [customId, setCustomId] = useState('')
  // The refresh's outcome, shown in the panel: a rate-limited refresh is a "come back later",
  // not an error state — the list stays exactly as it was.
  const [refreshNote, setRefreshNote] = useState<string | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const customRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const optionIdPrefix = useId()

  const selected = models.find((entry) => entry.id === value) ?? null
  const groups = useMemo(() => groupModelsByProvider(models, providers), [models, providers])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') {
      return groups
    }
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter(
          (entry) =>
            entry.id.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.models.length > 0)
  }, [groups, query])

  // The flat navigation order the arrows walk: every filtered model, then "Other model ID…".
  const options = useMemo<readonly PickerOption[]>(
    () => [
      ...filtered.flatMap((group) =>
        group.models.map((entry): PickerOption => ({ kind: 'model', entry })),
      ),
      { kind: 'other' },
    ],
    [filtered],
  )
  const active = Math.min(activeIndex, options.length - 1)

  const close = (focusTrigger = true): void => {
    setOpen(false)
    if (focusTrigger) {
      triggerRef.current?.focus()
    }
  }

  const openPicker = (): void => {
    const selectedIndex = models.findIndex((entry) => entry.id === value)
    setQuery('')
    setMode('list')
    setRefreshNote(null)
    setActiveIndex(selectedIndex === -1 ? 0 : selectedIndex)
    setOpen(true)
  }

  const runRefresh = async (): Promise<void> => {
    if (onRefresh === undefined) {
      return
    }
    setRefreshNote(null)
    const outcome = await onRefresh()
    if (!outcome.ok) {
      setRefreshNote(
        outcome.kind === 'rate_limit'
          ? outcome.message
          : `The catalog could not be refreshed. ${outcome.message}`,
      )
    }
  }

  const choose = (option: PickerOption): void => {
    if (option.kind === 'model') {
      onChange(option.entry.id)
      close()
      return
    }
    // "Other model ID…": swap the panel for the free-text form, keeping a typed id when the
    // query already looks like one.
    setCustomId(query.includes('/') ? query.trim() : '')
    setMode('custom')
  }

  const submitCustom = (): void => {
    const modelId = customId.trim()
    if (modelId === '') {
      return
    }
    onChange(modelId)
    close()
  }

  // Focus follows the panel's mode; outside pointer events close it, as for any overlay.
  useEffect(() => {
    if (!open) {
      return
    }
    if (mode === 'custom') {
      customRef.current?.focus()
    } else {
      searchRef.current?.focus()
    }
  }, [open, mode])

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) {
        close(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex(Math.min(active + 1, options.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex(Math.max(active - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(options.length - 1)
        break
      case 'Enter': {
        event.preventDefault()
        const option = options[active]
        if (option !== undefined) {
          choose(option)
        }
        break
      }
      case 'Escape':
        event.preventDefault()
        close()
        break
      default:
        break
    }
  }

  const toggle = (): void => {
    if (open) {
      close(false)
    } else {
      openPicker()
    }
  }
  const compactLabel = selected?.name ?? value ?? 'Choose a model'

  return (
    <div ref={wrapperRef} className="relative">
      {variant === 'compact' ? (
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Model: ${compactLabel}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={toggle}
          className="h-8 max-w-64 gap-1 px-2 font-normal text-muted-foreground"
        >
          <span className={cn('min-w-0 truncate', value === null && 'italic')}>{compactLabel}</span>
          <ChevronsUpDown aria-hidden="true" className="shrink-0" />
        </Button>
      ) : (
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={toggle}
          className="h-auto min-h-9 w-full justify-between py-2 text-left font-normal"
        >
          <span className="sr-only">Model</span>
          <span className="flex min-w-0 flex-col items-start gap-0.5">
            {selected === null ? (
              <span className={cn('truncate', value === null && 'text-muted-foreground')}>
                {value ?? 'Choose a model'}
              </span>
            ) : (
              <>
                <span className="truncate">{selected.name}</span>
                <span className="truncate text-xs text-muted-foreground">{selected.id}</span>
              </>
            )}
          </span>
          <ChevronsUpDown aria-hidden="true" className="shrink-0 text-muted-foreground" />
        </Button>
      )}

      {open ? (
        <div
          className={cn(
            'absolute z-30 rounded-md border bg-popover p-2 text-popover-foreground shadow-md',
            variant === 'compact' ? 'right-0 w-80 max-w-[90vw]' : 'inset-x-0',
            placement === 'above' ? 'bottom-full mb-1' : 'mt-1',
          )}
        >
          {mode === 'list' ? (
            <>
              <Input
                ref={searchRef}
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={
                  options[active] === undefined ? undefined : `${optionIdPrefix}-${active}`
                }
                aria-autocomplete="list"
                autoComplete="off"
                placeholder="Search models…"
                aria-label="Search models"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                onKeyDown={onSearchKeyDown}
              />
              <div
                id={listId}
                role="listbox"
                aria-label="Models"
                className="mt-2 max-h-72 overflow-y-auto"
              >
                {filtered.length === 0 && query.trim() !== '' ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    No models match “{query.trim()}”.
                  </p>
                ) : null}
                {filtered.map((group) => (
                  <div key={group.provider} role="group" aria-label={group.provider}>
                    <p
                      aria-hidden="true"
                      className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
                    >
                      {group.provider}
                    </p>
                    {group.status?.status === 'fallback' ? (
                      <p
                        className="px-2 pb-1 text-xs text-muted-foreground"
                        title={group.status.message ?? undefined}
                      >
                        from the built-in list; the provider couldn't be reached
                      </p>
                    ) : null}
                    {group.models.map((entry) => {
                      const index = options.findIndex(
                        (option) => option.kind === 'model' && option.entry.id === entry.id,
                      )
                      return (
                        <div
                          key={entry.id}
                          id={`${optionIdPrefix}-${index}`}
                          role="option"
                          aria-selected={entry.id === value}
                          data-active={index === active ? 'true' : undefined}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => choose({ kind: 'model', entry })}
                          className={cn(
                            'flex cursor-pointer flex-col gap-0.5 rounded-sm px-2 py-1.5',
                            index === active && 'bg-accent text-accent-foreground',
                          )}
                        >
                          <span className="truncate text-sm">{entry.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {entry.id}
                            {entry.context_window === null
                              ? null
                              : ` · ${formatContextWindow(entry.context_window)} context`}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))}
                <div
                  id={`${optionIdPrefix}-${options.length - 1}`}
                  role="option"
                  aria-selected={false}
                  data-active={active === options.length - 1 ? 'true' : undefined}
                  onMouseEnter={() => setActiveIndex(options.length - 1)}
                  onClick={() => choose({ kind: 'other' })}
                  className={cn(
                    'mt-1 flex cursor-pointer flex-col gap-0.5 rounded-sm border-t px-2 pt-2 pb-1.5',
                    active === options.length - 1 && 'bg-accent text-accent-foreground',
                  )}
                >
                  <span className="truncate text-sm">Other model ID…</span>
                  <span className="truncate text-xs text-muted-foreground">
                    type any provider/model the router knows
                  </span>
                </div>
              </div>
              {onRefresh === undefined ? null : (
                <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={refreshing}
                    onClick={() => void runRefresh()}
                  >
                    {refreshing ? 'Refreshing…' : 'Refresh models'}
                  </Button>
                  {refreshNote === null ? null : (
                    <p role="status" className="min-w-0 text-xs text-muted-foreground">
                      {refreshNote}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            /* A div, not a form: the picker lives inside the New chat screen's form, and a
               form cannot contain one. Enter in the field submits (below) instead. */
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${optionIdPrefix}-custom`}>Model ID</Label>
              <Input
                ref={customRef}
                id={`${optionIdPrefix}-custom`}
                autoComplete="off"
                placeholder="provider/model"
                value={customId}
                onChange={(event) => setCustomId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submitCustom()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    close()
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                A <code className="font-mono">provider/model</code> router string; the catalog may
                not know it yet.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={customId.trim() === ''}
                  onClick={submitCustom}
                >
                  Use model
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setMode('list')}>
                  Back to the list
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

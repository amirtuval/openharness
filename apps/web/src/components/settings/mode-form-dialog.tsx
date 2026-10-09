import { MODE_DEFAULT_MODEL, REASONING_EFFORTS } from '@openharness/protocol'
import type { CreateModeRequest, Mode } from '@openharness/protocol'
import { useEffect, useState } from 'react'

import type { ModesView } from '../../hooks/use-modes'
import type { ModelsView } from '../../hooks/use-models'
import { ModelPicker } from '../models/model-picker'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

/** The effort a mode asks for, as the form's select spells it. */
const EFFORT_LABEL: Readonly<Record<string, string>> = {
  default: 'Provider default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

/** The form's values, before they become a request body. */
interface FormState {
  readonly name: string
  readonly useDefaultModel: boolean
  readonly model: string | null
  readonly reasoningEffort: '' | 'low' | 'medium' | 'high'
  readonly systemPromptAddition: string
}

const EMPTY: FormState = {
  name: '',
  useDefaultModel: false,
  model: null,
  reasoningEffort: '',
  systemPromptAddition: '',
}

/** The form's values from a mode being edited, or the empty form for a new one. */
function formOf(mode: Mode | null): FormState {
  if (mode === null) {
    return EMPTY
  }
  return {
    name: mode.name,
    useDefaultModel: mode.model === MODE_DEFAULT_MODEL,
    model: mode.model === MODE_DEFAULT_MODEL ? null : mode.model,
    reasoningEffort: mode.reasoning_effort ?? '',
    systemPromptAddition: mode.system_prompt_addition ?? '',
  }
}

/**
 * Create or edit one mode (#245, M6): its name, the model it runs (or "my default model"), the
 * reasoning effort it asks for, and the addition appended after the session's system prompt.
 *
 * One dialog for both writes, the way the provider key form is one form for add and replace:
 * `mode` is the mode being edited, or `null` for a new one. The server is the one that decides
 * whether a name is taken (409 `conflict_error`, shown inline) — the form only refuses an empty
 * name, which is a 400 waiting to happen.
 */
export function ModeFormDialog({
  open,
  mode,
  modes,
  catalog,
  onSaved,
  onClose,
}: {
  open: boolean
  /** The mode being edited, or `null` to create one. */
  mode: Mode | null
  /** Where the write goes: the shell's modes view. */
  modes: ModesView
  /** The shell's catalog, for the picker. */
  catalog: ModelsView
  /** Called after a successful write, with what was saved. */
  onSaved: (mode: Mode) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // Every open starts from the mode being edited (or the empty form): a dialog left mounted
  // between uses must not carry the last write's values into the next one.
  useEffect(() => {
    if (open) {
      setForm(formOf(mode))
      setFailure(null)
      setSaving(false)
    }
  }, [open, mode])

  const patch = (change: Partial<FormState>): void => {
    setForm((current) => ({ ...current, ...change }))
  }

  const body = (): CreateModeRequest => ({
    name: form.name.trim(),
    model: form.useDefaultModel ? MODE_DEFAULT_MODEL : (form.model ?? ''),
    reasoning_effort: form.reasoningEffort === '' ? null : form.reasoningEffort,
    system_prompt_addition:
      form.systemPromptAddition.trim() === '' ? null : form.systemPromptAddition,
  })

  const canSave =
    form.name.trim() !== '' && (form.useDefaultModel || (form.model ?? '') !== '') && !saving

  const save = async (): Promise<void> => {
    if (!canSave) {
      return
    }
    setSaving(true)
    setFailure(null)
    const request = body()
    const result =
      mode === null
        ? await modes.create(request)
        : await modes.update(mode.id, {
            name: request.name,
            // An edit replaces every field the form holds, so a field the reader cleared is
            // sent as `null` rather than omitted — the two mean different things to an update
            // (`null` clears, omitted keeps).
            model: request.model,
            reasoning_effort: request.reasoning_effort,
            system_prompt_addition: request.system_prompt_addition,
          })
    setSaving(false)
    if (!result.ok) {
      setFailure(result.message)
      return
    }
    onSaved(result.mode)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === null ? 'Create mode' : `Edit the ${mode.name} mode`}</DialogTitle>
          <DialogDescription>
            A mode is a name for a model, an effort and a prompt addition. A chat that follows it
            uses the mode as it is then — editing one changes every chat that follows it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-block">
          <div className="space-y-1">
            <Label htmlFor="mode-name">Name</Label>
            <Input
              id="mode-name"
              autoComplete="off"
              placeholder="smart"
              value={form.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>Model</Label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={form.useDefaultModel}
                onChange={(event) => patch({ useDefaultModel: event.target.checked })}
              />
              My default model — follows it if you change it
            </label>
            {form.useDefaultModel ? null : (
              <ModelPicker
                models={catalog.models}
                providers={catalog.providers}
                value={form.model}
                onChange={(modelId) => patch({ model: modelId })}
                refreshing={catalog.refreshing}
                onRefresh={catalog.refresh}
              />
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="mode-effort">Reasoning effort</Label>
            <select
              id="mode-effort"
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              value={form.reasoningEffort}
              onChange={(event) =>
                patch({ reasoningEffort: event.target.value as FormState['reasoningEffort'] })
              }
            >
              <option value="">{EFFORT_LABEL.default}</option>
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {EFFORT_LABEL[effort]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="mode-addition">System prompt addition</Label>
            <Textarea
              id="mode-addition"
              rows={3}
              placeholder="Think step by step before answering."
              value={form.systemPromptAddition}
              onChange={(event) => patch({ systemPromptAddition: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Appended after the chat's own system prompt, never in place of it.
            </p>
          </div>

          {failure === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canSave}>
            {saving ? 'Saving…' : mode === null ? 'Create mode' : 'Save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

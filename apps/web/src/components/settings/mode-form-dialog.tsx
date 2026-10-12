import { MODE_DEFAULT_MODEL, REASONING_EFFORTS } from '@openharness/protocol'
import type {
  CreateModeRequest,
  Mode,
  ModeToolOverride,
  ToolSettingEntry,
} from '@openharness/protocol'
import { useEffect, useState } from 'react'

import type { ModesView } from '../../hooks/use-modes'
import type { ModelsView } from '../../hooks/use-models'
import { modeToolChoice, withModeToolChoice, type ModeToolChoice } from '../../lib/tools'
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
  /**
   * The mode's built-in tool override (#307), or `null` for "follow my settings".
   *
   * The wire is a per-tool boolean patch; the form's choice is tri-state ({@link ModeToolChoice}),
   * which `withModeToolChoice` folds back into the patch. An empty patch becomes `null`, the one
   * value that reads as "follow my settings" on both sides.
   */
  readonly tools: ModeToolOverride | null
}

const EMPTY: FormState = {
  name: '',
  useDefaultModel: false,
  model: null,
  reasoningEffort: '',
  systemPromptAddition: '',
  tools: null,
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
    tools: mode.tools,
  }
}

/** The three choices the tools section offers one built-in tool, and what each means. */
const TOOL_CHOICES: readonly { readonly value: ModeToolChoice; readonly label: string }[] = [
  { value: 'follow', label: 'Follow my settings' },
  { value: 'on', label: 'Always on' },
  { value: 'off', label: 'Always off' },
]

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
  tools,
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
  /**
   * The deployment's tools, for the override section (#307): the same effective entries the
   * Tools card reads, so a mode's choices are offered for the tools that really exist here.
   *
   * The remote MCP entries are ignored here (#312): a mode overrides a **server**, by id, and
   * a per-MCP-tool switch would be a choice the wire has nowhere to put — that half of the
   * editor is #313. {@link withModeToolChoice} still carries a mode's `mcp_servers` through a
   * save, so opening this form never drops what a mode already says about servers.
   */
  tools: readonly ToolSettingEntry[]
  /** Called after a successful write, with what was saved. */
  onSaved: (mode: Mode) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // Only this build's own tools get a per-tool choice: a remote MCP tool's presence is its
  // server's, which a mode overrides by id on a screen this form does not offer (#312, #313).
  const builtinTools = tools.filter((entry) => entry.source !== 'mcp')

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
    tools: form.tools,
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
            tools: request.tools ?? null,
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

          {builtinTools.length === 0 ? null : (
            <div className="space-y-2">
              <Label>Tools</Label>
              <p className="text-xs text-muted-foreground">
                Which of your tools a chat on this mode has, or leave each one following your own
                settings. A mode turns a tool on or off — it never changes what a call may do.
              </p>
              <ul className="space-y-1.5">
                {builtinTools.map((entry) => (
                  <li key={entry.name} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.name}</span>
                    <select
                      data-slot="mode-tool-choice"
                      data-tool={entry.name}
                      aria-label={`${entry.name} in this mode`}
                      className="h-8 rounded-md border bg-transparent px-2 text-xs"
                      value={modeToolChoice(form.tools, entry.name)}
                      onChange={(event) =>
                        patch({
                          tools: withModeToolChoice(
                            form.tools,
                            entry.name,
                            event.target.value as ModeToolChoice,
                          ),
                        })
                      }
                    >
                      {TOOL_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          )}

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

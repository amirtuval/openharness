import type { Agent } from '@openharness/protocol'
import { useId, useState } from 'react'

import { MODEL_SUGGESTIONS } from '../../lib/models'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

/** What the form collects: the three fields an agent has in v1. */
export interface AgentFormValues {
  name: string
  model: string
  system: string
}

/**
 * Create or edit an agent.
 *
 * The model is **free text with suggestions**, not a picker: `model.id` is a
 * `provider/model` router string and v1 has no `/v1/models` endpoint (see the issue's scope
 * change), so a `<datalist>` offers the usual ones while anything else is still allowed.
 *
 * The caller remounts the form (via `key`) to switch between agents or to clear it after a
 * save, so the fields are plain initial state here.
 */
export function AgentForm({
  agent = null,
  submitting,
  submitLabel,
  onSubmit,
  onReset,
}: {
  /** The agent being edited, or `null` to create one. */
  agent?: Agent | null
  submitting: boolean
  /** "Create agent" or "Save changes". */
  submitLabel: string
  onSubmit: (values: AgentFormValues) => void | Promise<void>
  /** Clears the form back to a new agent; omitted while editing. */
  onReset?: (() => void) | undefined
}) {
  const [name, setName] = useState(agent?.name ?? '')
  const [model, setModel] = useState(agent?.model.id ?? '')
  const [system, setSystem] = useState(agent?.system ?? '')

  const fieldId = useId()
  const suggestionsId = `${fieldId}-model-suggestions`
  const valid = name.trim() !== '' && model.trim() !== ''

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && !submitting) {
          void onSubmit({ name, model, system })
        }
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${fieldId}-name`}>Name</Label>
        <Input
          id={`${fieldId}-name`}
          value={name}
          required
          autoComplete="off"
          placeholder="Summarizer"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${fieldId}-model`}>Model</Label>
        <Input
          id={`${fieldId}-model`}
          value={model}
          required
          autoComplete="off"
          list={suggestionsId}
          placeholder="anthropic/claude-sonnet-5"
          onChange={(event) => setModel(event.target.value)}
        />
        <datalist id={suggestionsId}>
          {MODEL_SUGGESTIONS.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
        <p className="text-xs text-muted-foreground">
          A <code className="font-mono">provider/model</code> router string. The list suggests a
          few; any value is allowed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${fieldId}-system`}>System prompt</Label>
        <Textarea
          id={`${fieldId}-system`}
          value={system}
          rows={5}
          placeholder="You are a concise technical assistant."
          onChange={(event) => setSystem(event.target.value)}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!valid || submitting}>
          {submitLabel}
        </Button>
        {onReset === undefined ? null : (
          <Button type="button" variant="ghost" onClick={onReset} disabled={submitting}>
            Reset
          </Button>
        )}
      </div>
    </form>
  )
}

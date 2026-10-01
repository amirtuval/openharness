import type { Agent } from '@openharness/protocol'
import { useId, useState } from 'react'

import { useProviderCredentials } from '../../hooks/use-provider-credentials'
import { MODEL_SUGGESTIONS } from '../../lib/models'
import { providerOfModel } from '../../lib/providers'
import { settingsHash } from '../../lib/router'
import { useClient } from '../client-provider'
import { Badge } from '../ui/badge'
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
 * The suggestions **mark** the models this account cannot run yet: a model's provider is the
 * first half of its id, and a provider with no saved credential (epic #65, A5) fails the
 * moment a session tries to use it — a `missing_provider_credential` error at the first turn.
 * The mark is a badge on the suggestion and a link to Settings, so the fix is one click from
 * where the reader noticed the problem.
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
  const client = useClient()
  const { credentials, loading: loadingProviders } = useProviderCredentials(client)

  const [name, setName] = useState(agent?.name ?? '')
  const [model, setModel] = useState(agent?.model.id ?? '')
  const [system, setSystem] = useState(agent?.system ?? '')

  const fieldId = useId()
  const suggestionsId = `${fieldId}-model-suggestions`
  const valid = name.trim() !== '' && model.trim() !== ''

  // `null` while the list is on its way: nothing is marked until there is something to mark
  // against, rather than marking everything and taking it back.
  const savedProviders =
    loadingProviders && credentials.length === 0
      ? null
      : new Set(credentials.map((credential) => credential.provider))
  const missingFor = (modelId: string): boolean => {
    const provider = providerOfModel(modelId)
    return savedProviders !== null && provider !== '' && !savedProviders.has(provider)
  }
  const typedMissing = model.trim() !== '' && missingFor(model)

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
        <ul aria-label="Model suggestions" className="flex flex-wrap gap-1 pt-1">
          {MODEL_SUGGESTIONS.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                onClick={() => setModel(suggestion)}
                className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground"
              >
                {suggestion}
                {missingFor(suggestion) ? (
                  <Badge variant="outline" className="text-[0.65rem]">
                    no key
                  </Badge>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        {typedMissing ? (
          <p className="text-xs text-muted-foreground">
            No {providerOfModel(model)} key saved —{' '}
            <a className="underline underline-offset-2" href={settingsHash()}>
              add one in Settings → Model providers
            </a>
            .
          </p>
        ) : null}
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

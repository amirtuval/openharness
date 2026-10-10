import { summaryModelFallback } from '@openharness/client'
import {
  COMPACTION_THRESHOLD_MAX,
  COMPACTION_THRESHOLD_MIN,
  SUMMARY_MAX_PASSES_MAX,
  SUMMARY_MAX_PASSES_MIN,
  SUMMARY_MODEL_SAME_AS_CHAT,
} from '@openharness/protocol'
import { useState } from 'react'

import type { ModelsView } from '../../hooks/use-models'
import { usePreferences } from '../../hooks/use-preferences'
import { useClient } from '../client-provider'
import { ErrorBanner } from '../chat/error-banner'
import { ModelPicker } from '../models/model-picker'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

/**
 * Settings → Context (epic #277, C3; issue #282).
 *
 * The three controls the compaction epic puts in a reader's hands, stored on the server
 * (`PUT /v1/me/preferences`) so the web app and `oh` agree on them:
 *
 * - **the trigger share** (K2) — how full the chat model's window gets before older history is
 *   summarized, 30% to 95%. `null` follows the server's own (`OPENHARNESS_COMPACTION_THRESHOLD`),
 *   which the response reports in `defaults` so the card can name it; that is also why there is
 *   a "Use the server default" action rather than a value the reader has to remember;
 * - **the summary model** (K3) — the same model the chat runs ("Same as the chat", the
 *   default) or a specific one, offered by the same catalog picker as everywhere else;
 * - **the pass limit** (K5) — how many passes the summary model may take before the chat model
 *   takes over, 1 to 10.
 *
 * A summary model much smaller than the one the reader's chats run cannot fold the chat's
 * budget within that limit, and the engine hands the work back to the chat model. The card
 * says so up front, with the numbers the engine's own arithmetic produces
 * (`summaryModelFallback` in `@openharness/client`) rather than a rule of thumb.
 *
 * Each control saves on its own, through the hook's one `PUT`, whose merge is what keeps them
 * from clearing one another (epic #201, X3). The catalog comes from the shell (`AppFrame`),
 * which loaded it once for the whole app (#91); this card never fetches its own.
 */
export function ContextCard({ catalog }: { catalog: ModelsView }) {
  const client = useClient()
  const { preferences, loading, error, saving, save, dismissError } = usePreferences(client)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // A control that is being dragged, before it is committed: `null` means "show the stored
  // value". The pass limit's draft is the raw text, so a half-typed number is not a save.
  const [thresholdDraft, setThresholdDraft] = useState<number | null>(null)
  const [passesDraft, setPassesDraft] = useState<string | null>(null)

  /** One write, with the shared busy guard and the feedback both controls use. */
  const write = async (patch: Parameters<typeof save>[0], saved: string): Promise<void> => {
    setNotice(null)
    setFailure(null)
    const result = await save(patch)
    if (result.ok) {
      setNotice(saved)
    } else {
      // Nothing changed on the server, so the controls keep showing the stored value.
      setFailure(result.message)
    }
  }

  const storedThreshold = preferences?.compaction_threshold ?? null
  const serverThreshold = preferences?.defaults.compaction_threshold ?? null
  const effectiveThreshold = storedThreshold ?? serverThreshold ?? COMPACTION_THRESHOLD_MIN
  const threshold = thresholdDraft ?? effectiveThreshold
  const effectivePasses =
    preferences?.summary_max_passes ??
    preferences?.defaults.summary_max_passes ??
    SUMMARY_MAX_PASSES_MIN
  const passes = passesDraft ?? String(effectivePasses)
  const summaryModel = preferences?.summary_model ?? SUMMARY_MODEL_SAME_AS_CHAT

  // The warning the pass math raises, when the chosen summary model would need more passes than
  // the limit allows (K5): the chat model's entry is the reader's default, and both are looked
  // up in the catalog because the arithmetic needs their windows.
  const defaultModel = catalog.models.find((entry) => entry.id === preferences?.default_model)
  const chosenSummary = catalog.models.find((entry) => entry.id === summaryModel)
  const fallback =
    defaultModel === undefined || chosenSummary === undefined
      ? null
      : summaryModelFallback({
          chat: defaultModel,
          summary: chosenSummary,
          maxPasses: effectivePasses,
        })

  const commitThreshold = (value: number, stored: number | null): void => {
    if (value === stored || saving) {
      setThresholdDraft(null)
      return
    }
    setThresholdDraft(null)
    void write({ compaction_threshold: value }, `Summarize at ${percent(value)}.`)
  }

  const commitPasses = (raw: string): void => {
    const value = Number(raw)
    setPassesDraft(null)
    if (
      !Number.isInteger(value) ||
      value < SUMMARY_MAX_PASSES_MIN ||
      value > SUMMARY_MAX_PASSES_MAX
    ) {
      return
    }
    if (value === (preferences?.summary_max_passes ?? null) || saving) {
      return
    }
    void write({ summary_max_passes: value }, `Summary pass limit set to ${value}.`)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Context</CardTitle>
        <CardDescription>
          Long chats are summarized when they fill the model's context, so the conversation can keep
          going. These control when that happens and which model writes the summary.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error === null ? null : (
          <ErrorBanner
            title="Could not load your context settings"
            message={error}
            onDismiss={dismissError}
          />
        )}
        {failure === null ? null : (
          <ErrorBanner
            title="Could not save the context settings"
            message={failure}
            onDismiss={() => setFailure(null)}
          />
        )}
        {notice === null ? null : (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}

        {loading || preferences === null ? (
          <p className="text-sm text-muted-foreground">Loading your context settings…</p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="compaction-threshold">Summarize at</Label>
                <span className="text-sm tabular-nums" data-slot="threshold-value">
                  {percent(threshold)}
                </span>
              </div>
              <input
                id="compaction-threshold"
                type="range"
                min={COMPACTION_THRESHOLD_MIN}
                max={COMPACTION_THRESHOLD_MAX}
                step={0.05}
                value={threshold}
                onChange={(event) => setThresholdDraft(Number(event.target.value))}
                onPointerUp={(event) =>
                  commitThreshold(Number(event.currentTarget.value), storedThreshold)
                }
                onKeyUp={(event) =>
                  commitThreshold(Number(event.currentTarget.value), storedThreshold)
                }
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
              />
              <p className="text-xs text-muted-foreground">
                Older messages are summarized once the context is this full. Lower means smaller
                prompts and more summarization; higher means more of the chat stays verbatim.
              </p>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {serverThreshold === null ? null : `Server default: ${percent(serverThreshold)}.`}
                  {storedThreshold === null ? ' Currently following the server default.' : ''}
                </p>
                {storedThreshold === null ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() =>
                      void write({ compaction_threshold: null }, 'Using the server default.')
                    }
                  >
                    Use the server default
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-sm leading-none font-medium">Summary model</p>
              <ModelPicker
                models={catalog.models}
                providers={catalog.providers}
                label="Summary model"
                value={summaryModel}
                leading={[
                  {
                    value: SUMMARY_MODEL_SAME_AS_CHAT,
                    label: 'Same as the chat',
                    hint: 'the model your chat runs writes the summary',
                  },
                ]}
                onChange={(modelId) =>
                  void write({ summary_model: modelId }, 'Saved the summary model.')
                }
                refreshing={catalog.refreshing}
                onRefresh={catalog.refresh}
              />
              <p className="text-xs text-muted-foreground">
                A model you choose here summarizes instead of the chat&apos;s own — useful when a
                cheaper model is good enough for it.
              </p>
              {fallback === null ? null : (
                <p role="status" className="text-xs text-coral-ink">
                  This model&apos;s window is much smaller than{' '}
                  <span className="font-mono">{preferences.default_model}</span>&apos;s: folding
                  your chat&apos;s context would take about {fallback.passesNeeded} passes, over
                  your limit of {fallback.maxPasses}, so the chat model will write the summary
                  instead.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="summary-max-passes">Summary pass limit</Label>
              <Input
                id="summary-max-passes"
                type="number"
                min={SUMMARY_MAX_PASSES_MIN}
                max={SUMMARY_MAX_PASSES_MAX}
                step={1}
                inputMode="numeric"
                className="max-w-24"
                value={passes}
                onChange={(event) => setPassesDraft(event.target.value)}
                onBlur={(event) => commitPasses(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitPasses(event.currentTarget.value)
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                How many passes the summary model gets before the chat model takes over. The default
                is {preferences.defaults.summary_max_passes}.
              </p>
            </div>
          </>
        )}

        {saving ? (
          <p role="status" className="text-xs text-muted-foreground">
            Saving…
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** A share as the percentage a reader reads, e.g. `0.7` → `70%`. */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

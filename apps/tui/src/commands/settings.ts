import { summaryModelFallback, type Client } from '@openharness/client'
import { SUMMARY_MODEL_SAME_AS_CHAT, type GetPreferencesResponse } from '@openharness/protocol'

import type { SettingsPatch } from '../args'
import { reportFailure, type CommandIo } from './io'

/**
 * `oh settings [flags]` (epic #277, C3; issue #282) — the context settings a chat compacts with.
 *
 * Without a flag it prints them; each flag sets one, and several may be given at once. The
 * three are the same values the web app's Settings → Context shows, stored on the server
 * (`GET`/`PUT /v1/me/preferences`), so a chat started from either frontend compacts the same
 * way. The write carries only the fields the flags named, and the server merges it (epic #201,
 * X3): the default model, the theme and the other context settings are untouched.
 *
 * A `null` control is printed with the default it follows — the response's `defaults`, which
 * is the deployment's own trigger share and the engine's pass limit, neither of which this
 * command could know on its own.
 *
 * The warning is the web card's, from the same shared arithmetic (`summaryModelFallback`,
 * K5): a summary model much smaller than the default model's needs more passes than the limit
 * allows and the chat model summarizes instead. It needs both models' windows, so the catalog
 * is read — best effort, because a settings screen must still print what is stored when the
 * catalog cannot be reached.
 */
export async function runSettings(
  client: Client,
  io: CommandIo,
  patch: SettingsPatch,
): Promise<number> {
  try {
    const stored =
      Object.keys(patch).length === 0
        ? await client.preferences.get()
        : await client.preferences.put(requestOf(patch))

    if (Object.keys(patch).length > 0) {
      io.stdout('Saved.')
    }
    for (const line of formatSettings(stored)) {
      io.stdout(line)
    }

    const warning = await fallbackWarning(client, stored)
    if (warning !== null) {
      io.stdout(warning)
    }
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/** The `PUT` body the patch names: only the flags that were given, as the protocol spells them. */
function requestOf(patch: SettingsPatch): Parameters<Client['preferences']['put']>[0] {
  return {
    ...(patch.threshold === undefined ? {} : { compaction_threshold: patch.threshold }),
    ...(patch.summaryModel === undefined ? {} : { summary_model: patch.summaryModel }),
    ...(patch.summaryPasses === undefined ? {} : { summary_max_passes: patch.summaryPasses }),
  }
}

/**
 * The stored settings as the lines this command prints.
 *
 * Exported for the test that holds the words still: the numbers and the "(default)" notes are
 * the whole of what a reader learns here.
 */
export function formatSettings(preferences: GetPreferencesResponse): string[] {
  const threshold = preferences.compaction_threshold ?? preferences.defaults.compaction_threshold
  const thresholdNote = preferences.compaction_threshold === null ? ' (the server default)' : ''
  const passes = preferences.summary_max_passes ?? preferences.defaults.summary_max_passes
  const passesNote = preferences.summary_max_passes === null ? ' (default)' : ''
  const summary =
    preferences.summary_model === SUMMARY_MODEL_SAME_AS_CHAT
      ? 'same as the chat'
      : preferences.summary_model

  return [
    `Summarize at ${percent(threshold)} of the context${thresholdNote}.`,
    `Summary model: ${summary}.`,
    `Summary pass limit: ${passes}${passesNote}.`,
  ]
}

/**
 * The "this will fall back" warning, or `null` when there is nothing to say.
 *
 * A failure to read the catalog is not a failure of the command: without the windows there is
 * no arithmetic, so the lines above are the answer and the warning is simply not drawn.
 */
async function fallbackWarning(
  client: Client,
  preferences: GetPreferencesResponse,
): Promise<string | null> {
  if (
    preferences.default_model === null ||
    preferences.summary_model === SUMMARY_MODEL_SAME_AS_CHAT
  ) {
    return null
  }
  try {
    const catalog = await client.models.list()
    const chat = catalog.data.find((entry) => entry.id === preferences.default_model)
    const summary = catalog.data.find((entry) => entry.id === preferences.summary_model)
    if (chat === undefined || summary === undefined) {
      return null
    }
    const maxPasses = preferences.summary_max_passes ?? preferences.defaults.summary_max_passes
    const fallback = summaryModelFallback({ chat, summary, maxPasses })
    if (fallback === null) {
      return null
    }
    return `Note: ${preferences.summary_model} would need about ${fallback.passesNeeded} passes to fold ${preferences.default_model}'s context, over the limit of ${maxPasses}, so the chat model will write the summary instead.`
  } catch {
    return null
  }
}

/** A share as the percentage a reader reads, e.g. `0.7` → `70%`. */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

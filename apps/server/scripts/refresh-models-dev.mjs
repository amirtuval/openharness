#!/usr/bin/env node
/**
 * Regenerate the vendored models.dev snapshot (`src/catalog/models-dev.json`).
 *
 * The model catalogue reads its metadata from a snapshot committed to this repository
 * (`src/catalog/models-dev.json`, bundled into `dist/`), never from the network (C2's rule,
 * unchanged). This script is the one place that reaches out: it fetches models.dev once,
 * keeps the 11 providers this server can validate a key for
 * (`VALIDATABLE_PROVIDERS`), reduces each model to the four fields the catalogue's join
 * reads, and writes the file back.
 *
 * Run it by hand when the data should move — `yarn workspace @openharness/server
 * catalog:refresh` — and commit the diff. Nothing runs it at build, test or boot time, so a
 * sandbox with no network still builds: the snapshot is a source file, like any other.
 *
 * The provider keys models.dev uses are not always ours. models.dev spells two of the eleven
 * by product name; the table below is the whole of the mapping, and the snapshot is keyed by
 * **our** ids so nothing downstream has to know models.dev's spelling.
 */

import { writeFile } from 'node:fs/promises'

/** Where the snapshot lives, and where it comes from. */
const SNAPSHOT_URL = new URL('../src/catalog/models-dev.json', import.meta.url)
const SOURCE = 'https://models.dev/api.json'

/**
 * Our provider id → models.dev's key. The identity for nine of the eleven; `fireworks` and
 * `together` are models.dev's `fireworks-ai` and `togetherai` (the spelling the router id and
 * `VALIDATABLE_PROVIDERS` do not use). Keyed by models.dev's name so the fetch can be read as
 * written, and inverted below.
 */
const MODELS_DEV_KEYS = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  openrouter: 'openrouter',
  groq: 'groq',
  deepseek: 'deepseek',
  fireworks: 'fireworks-ai',
  mistral: 'mistral',
  together: 'togetherai',
  xai: 'xai',
  cerebras: 'cerebras',
}

/** Today, as `YYYY-MM-DD` — the date the snapshot was taken, recorded in the file. */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * One model, reduced to what the catalogue's registry join reads: its name, its context
 * window and its output limit, straight from models.dev's `name` and `limit.{context,output}`.
 *
 * **No chat verdict.** models.dev carries no chat flag, and the fields it does carry are not
 * one: `modalities.output` is `["text"]` even for `text-embedding-3-small`, and `family` is a
 * name family, which is what the catalogue's own filter already reads. So the catalogue's
 * explicit-verdict steps stay silent for snapshot models and its name filter decides, exactly
 * as before — see `src/catalog/filter.ts`, and the note in `src/catalog/registry.ts`.
 */
function reduceModel(model) {
  const reduced = { name: model.name ?? model.id }
  if (typeof model.limit?.context === 'number') {
    reduced.contextWindow = model.limit.context
  }
  if (typeof model.limit?.output === 'number') {
    reduced.maxOutput = model.limit.output
  }
  return reduced
}

/** The whole snapshot: the date, the source, and one entry per provider. */
function buildSnapshot(data) {
  const providers = {}
  for (const [provider, key] of Object.entries(MODELS_DEV_KEYS)) {
    const entry = data[key]
    if (entry === undefined || entry.models === undefined) {
      throw new Error(
        `models.dev knows no ${key} (our ${provider}); refusing to write a partial snapshot`,
      )
    }
    const models = {}
    for (const [id, model] of Object.entries(entry.models)) {
      models[id] = reduceModel(model)
    }
    providers[provider] = {
      key,
      name: entry.name ?? provider,
      models,
    }
  }
  return {
    // The header is data, not a comment: JSON has no comments, and a reader that opens the
    // file should learn where it came from without opening this script.
    snapshot_date: today(),
    source: SOURCE,
    providers,
  }
}

const response = await fetch(SOURCE)
if (!response.ok) {
  throw new Error(`models.dev answered ${response.status} for ${SOURCE}`)
}
const snapshot = buildSnapshot(await response.json())
await writeFile(SNAPSHOT_URL, `${JSON.stringify(snapshot, null, 2)}\n`)
const total = Object.values(snapshot.providers).reduce(
  (count, provider) => count + Object.keys(provider.models).length,
  0,
)
console.log(
  `wrote ${SNAPSHOT_URL.pathname.split('/').pop()} — ${total} models across ` +
    `${Object.keys(snapshot.providers).length} providers, dated ${snapshot.snapshot_date}`,
)

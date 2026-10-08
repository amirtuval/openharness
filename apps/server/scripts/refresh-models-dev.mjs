#!/usr/bin/env node
/**
 * Regenerate the vendored models.dev snapshot (`src/catalog/models-dev.json`).
 *
 * The model catalogue reads its metadata from a snapshot committed to this repository
 * (`src/catalog/models-dev.json`, bundled into `dist/`), never from the network (C2's rule,
 * unchanged). This script is the one place that reaches out: it fetches models.dev once,
 * keeps the 11 providers this server can validate a key for
 * (`VALIDATABLE_PROVIDERS`), reduces each model to the fields the catalogue's join and the
 * usage routes read — name, limits and list prices — and writes the file back.
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
 * One model's prices, or nothing when models.dev has none for it: US dollars per **million**
 * tokens, straight from `cost.{input,output,cache_read,cache_write}`.
 *
 * models.dev publishes rates per million tokens and only some of them: `input` and `output` for
 * every priced model, and the two cache rates for the models whose provider charges them
 * separately (Anthropic has all four; a provider with no prompt-cache pricing has none). A rate
 * that is not a number is left out rather than written as `0` — a missing rate is "nobody
 * published one", and the server's pricing reads that as unknown rather than free (`ModelCost`
 * in `@openharness/protocol`). A model with no `input` or no `output` has no price at all and
 * gets no `cost` entry, which is what makes its requests report tokens and no cost (epic #245).
 */
function reduceCost(model) {
  const cost = model.cost
  if (cost === undefined || cost === null) {
    return undefined
  }
  if (typeof cost.input !== 'number' || typeof cost.output !== 'number') {
    return undefined
  }
  const reduced = { input: cost.input, output: cost.output }
  if (typeof cost.cache_read === 'number') {
    reduced.cacheRead = cost.cache_read
  }
  if (typeof cost.cache_write === 'number') {
    reduced.cacheWrite = cost.cache_write
  }
  return reduced
}

/**
 * One model, reduced to what the catalogue's registry join reads: its name, its context
 * window, its output limit and its list price, straight from models.dev's `name`,
 * `limit.{context,output}` and `cost`.
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
  const cost = reduceCost(model)
  if (cost !== undefined) {
    reduced.cost = cost
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

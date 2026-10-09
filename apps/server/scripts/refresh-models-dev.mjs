#!/usr/bin/env node
/**
 * Regenerate the vendored models.dev snapshot (`src/catalog/models-dev.json`).
 *
 * The model catalogue reads its metadata from a snapshot committed to this repository
 * (`src/catalog/models-dev.json`, bundled into `dist/`), never from the network (C2's rule,
 * unchanged). This script is the one place that reaches out: it fetches models.dev once,
 * keeps the providers of the shared list (`@openharness/protocol`'s `PROVIDERS`, epic #245),
 * reduces each model to the fields the catalogue's join and the usage routes read — name,
 * limits, list prices and the reasoning data (#252's follow-up) — and writes the file back.
 *
 * Run it by hand when the data should move — `yarn workspace @openharness/server
 * catalog:refresh` — and commit the diff. Nothing runs it at build, test or boot time, so a
 * sandbox with no network still builds: the snapshot is a source file, like any other.
 *
 * The JSON this writes is `JSON.stringify(…, null, 2)`, which is not quite Prettier's single-line
 * form for an array of strings (the `efforts` of #252) — run `yarn format` (or
 * `yarn prettier --write src/catalog/models-dev.json`) before committing so `format:check` stays
 * green.
 *
 * **The list is the protocol package's, not this script's.** It is read from protocol's build
 * output — the same `dist/` every other consumer reads — so the ids, their order and the
 * models.dev keys cannot drift from what the server validates and lists. That is also why the
 * script is run after a build: `yarn build` at the root, or `yarn build:deps` in
 * `apps/server`, before `catalog:refresh`.
 *
 * The provider keys models.dev uses are not always ours. models.dev spells two of the eleven
 * by product name, and the shared list carries the mapping (`modelsDevKey`); the snapshot is
 * keyed by **our** ids so nothing downstream has to know models.dev's spelling.
 *
 * The **credential types** are snapshotted too, even though they are not provider ids: Azure
 * OpenAI (#248) and Google Vertex (#251). A deployment name an Azure user typed may be one
 * models.dev knows (`gpt-4o`, `o1`), and its context window is the only thing the catalogue
 * can put on that model — Azure offers no endpoint that lists deployments. Vertex's models are
 * the whole publisher catalogue, which models.dev files under `google-vertex` — Anthropic's
 * models served there included — and are what a Vertex credential's catalogue is built from.
 * Each type is filed under its `modelsDevKey` (`azure`, `google-vertex`), which is the same key
 * its catalogue branch looks it up by; a model the registry does not know gets no metadata at
 * all, because guessing one would be worse than saying nothing.
 */

import { writeFile } from 'node:fs/promises'

import { CREDENTIAL_TYPES, PROVIDERS } from '@openharness/protocol'

/** Where the snapshot lives, and where it comes from. */
const SNAPSHOT_URL = new URL('../src/catalog/models-dev.json', import.meta.url)
const SOURCE = 'https://models.dev/api.json'

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
 * The effort levels models.dev lists for a model's own reasoning knob, or `nothing` when it
 * lists none (#252's follow-up).
 *
 * models.dev describes a model's knob with `reasoning_options`, an array of typed options. Only
 * an `effort` option is one our `low | medium | high` can be spoken to: its `values` are the
 * levels the provider's own API takes, which may include ones we never name (`minimal`, `none`,
 * `xhigh`, `max`). A `budget_tokens` or `toggle` option is a different knob, and is left out —
 * the model then carries no `efforts`, which is what keeps it on the provider's default.
 *
 * The values are kept **verbatim**: the intersection with our three levels is the server's
 * reasoning resolver (`src/catalog/reasoning-support.ts`), not this snapshot's, so the file stays
 * a faithful copy of what models.dev publishes.
 */
function reduceEfforts(reasoningOptions) {
  if (!Array.isArray(reasoningOptions)) {
    return undefined
  }
  for (const option of reasoningOptions) {
    if (option?.type !== 'effort' || !Array.isArray(option.values)) {
      continue
    }
    const values = option.values.filter((value) => typeof value === 'string')
    if (values.length > 0) {
      return values
    }
  }
  return undefined
}

/**
 * One model, reduced to what the catalogue's registry join and the reasoning resolver read: its
 * name, its context window, its output limit, its list price, and its reasoning data — straight
 * from models.dev's `name`, `limit.{context,output}`, `cost`, `reasoning` and
 * `reasoning_options`.
 *
 * `reasoning` is written only when models.dev says `true`, so absence means "not a reasoning
 * model, or the registry says nothing" — the two the resolver reads alike. It is informational;
 * the effort gate is `efforts`, which a reasoning model whose knob is a token budget does not get.
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
  if (model.reasoning === true) {
    reduced.reasoning = true
  }
  const efforts = reduceEfforts(model.reasoning_options)
  if (efforts !== undefined) {
    reduced.efforts = efforts
  }
  const cost = reduceCost(model)
  if (cost !== undefined) {
    reduced.cost = cost
  }
  return reduced
}

/** Every snapshot entry, in the order the two lists name them: providers, then credential types. */
const SOURCES = [
  ...PROVIDERS.map(({ id, modelsDevKey }) => ({ id, modelsDevKey })),
  // A credential type's entries are filed under its models.dev key — `azure`, not
  // `azure_openai` — because the catalogue looks a deployment up by that same key. A type with
  // no key names no single models.dev provider (a custom OpenAI-compatible base URL is the
  // user's), so it contributes no entry and the catalogue borrows a model's metadata only on
  // an exact, unambiguous id match.
  ...CREDENTIAL_TYPES.flatMap(({ modelsDevKey }) =>
    modelsDevKey === undefined ? [] : [{ id: modelsDevKey, modelsDevKey }],
  ),
]

/** The whole snapshot: the date, the source, and one entry per provider, in the list's order. */
function buildSnapshot(data) {
  const providers = {}
  for (const { id, modelsDevKey } of SOURCES) {
    const entry = data[modelsDevKey]
    if (entry === undefined || entry.models === undefined) {
      throw new Error(
        `models.dev knows no ${modelsDevKey} (our ${id}); refusing to write a partial snapshot`,
      )
    }
    const models = {}
    for (const [modelId, model] of Object.entries(entry.models)) {
      models[modelId] = reduceModel(model)
    }
    providers[id] = {
      key: modelsDevKey,
      name: entry.name ?? id,
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

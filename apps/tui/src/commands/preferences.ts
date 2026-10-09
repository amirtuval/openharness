import type { Client } from '@openharness/client'

import { reportFailure, type CommandIo } from './io'

/**
 * `oh default-model [provider/model]` (#114, epic #116 U1) — the model a new chat starts on.
 *
 * Without an argument it prints what is stored; with one it stores it. The default lives on
 * the server (`GET`/`PUT /v1/me/preferences`), so it is the same choice the web app's
 * Settings show, and a chat started from either place runs it. There is no way to clear it
 * from here: the last word on the shape of a model id is the server's, and a value it
 * accepts is exactly what is printed back.
 *
 * The write carries `default_model` and nothing else, and the server merges it (epic #201,
 * X3): the web theme the same row holds is untouched, and there is no theme UI here — the
 * terminal's own colours are the TUI's theme (X4).
 */
export async function runDefaultModel(
  client: Client,
  io: CommandIo,
  model: string | undefined,
): Promise<number> {
  try {
    if (model !== undefined) {
      const stored = await client.preferences.put({ default_model: model })
      io.stdout(`Default model set to ${stored.default_model ?? model}.`)
      return 0
    }

    const preferences = await client.preferences.get()
    io.stdout(
      preferences.default_model === null
        ? 'No default model set. A new chat will ask which model to run.'
        : `Default model: ${preferences.default_model}`,
    )
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

import { credentialDisplayName, type Client } from '@openharness/client'
import type { ProviderCredential } from '@openharness/protocol'
import { Box, render, Text, useApp } from 'ink'
import { useCallback } from 'react'

import { ProviderSetup } from '../components/provider-setup'
import type { ErrorContext } from '../errors'
import { installSignals } from '../signals'
import { restoreTerminal } from '../terminal'
import { isYes, readLine, reportFailure, type CommandIo } from './io'
import { pad } from './list'

/**
 * `oh providers` (#210, epic #201 X7) — the model-provider keys, from the terminal.
 *
 * | command                        | what it does                                        |
 * | ------------------------------ | --------------------------------------------------- |
 * | `oh providers` / `... list`    | the stored credentials: name, type, last four, added |
 * | `oh providers add [provider]`  | the connect flow, on its own                        |
 * | `oh providers remove <p>`      | forget a key (asks; `--yes` skips)                  |
 *
 * The API these drive is **write-only** (epic #65, A5): the secret goes up on `put` and only
 * metadata ever comes back, so `list` is the whole of what this CLI can show — the credential's
 * name, its type, the last four characters and when it was added. A credential is stored under
 * a **name** (#245, A3a), which is the `provider` half of the models it serves: a provider id
 * for the eleven fixed providers, a name the reader chose (`azure-eu`) for a named type. The
 * secret itself is never read back, never written to this machine, and never printed.
 */

/** How wide the credential-name column gets before it is cut; the other columns are short. */
const NAME_WIDTH = 18
const TYPE_WIDTH = 8
const LAST4_WIDTH = 6

/** `oh providers list` — the caller's stored keys, oldest first. */
export async function runProvidersList(client: Client, io: CommandIo): Promise<number> {
  try {
    const { data } = await client.providerCredentials.list()
    for (const line of formatCredentials(data)) io.stdout(line)
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/** What `oh providers remove` needs: the confirmation, read from stdin like `sessions delete`. */
export interface ProvidersRemoveIo extends CommandIo {
  /** Write the question without a trailing newline: the answer belongs on the same line. */
  readonly prompt: (text: string) => void
  /** Where the answer is read from; `y`/`yes` (any case) removes. */
  readonly stdin: NodeJS.ReadStream
}

/**
 * `oh providers remove <provider>` — forget a key.
 *
 * It asks first even though re-adding a key is easy: losing a working key costs a trip to the
 * provider's console, and the question is one keystroke. `--yes` skips it. Deleting a provider
 * with no key is not an error — the route answers `204` for what is not there — so the command
 * says it did what it was asked either way.
 */
export async function runProvidersRemove(
  client: Client,
  io: ProvidersRemoveIo,
  provider: string,
  options: { readonly yes: boolean },
): Promise<number> {
  // The name is what it is stored under, printed as given: the remove command does not read
  // the list first, so it has no display name to prefer — and the name is the thing the reader
  // typed on the command line.
  if (!options.yes) {
    io.prompt(`Remove the ${provider} credential? [y/N] `)
    if (!isYes(await readLine(io.stdin))) {
      io.stdout('Not removed.')
      return 0
    }
  }

  try {
    await client.providerCredentials.delete(provider)
    io.stdout(`Removed the ${provider} credential.`)
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/**
 * How `oh providers add` ended, before the run turns it into output and an exit code.
 *
 * `stale-session` is the 401 a credential write needs a fresh session for (epic #65, A2); the
 * run offers the device flow and mounts the flow again, which is why it is not simply an error.
 */
export type ProvidersAddOutcome =
  { readonly kind: 'saved' } | { readonly kind: 'cancelled' } | { readonly kind: 'stale-session' }

/** What mounting the connect flow needs. */
export interface ProvidersAddMountOptions {
  readonly client: Client
  readonly context: ErrorContext
  /** Start on this provider; without one the flow opens on the list. */
  readonly provider?: string | undefined
  readonly openUrl: (url: string) => boolean
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
}

/**
 * Run the connect flow in its own Ink screen, and say how it ended.
 *
 * The terminal hygiene is the chat's, in miniature: raw mode off and the cursor back on every
 * way out, including a signal — a `Ctrl+C` inside the flow is the flow's own cancel, so Ink is
 * told not to exit on it (`exitOnCtrlC: false`) and the screen settles instead.
 */
export async function mountProvidersAdd(
  options: ProvidersAddMountOptions,
): Promise<ProvidersAddOutcome> {
  const { stdin, stdout, stderr } = options
  const restore = (): void => {
    restoreTerminal({ stdin, stdout })
  }

  let instance: ReturnType<typeof render> | undefined
  const stopSignals = installSignals(process, {
    onInterrupt: () => {
      settle(130)
    },
    onTerminate: () => {
      settle(143)
    },
  })

  function settle(code: number): void {
    restore()
    if (instance === undefined) {
      process.exit(code)
    }
    instance.unmount()
  }

  const onProcessExit = (): void => {
    restore()
  }
  process.once('exit', onProcessExit)

  try {
    instance = render(
      <ProvidersAddApp
        client={options.client}
        context={options.context}
        provider={options.provider}
        openUrl={options.openUrl}
      />,
      { stdin, stdout, stderr, exitOnCtrlC: false },
    )

    const result = await instance.waitUntilExit()
    return isOutcome(result) ? result : { kind: 'cancelled' }
  } finally {
    stopSignals()
    process.off('exit', onProcessExit)
    restore()
  }
}

/**
 * The Ink app: the connect flow, and nothing else.
 *
 * Exported so a test can render it through `ink-testing-library`, the way every other screen
 * in this package is tested — the mount below is the terminal plumbing around it, and this is
 * the screen itself.
 */
export function ProvidersAddApp({
  client,
  context,
  provider,
  openUrl,
}: {
  readonly client: Client
  readonly context: ErrorContext
  readonly provider: string | undefined
  readonly openUrl: (url: string) => boolean
}) {
  const { exit } = useApp()
  const done = useCallback(
    (outcome: ProvidersAddOutcome): void => {
      exit(outcome)
    },
    [exit],
  )

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {`A key is sent to ${context.server ?? 'the server'} over HTTPS, validated once against the provider, and stored encrypted there. It is never written to this machine.`}
      </Text>
      <ProviderSetup
        client={client}
        context={context}
        initialProvider={provider}
        openUrl={openUrl}
        onSaved={() => {
          done({ kind: 'saved' })
        }}
        onCancel={() => {
          done({ kind: 'cancelled' })
        }}
        onStaleSession={() => {
          done({ kind: 'stale-session' })
        }}
      />
    </Box>
  )
}

/** What `exit()` was called with, when it looks like one of ours. */
function isOutcome(result: unknown): result is ProvidersAddOutcome {
  if (typeof result !== 'object' || result === null) return false
  const kind = (result as { kind?: unknown }).kind
  return kind === 'saved' || kind === 'cancelled' || kind === 'stale-session'
}

/**
 * One line per stored credential: display name, credential type, last four, when it was added.
 *
 * The order is the server's (oldest first). The display name is the provider's, the credential
 * type's where the name is that type's default (`azure`), or the reader's own label otherwise —
 * so two Azure credentials are told apart by the names they were saved under.
 */
export function formatCredentials(credentials: readonly ProviderCredential[]): readonly string[] {
  if (credentials.length === 0) {
    return ['No credentials yet. Add one with `oh providers add`.']
  }

  return credentials.map((credential) =>
    [
      pad(credentialDisplayName(credential), NAME_WIDTH),
      pad(credential.type, TYPE_WIDTH),
      pad(`…${credential.last4}`, LAST4_WIDTH),
      credential.created_at,
    ].join('  '),
  )
}

import { credentialFacts, credentialRowLabel, type Client } from '@openharness/client'
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

/**
 * How wide the credential-name column gets before it is cut; the other columns are short.
 * Wide enough for a named credential's name and the type's display name together
 * (`azure (Azure OpenAI)`).
 */
const NAME_WIDTH = 24
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
 * One line per stored credential: the name it is typed under, credential type, what else it
 * reports, last four, when it was added.
 *
 * The order is the server's (oldest first). The first column is what the reader types as the
 * `provider` half of a model id (#245, A3a): the provider's display name for one of the
 * eleven, and the credential's **name** for a named credential — with the type's display name
 * beside it when that name would hide the prefix (`azure (Azure OpenAI)` rather than just
 * `Azure OpenAI`, which is not what a model id starts with). A reader-named credential already
 * reads as itself (`azure-eu`), so two Azure credentials are still told apart by the names
 * they were saved under. The facts at the end of the line are the per-type non-secret ones
 * (#245, A3c/A3d) — a Bedrock credential's region, a Vertex one's email, project and location
 * — because `last4` alone cannot tell two credentials of one type apart when they are two
 * accounts or two regions of one account.
 */
export function formatCredentials(credentials: readonly ProviderCredential[]): readonly string[] {
  if (credentials.length === 0) {
    return ['No credentials yet. Add one with `oh providers add`.']
  }

  return credentials.map((credential) => {
    // What the credential's **type** knows about it, where it knows anything (#245,
    // A3c/A3d): a Bedrock credential's region, a Vertex one's service-account email, its
    // project and its location. Nothing of a private key is here, and never could be — it is
    // not in the database's metadata. The facts go at the **end** rather than in a fixed
    // column: an email address is wider than any column worth reserving on every key's row.
    const facts = credentialFacts(credential).join(' · ')
    return [
      pad(credentialNameLabel(credential), NAME_WIDTH),
      pad(credential.type, TYPE_WIDTH),
      // A custom OpenAI-compatible credential may carry no key at all (#249); its `last4` is
      // empty, and `…` alone would read as a key that failed to load rather than one a local
      // endpoint does not need.
      pad(credential.last4 === '' ? 'no key' : `…${credential.last4}`, LAST4_WIDTH),
      credential.created_at,
      ...(facts === '' ? [] : [facts]),
    ].join('  ')
  })
}

/**
 * The name column's text: the row label both frontends share (#271) as one string.
 *
 * What leads a row, and when the type's display name belongs beside it, is
 * `credentialRowLabel`'s (`@openharness/client`) — the rule lives there so the web row reads
 * the same way, and only the joining is the terminal's: `azure (Azure OpenAI)`.
 */
function credentialNameLabel(credential: ProviderCredential): string {
  const { primary, secondary } = credentialRowLabel(credential)
  return secondary === undefined ? primary : `${primary} (${secondary})`
}

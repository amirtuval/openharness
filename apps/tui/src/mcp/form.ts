import type {
  CreateMcpServerRequest,
  McpServer,
  UpdateMcpServerRequest,
} from '@openharness/protocol'
import {
  MCP_SERVER_NAME_MAX_LENGTH,
  isMcpServerName,
  isMcpServerUrl,
  mcpServerNameFromUrl,
} from '@openharness/protocol'

/**
 * The form a remote MCP server is registered and edited with (epic #303, X10; the screen is
 * #313).
 *
 * The terminal's copy of the web dialog's fields, for the reason `providers/credential-form.ts`
 * is a copy of the web key form: one is Ink and the other is React DOM, and the only thing they
 * share — the field names and the request body — is the protocol's. What is here is plain data
 * and two functions, so the whole flow is testable without a terminal.
 *
 * **There is no auth-type prompt** (issue #314). The reader gives a URL, and the **server**
 * works out how it authenticates; a name is optional (the server derives one from the URL's
 * host, offered here as the placeholder), and the one header pair is how a reader says "this
 * server wants an API key" — supplying it implies `headers` on the wire, which is why nothing
 * has to be chosen for it.
 *
 * The shape rules are the protocol's own — {@link isMcpServerName} and {@link isMcpServerUrl} —
 * checked here so a reader sees what is wrong on the prompt rather than as a failed request, the
 * way the web form checks them beside the field.
 */

/** The values keys the form uses, and the names it builds a body from. */
export const MCP_NAME_FIELD = 'name'
export const MCP_URL_FIELD = 'url'
export const MCP_HEADER_NAME_FIELD = 'header_name'
export const MCP_HEADER_VALUE_FIELD = 'header_value'
export const MCP_ENABLED_FIELD = 'enabled'

/** One prompt of the form. */
export interface McpField {
  /** The key in the values record. */
  readonly name: string
  /** What the prompt calls it. */
  readonly label: string
  /** Whether the input hides what is typed: a header value is a secret, the rest are not. */
  readonly secret: boolean
  /** The values the field takes, when it is a list the reader picks from. */
  readonly options?: readonly string[]
  /** Where a list field starts; a list has no "unset". */
  readonly defaultValue?: string
  /** Whether Enter on an empty field moves on rather than refusing (an edit may keep a map). */
  readonly optional?: boolean
  /** Why what was typed cannot be used, or `null`. */
  readonly validate?: (value: string) => string | null
}

/** The choice a boolean field offers, as the list it is drawn as. */
const ENABLED_OPTIONS = ['on', 'off'] as const

/** Whether the yes/no list said yes. */
export function enabledFrom(value: string | undefined): boolean {
  return value !== 'off'
}

/**
 * The prompts the form shows.
 *
 * The URL comes first, because it decides everything — including the name, which the server
 * derives from its host when the reader leaves it blank. The one optional header pair is last
 * but one: a terminal has no disclosure control, so it is labelled as the advanced thing it is.
 *
 * The pair is a **single** one on this screen — the web dialog offers a list — because a
 * terminal prompt is a line: a server needing several headers is edited in the web app, and the
 * one that matters (an API key header) is this.
 *
 * @param options whether this is an edit, and the header names a server being edited already
 * holds (their values are sealed and never come back)
 */
export function mcpServerFields(options: {
  readonly editing: boolean
  readonly storedHeaderNames?: readonly string[]
}): readonly McpField[] {
  const stored = options.storedHeaderNames ?? []
  const keeping = options.editing && stored.length > 0
  return [
    {
      name: MCP_URL_FIELD,
      label: 'URL (the Streamable HTTP endpoint)',
      secret: false,
      validate: (value) =>
        isMcpServerUrl(value.trim())
          ? null
          : 'an absolute http or https URL with a host, no userinfo and no fragment',
    },
    {
      name: MCP_NAME_FIELD,
      label: 'Name (optional — lowercase; it prefixes every tool name a model sees)',
      secret: false,
      optional: true,
      validate: (value) =>
        value.trim() === '' || isMcpServerName(value.trim())
          ? null
          : `a name is 1–${MCP_SERVER_NAME_MAX_LENGTH} lowercase letters, digits and interior dashes`,
    },
    {
      name: MCP_HEADER_NAME_FIELD,
      label: keeping
        ? `Custom header name (optional; stored: ${stored.join(', ')} — leave both blank to keep them)`
        : 'Custom header name (optional — only for a server that takes an API key header)',
      secret: false,
      optional: true,
    },
    {
      name: MCP_HEADER_VALUE_FIELD,
      label: 'Custom header value (optional)',
      secret: true,
      optional: true,
    },
    {
      name: MCP_ENABLED_FIELD,
      label: 'On by default for your chats',
      secret: false,
      options: ENABLED_OPTIONS,
      defaultValue: 'on',
    },
  ]
}

/** What the form collects, as the request body it becomes. */
export type McpServerBody =
  | { readonly kind: 'create'; readonly body: CreateMcpServerRequest }
  | { readonly kind: 'update'; readonly body: UpdateMcpServerRequest }

/**
 * The body the form's answers become.
 *
 * **No auth type is sent** (issue #314): the server probes the URL, and a header map implies
 * `headers` on its own. A **create** omits the name when the reader left it blank (the server
 * derives one from the host). An **edit** omits the map when both header prompts were left
 * blank, which is the only way to say "keep what is sealed": the values are write-only, so a
 * form that sent an empty map would drop the reader's configured headers.
 *
 * @param options whether this is an edit
 * @param values what the prompts hold
 */
export function mcpServerBody(
  options: { readonly editing: boolean },
  values: Readonly<Record<string, string>>,
): McpServerBody {
  const name = (values[MCP_NAME_FIELD] ?? '').trim()
  const url = (values[MCP_URL_FIELD] ?? '').trim()
  const enabled = enabledFrom(values[MCP_ENABLED_FIELD])
  const headers = collectedHeaders(values)
  const named = name === '' ? {} : { name }
  if (!options.editing) {
    return {
      kind: 'create',
      body: { url, enabled, ...named, ...(headers === undefined ? {} : { headers }) },
    }
  }
  return {
    kind: 'update',
    body: { url, enabled, ...named, ...(headers === undefined ? {} : { headers }) },
  }
}

/** The name a create would store, for a screen that names it back before one is typed. */
export function derivedServerName(values: Readonly<Record<string, string>>): string {
  const name = (values[MCP_NAME_FIELD] ?? '').trim()
  if (name !== '') {
    return name
  }
  const url = (values[MCP_URL_FIELD] ?? '').trim()
  return url === '' ? '' : mcpServerNameFromUrl(url)
}

/**
 * The header map the two prompts hold, or `undefined` when there is nothing to send.
 *
 * A pair is one header on this screen; a name with no value is refused rather than dropped,
 * because it is a reader who thinks they configured something.
 */
export function collectedHeaders(
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const name = (values[MCP_HEADER_NAME_FIELD] ?? '').trim()
  const value = values[MCP_HEADER_VALUE_FIELD] ?? ''
  if (name === '' && value === '') {
    return undefined
  }
  return { [name]: value }
}

/**
 * What is wrong with the header prompts, or `null`.
 *
 * Both blank is fine — the map is optional now (issue #314), and leaving it empty means the
 * server detects what the URL needs (or keeps what an edit already has sealed). A half-typed
 * row is refused rather than dropped, because it is a reader who thinks they configured
 * something.
 */
export function mcpHeaderProblem(values: Readonly<Record<string, string>>): string | null {
  const name = (values[MCP_HEADER_NAME_FIELD] ?? '').trim()
  const value = values[MCP_HEADER_VALUE_FIELD] ?? ''
  if (name === '' && value === '') {
    return null
  }
  if (name === '' || value === '') {
    return 'every header needs both a name and a value'
  }
  return null
}

/** The values an edit starts from: the server's own, with the header pair left blank. */
export function mcpServerValues(server: McpServer | null): Record<string, string> {
  if (server === null) {
    return { [MCP_ENABLED_FIELD]: 'on' }
  }
  return {
    [MCP_NAME_FIELD]: server.name,
    [MCP_URL_FIELD]: server.url,
    [MCP_ENABLED_FIELD]: server.enabled ? 'on' : 'off',
  }
}

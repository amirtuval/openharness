import { MCP_AUTH_TYPES, mcpAuthHint, mcpAuthLabel } from '@openharness/client'
import type {
  CreateMcpServerRequest,
  McpAuthType,
  McpServer,
  UpdateMcpServerRequest,
} from '@openharness/protocol'
import { MCP_SERVER_NAME_MAX_LENGTH, isMcpServerName, isMcpServerUrl } from '@openharness/protocol'

/**
 * The form a remote MCP server is registered and edited with (epic #303, X10; the screen is
 * #313).
 *
 * The terminal's copy of the web dialog's fields, for the reason `providers/credential-form.ts`
 * is a copy of the web key form: one is Ink and the other is React DOM, and the only thing they
 * share — the field names and the request body — is the protocol's. What is here is plain data
 * and two functions, so the whole of the flow's conditional shape (a `headers` server carries
 * header fields, the other two do not) is testable without a terminal.
 *
 * The two shape rules are the protocol's own — {@link isMcpServerName} and
 * {@link isMcpServerUrl} — checked here so a reader sees what is wrong on the prompt rather
 * than as a failed request, the way the web form checks them beside the field.
 */

/** The values keys the form uses, and the names it builds a body from. */
export const MCP_NAME_FIELD = 'name'
export const MCP_URL_FIELD = 'url'
export const MCP_AUTH_FIELD = 'auth'
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
 * The prompts the form shows, given what has been answered so far.
 *
 * The auth choice decides the rest, which is why the fields are computed rather than fixed: a
 * `headers` server is asked for one header pair, and the other two are asked nothing more. The
 * pair is a **single** one on this screen — the web dialog offers a list — because a terminal
 * prompt is a line: a server needing several headers is edited in the web app, and the one that
 * matters (an API key header) is this.
 *
 * @param options whether this is an edit, what auth has been chosen, and the header names a
 * server being edited already holds (their values are sealed and never come back)
 */
export function mcpServerFields(options: {
  readonly editing: boolean
  readonly auth: McpAuthType | null
  readonly storedHeaderNames?: readonly string[]
}): readonly McpField[] {
  const fields: McpField[] = [
    {
      name: MCP_NAME_FIELD,
      label: 'Name (lowercase; it prefixes every tool name a model sees)',
      secret: false,
      validate: (value) =>
        isMcpServerName(value.trim())
          ? null
          : `a name is 1–${MCP_SERVER_NAME_MAX_LENGTH} lowercase letters, digits and interior dashes`,
    },
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
      name: MCP_AUTH_FIELD,
      label: 'Authentication',
      secret: false,
      options: MCP_AUTH_TYPES.map(mcpAuthLabel),
      defaultValue: mcpAuthLabel('none'),
    },
  ]

  if (options.auth === 'headers') {
    const stored = options.storedHeaderNames ?? []
    const keeping = options.editing && stored.length > 0
    fields.push(
      {
        name: MCP_HEADER_NAME_FIELD,
        label:
          keeping && stored !== undefined
            ? `Header name (stored: ${stored.join(', ')} — leave both blank to keep them)`
            : 'Header name',
        secret: false,
        optional: keeping,
      },
      {
        name: MCP_HEADER_VALUE_FIELD,
        label: 'Header value',
        secret: true,
        optional: keeping,
      },
    )
  }

  fields.push({
    name: MCP_ENABLED_FIELD,
    label: 'On by default for your chats',
    secret: false,
    options: ENABLED_OPTIONS,
    defaultValue: 'on',
  })
  return fields
}

/** What the form collects, as the request body it becomes. */
export type McpServerBody =
  | { readonly kind: 'create'; readonly body: CreateMcpServerRequest }
  | { readonly kind: 'update'; readonly body: UpdateMcpServerRequest }

/**
 * The body the form's answers become.
 *
 * A **create** states its auth and, for a `headers` server, the map it authenticates with — the
 * protocol refuses one without a map, because that is a `none` server that says otherwise. An
 * **edit** omits the map when both header prompts were left blank, which is the only way to say
 * "keep what is sealed": the values are write-only, so a form that sent an empty map would drop
 * the reader's configured headers.
 *
 * @param options whether this is an edit, and the auth the reader chose
 * @param values what the prompts hold
 */
export function mcpServerBody(
  options: { readonly editing: boolean; readonly auth: McpAuthType },
  values: Readonly<Record<string, string>>,
): McpServerBody {
  const name = (values[MCP_NAME_FIELD] ?? '').trim()
  const url = (values[MCP_URL_FIELD] ?? '').trim()
  const enabled = enabledFrom(values[MCP_ENABLED_FIELD])
  const headers = collectedHeaders(values)
  if (!options.editing) {
    return {
      kind: 'create',
      body:
        options.auth === 'headers'
          ? { auth: 'headers', name, url, enabled, headers: headers ?? {} }
          : { auth: options.auth === 'oauth' ? 'oauth' : 'none', name, url, enabled },
    }
  }
  return {
    kind: 'update',
    body: { name, url, auth: options.auth, enabled, ...(headers === undefined ? {} : { headers }) },
  }
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
 * `required` is a new server: a `headers` one with no map has nothing to authenticate with, and
 * the wire refuses it. An edit may leave both blank and keep what is stored.
 */
export function mcpHeaderProblem(
  auth: McpAuthType | null,
  values: Readonly<Record<string, string>>,
  options: { readonly required: boolean },
): string | null {
  if (auth !== 'headers') {
    return null
  }
  const name = (values[MCP_HEADER_NAME_FIELD] ?? '').trim()
  const value = values[MCP_HEADER_VALUE_FIELD] ?? ''
  if (name === '' && value === '') {
    return options.required ? 'a headers-authenticated server needs at least one header' : null
  }
  if (name === '' || value === '') {
    return 'every header needs both a name and a value'
  }
  return null
}

/** The auth a label stands for: what the list drew, read back. */
export function authFromLabel(label: string): McpAuthType {
  return MCP_AUTH_TYPES.find((auth) => mcpAuthLabel(auth) === label) ?? 'none'
}

/** The hint the auth prompt shows under its list. */
export function authHint(auth: McpAuthType): string {
  return mcpAuthHint(auth)
}

/** The values an edit starts from: the server's own, with the header pair left blank. */
export function mcpServerValues(server: McpServer | null): Record<string, string> {
  if (server === null) {
    return { [MCP_ENABLED_FIELD]: 'on' }
  }
  return {
    [MCP_NAME_FIELD]: server.name,
    [MCP_URL_FIELD]: server.url,
    [MCP_AUTH_FIELD]: mcpAuthLabel(server.auth),
    [MCP_ENABLED_FIELD]: server.enabled ? 'on' : 'off',
  }
}

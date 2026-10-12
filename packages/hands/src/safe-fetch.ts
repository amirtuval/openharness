/**
 * `safeFetch`: the one way openharness makes an outbound request to a URL a **user** supplied
 * (epic #245, A3a).
 *
 * Everything else the server fetches is a constant URL it wrote itself (the model-catalogue
 * adapters, the key-validation requests), so there is no address to choose and nothing to
 * guard. A provider credential's endpoint is different: an Azure OpenAI endpoint is typed by
 * the user, and a URL the user chose is exactly what an SSRF guard is for. `safeFetch` is that
 * guard, and it is built here — in `@openharness/hands`, its first real code — because the
 * tools' own `web_fetch` reuses it (epic #245, decision M1; #305).
 *
 * What it does, in order, on every hop:
 *
 * 1. **Scheme.** Only `http` and `https`. `file:`, `data:`, `gopher:` and the rest are refused
 *    before anything else happens.
 * 2. **Metadata hostnames.** `metadata.google.internal` and friends are refused by name.
 * 3. **DNS, resolved here.** The hostname is resolved by this module, and **every** address it
 *    resolves to is checked against {@link isBlockedAddress}. A hostname that resolves to even
 *    one private address is refused whole: a DNS answer that mixes a public and a private
 *    address is an attack, not a coincidence.
 * 4. **Connect to the address that was checked.** Each hop builds its own dispatcher, whose
 *    `connect.lookup` answers from exactly the addresses step 3 approved **for that hop** and
 *    refuses every other name, so the connection cannot be re-resolved: a second lookup cannot
 *    rebind the name to an internal address between the check and the connect, and a
 *    concurrent call to the same host cannot move this one's socket. SNI and the `Host` header
 *    stay the original hostname; only the socket's address is pinned. The dispatcher is closed
 *    when the hop's body is finished — read whole, failed or cancelled — so neither a pin nor
 *    a socket outlives the call.
 * 5. **Redirects, one hop at a time.** `redirect: 'manual'` means undici never follows a
 *    `Location` for us, so steps 1–4 run again for every hop, and a redirect to a private
 *    address is refused exactly as a direct one is. The number of hops is capped — and the two
 *    presets cap it at **zero**, so a provider call that answers a redirect is refused rather
 *    than sent somewhere else. A hop that leaves the origin the request started on carries no
 *    credential header (`CREDENTIAL_HEADERS`), and a redirect that would have to resend a body
 *    this call cannot replay is refused.
 * 6. **Limits.** A response body is capped in bytes and a call in total time — per call, because
 *    a save-time check and a model request want very different numbers (see
 *    {@link SAVE_TIME_LIMITS} and {@link STREAMING_LIMITS}).
 *
 * ## The egress proxy
 *
 * A deployment that reaches the internet through a proxy sets `HTTP_PROXY` / `HTTPS_PROXY` /
 * `NO_PROXY`. `catalog/provider-fetch.ts` in the server reads them through undici's
 * {@link EnvHttpProxyAgent} for the catalogue's constant URLs; each hop here builds its own
 * `EnvHttpProxyAgent`, so a proxied deployment works with no extra flag, and with no proxy
 * configured it is an ordinary direct connection.
 *
 * Through a proxy the **check still runs on the target host** (steps 1–3, which is the half
 * that matters), but the *pin* does not: an HTTP proxy resolves the target itself and there is
 * no way to hand it an address to connect to, so the connection step belongs to the proxy. A
 * direct connection pins, and so does a host `NO_PROXY` exempts. Which is why the range check
 * is unconditional and the pin is what the proxy path gives up — and why **a deployment that
 * sets a proxy must have the proxy refuse private ranges itself**: behind one, that check is
 * all that stands between a user-supplied URL and the internal network. Production egresses
 * through Cloud NAT with no proxy; the variables exist for e2e's stub and for sandboxes.
 *
 * ## What it is not
 *
 * It is not a browser. It does not parse HTML, does not accept `file:` URLs, does not follow a
 * `Location` to a scheme it would not have accepted itself, and never retries.
 */

import type { LookupAddress, LookupOptions } from 'node:dns'
import { lookup as dnsResolve } from 'node:dns/promises'

import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'

import { isBlockedAddress, isMetadataHostname, parseIpAddress } from './ssrf'

/** Why a request was refused, or how it ended. Stable strings, for a caller to branch on. */
export type SafeFetchErrorCode =
  | 'invalid_protocol'
  | 'invalid_url'
  | 'metadata_host'
  | 'dns_failure'
  | 'blocked_address'
  | 'too_many_redirects'
  | 'invalid_redirect'
  | 'too_large'
  | 'idle_timeout'

/**
 * A refusal or a limit, with a stable {@link SafeFetchErrorCode}.
 *
 * The message never contains the URL's credentials or query, but it does name the host and the
 * reason: a user who saved a bad endpoint is owed an explanation, and a host name is not a
 * secret.
 */
export class SafeFetchError extends Error {
  /** What went wrong; see {@link SafeFetchErrorCode}. */
  readonly code: SafeFetchErrorCode

  constructor(code: SafeFetchErrorCode, message: string) {
    super(message)
    this.name = 'SafeFetchError'
    this.code = code
  }
}

/** Whether a value is the {@link SafeFetchError} this module raises, across a bundle boundary. */
export function isSafeFetchError(value: unknown): value is SafeFetchError {
  if (value instanceof SafeFetchError) {
    return true
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (value as Partial<SafeFetchError>).name === 'SafeFetchError'
}

/**
 * How a hostname is resolved to addresses: every address it has, as strings.
 *
 * The default is `node:dns`' `lookup` with `{ all: true }`. It is a seam so a test can drive
 * the guard without a resolver — and so the route tests can keep the guard on while reaching a
 * stub, which is the one thing a real loopback address cannot do (it is refused, by design).
 */
export type AddressResolver = (hostname: string) => Promise<readonly string[]>

/** One request {@link SafeFetchTransport} is asked to make. The dispatcher is the transport's own. */
export interface SafeFetchRequest {
  readonly method: string
  readonly headers: Headers
  readonly body: BodyInit | null | undefined
  readonly signal: AbortSignal
  /** Always `manual`: {@link safeFetch} follows a `Location` itself, re-checking each hop. */
  readonly redirect: 'manual'
  /**
   * The addresses the guard approved for this hop's host — every one of them checked, and the
   * only ones the connection may use.
   *
   * A transport that pins hands them to its socket (the default one does, under the hostname
   * the URL carries); one that does not can ignore them, which is what a test's transport
   * does.
   */
  readonly addresses: readonly string[]
}

/** How {@link safeFetch} reaches the network. The default pins the socket; a test replaces it. */
export type SafeFetchTransport = (url: string, init: SafeFetchRequest) => Promise<Response>

/** Everything {@link safeFetch} takes beyond the `fetch` arguments. Every field is per call. */
export interface SafeFetchOptions {
  /**
   * Allow private, loopback and link-local addresses (epic #245, A3b's server setting).
   *
   * Off by default, and **never** turned on for an Azure endpoint: Azure is a hosted public
   * service, so a private address can only be a mistake or an attack. The option exists for
   * the later custom-URL credential type, whose server-side flag is what selects it.
   */
  readonly allowPrivate?: boolean
  /** The most response bytes to accept; `null` disables the cap. Defaults to {@link DEFAULT_MAX_BYTES}. */
  readonly maxBytes?: number | null
  /** The deadline for the whole call, body included; `null` disables it. Defaults to 30 s. */
  readonly timeoutMs?: number | null
  /** How long the body may stall between chunks; `null` disables it. Off by default. */
  readonly idleTimeoutMs?: number | null
  /**
   * How many redirects may be followed, each re-checked. Defaults to
   * {@link DEFAULT_MAX_REDIRECTS}; `0` refuses a redirect instead of following it, which is
   * what the two presets do — a provider API call has no business being sent elsewhere.
   */
  readonly maxRedirects?: number
  /** How hostnames resolve. Defaults to `node:dns`' `lookup`. Injectable for tests. */
  readonly resolver?: AddressResolver
  /** How the request is actually made. Defaults to undici `fetch` over the pinned dispatcher. */
  readonly transport?: SafeFetchTransport
}

/** How much of a response a call accepts before it is refused, when the caller says nothing. */
export const DEFAULT_MAX_BYTES = 1024 * 1024

/** How long a call may take end to end, when the caller says nothing. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** How many redirect hops are followed, when the caller says nothing. */
export const DEFAULT_MAX_REDIRECTS = 5

/**
 * The limits a **save-time check** uses: one cheap authenticated request, whose answer nobody
 * reads.
 *
 * Tight on purpose. The request is a small JSON body or none, so a body over a megabyte is a
 * provider that has gone wrong or a server that is not the provider; and ten seconds is the
 * same deadline the catalogue's own calls carry (C1). A redirect is refused rather than
 * followed: the endpoint is a URL the user typed, and a provider that answers `Location` is a
 * provider sending this credential somewhere the user did not name.
 */
export const SAVE_TIME_LIMITS = {
  maxBytes: 1024 * 1024,
  timeoutMs: 10_000,
  idleTimeoutMs: null,
  maxRedirects: 0,
} as const satisfies SafeFetchOptions

/**
 * The limits a **streaming model call** uses: no total deadline and no size cap.
 *
 * A model streams a long reply, and a cap on either would cut a legitimate answer. What is
 * still bounded is an idle stream: {@link STREAMING_IDLE_TIMEOUT_MS} without a single byte is
 * a hung connection, not a slow answer. The caller passes its own abort signal for the cases
 * only it knows about (a user pressing stop). A redirect is refused, as at save time: the
 * endpoint is the user's, and the model's key must not follow a `Location` off it.
 */
export const STREAMING_LIMITS = {
  maxBytes: null,
  timeoutMs: null,
  idleTimeoutMs: 120_000,
  maxRedirects: 0,
} as const satisfies SafeFetchOptions

/** How long a streaming body may stall before it is treated as hung. */
export const STREAMING_IDLE_TIMEOUT_MS = STREAMING_LIMITS.idleTimeoutMs

/** The request body cap of the load-bearing `fetch` type, kept out of the public surface. */
type Body = BodyInit | null | undefined

/** One request's resolved limits. */
interface Limits {
  readonly maxBytes: number | null
  readonly idleTimeoutMs: number | null
}

/** The status codes whose responses carry no body; a `Response` with one throws to construct. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/** The statuses that mean "look somewhere else", and the `Location` header that says where. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * The headers that carry a credential, and the ones a redirect must never take to another
 * origin.
 *
 * `authorization` is what the fetch spec strips on a cross-origin redirect; the rest are the
 * headers the providers openharness speaks to authenticate with (Azure's `api-key`,
 * Anthropic's `x-api-key`, Gemini's `x-goog-api-key`), plus the two that are just as much the
 * caller's to keep (`cookie`, `proxy-authorization`). All comparisons are case-insensitive,
 * which is what `Headers` does.
 */
const CREDENTIAL_HEADERS: readonly string[] = [
  'authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'proxy-authorization',
]

/**
 * Make a request to a URL the user supplied, refusing anything that could reach a private
 * address — now, and again on every redirect hop.
 *
 * @param input the URL to fetch; a `Request` is not accepted, because its URL was not checked
 * @param init the `fetch` options; `redirect` is always forced to `manual`
 * @param options the per-call limits, the address option, and the test seams
 * @throws SafeFetchError when the URL is refused or a limit is hit
 */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  return (await safeFetchResult(input, init, options)).response
}

/**
 * What a {@link safeFetchResult} call produced: the response, and **where it finally came from**.
 *
 * The URL is the last hop's, after every redirect the guard followed and re-checked, which is
 * what a caller that must tell its reader where a page came from needs — `web_fetch` reports it
 * (#305). A `Response` carries no `url` of its own here: the guard builds a new one around the
 * capped body, and the address that was actually checked is the guard's to report, not
 * undici's.
 */
export interface SafeFetchResult {
  /** The response, with its body already capped and watched for a stall. */
  readonly response: Response
  /** The URL of the hop that answered, after redirects. */
  readonly url: string
}

/**
 * {@link safeFetch}, answering the final URL beside the response.
 *
 * The same request and the same guard — this is not a second way to fetch, it is the one way
 * with one more fact returned. {@link safeFetch} is the wrapper for a caller that does not need
 * the address.
 *
 * @param input the URL to fetch; a `Request` is not accepted, because its URL was not checked
 * @param init the `fetch` options; `redirect` is always forced to `manual`
 * @param options the per-call limits, the address option, and the test seams
 * @throws SafeFetchError when the URL is refused or a limit is hit
 */
export async function safeFetchResult(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const limits: Limits = {
    maxBytes: options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes,
    idleTimeoutMs: options.idleTimeoutMs === undefined ? null : options.idleTimeoutMs,
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs
  const resolver = options.resolver ?? defaultResolver
  const transport = options.transport ?? defaultTransport

  const headerInit = init.headers
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body as Body
  // The caller's signal plus the deadline, so a `timeoutMs` fires whether the call is waiting
  // for headers or reading a body: an aborted signal aborts a body read too.
  const signal = withTimeout(init.signal, timeoutMs)

  let current = typeof input === 'string' ? input : input.href
  // Whether a hop has already left the origin the request started on. Once one has, the
  // caller's credential headers are gone for the rest of the call: a redirect chain that comes
  // back to the original origin must not pick them up again.
  let leftOrigin = false
  for (let hop = 0; ; hop += 1) {
    const url = parseUrl(current)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (!options.allowPrivate && isMetadataHostname(hostname)) {
      throw new SafeFetchError('metadata_host', `${hostname} is a cloud metadata host`)
    }
    // An address literal is not resolved: it is already the address the guard must judge, and
    // asking a resolver to hand it back would only be a lookup that could answer something
    // else.
    const addresses =
      parseIpAddress(hostname) === null ? await resolveHost(resolver, hostname) : [hostname]
    if (!options.allowPrivate) {
      assertAddressesAllowed(hostname, addresses)
    }

    const headers = new Headers(headerInit)
    if (leftOrigin) {
      stripCredentialHeaders(headers)
    }

    const response = await transport(url.href, {
      method,
      headers,
      body,
      signal,
      redirect: 'manual',
      addresses,
    })

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      // This hop is over. Release its body — and with it the socket the default transport
      // pinned for it — before a refusal or the next hop decides anything else.
      await discardBody(response)
      if (location === null) {
        throw new SafeFetchError(
          'invalid_redirect',
          `${url.href} answered ${response.status} without a Location header`,
        )
      }
      if (hop >= maxRedirects) {
        throw new SafeFetchError(
          'too_many_redirects',
          maxRedirects === 0
            ? `${url.href} answered ${response.status}, and this request does not follow redirects`
            : `${url.href} redirected more than ${maxRedirects} times`,
        )
      }
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new SafeFetchError('invalid_redirect', `${url.href} sent a malformed Location`)
      }
      if (next.origin !== url.origin) {
        leftOrigin = true
      }
      // Per the fetch spec: 303 always becomes a GET, a 301/302 on a POST becomes a GET, and
      // 307/308 keep the method and the body. A body the redirect keeps has to be sent a
      // second time — which a stream cannot do, so that is refused rather than resent.
      if (
        response.status === 303 ||
        (method === 'POST' && (response.status === 301 || response.status === 302))
      ) {
        method = 'GET'
        body = undefined
      } else if (isStreamBody(body)) {
        throw new SafeFetchError(
          'invalid_redirect',
          `${url.href} answered ${response.status}, which resends the request body, and the ` +
            `body is a stream that cannot be replayed`,
        )
      }
      current = next.href
      continue
    }
    return { response: guardBody(response, limits), url: url.href }
  }
}

/** Let go of a hop's response body; the default transport closes its socket with it. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The body is already gone; there is nothing left to release.
  }
}

/** Remove every credential header from a hop that has left the origin the call started on. */
function stripCredentialHeaders(headers: Headers): void {
  for (const name of CREDENTIAL_HEADERS) {
    headers.delete(name)
  }
}

/** Whether a body is a stream, and so cannot be sent a second time after a redirect. */
function isStreamBody(body: Body): boolean {
  return (
    body !== undefined &&
    body !== null &&
    typeof (body as { getReader?: unknown }).getReader === 'function'
  )
}

/** The URL a hop is about to be made to, or a refusal. */
function parseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SafeFetchError('invalid_url', `${JSON.stringify(value)} is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError(
      'invalid_protocol',
      `${url.protocol} is not allowed; only http and https are`,
    )
  }
  return url
}

/** Resolve a hostname, turning a resolver failure into a refusal rather than a crash. */
async function resolveHost(
  resolver: AddressResolver,
  hostname: string,
): Promise<readonly string[]> {
  let addresses: readonly string[]
  try {
    addresses = await resolver(hostname)
  } catch (error) {
    throw new SafeFetchError(
      'dns_failure',
      `could not resolve ${hostname}: ${error instanceof Error ? error.message : 'the lookup failed'}`,
    )
  }
  if (addresses.length === 0) {
    throw new SafeFetchError('dns_failure', `${hostname} resolved to no addresses`)
  }
  return addresses
}

/** Refuse a hostname when any address it resolves to is one a request must not reach. */
function assertAddressesAllowed(hostname: string, addresses: readonly string[]): void {
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SafeFetchError(
        'blocked_address',
        `${hostname} resolves to ${address}, which is not a public address`,
      )
    }
  }
}

/** The lookup shape `node:net` declares — what undici's connector hands to the socket. */
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * A dispatcher for **one hop**, whose connections to that hop's host are pinned to the
 * addresses the guard checked.
 *
 * This is what makes step 4 of the module doc real. The dispatcher is built per hop and owned
 * by the hop's request, so the answer it gives belongs to this call alone: two concurrent
 * calls to one hostname cannot overwrite each other's addresses, and a call with
 * `allowPrivate` cannot re-pin a host another call checked as public — the module-global map
 * this replaced could do both.
 *
 * The lookup answers the checked hostname from the approved list and **refuses every other
 * name** rather than resolving it, so an unchecked answer can never reach a socket. The one
 * exception is a host the environment names as the egress proxy: that socket belongs to the
 * deployment, undici's proxy path resolves it the same way, and behind a proxy the pin is the
 * thing that is given up (see the module doc).
 */
function pinnedDispatcher(hostname: string, addresses: readonly string[]): EnvHttpProxyAgent {
  const checked = normalizeHostname(hostname)
  const pinned: LookupAddress[] = addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }))
  const proxies = configuredProxyHostnames()
  const lookup = (name: string, options: LookupOptions, callback: LookupCallback): void => {
    const asked = normalizeHostname(name)
    if (asked === checked) {
      answerLookup(pinned, options, callback)
      return
    }
    if (proxies.has(asked)) {
      dnsResolve(name, { all: true, verbatim: true }).then(
        (found) => answerLookup(found, options, callback),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), ''),
      )
      return
    }
    // A name the guard did not check is not a name this connection may reach. Answering it
    // with a fresh lookup is the rebinding this whole step exists to stop.
    callback(new Error(`${name} was not checked, so it will not be resolved`), '')
  }
  return new EnvHttpProxyAgent({ connect: { lookup } })
}

/**
 * Answer a lookup in the shape it asked for.
 *
 * Node calls the lookup with `all: true` when `autoSelectFamily` is on (the default) and with a
 * bare address otherwise, so both shapes are answered.
 */
function answerLookup(
  addresses: readonly LookupAddress[],
  options: LookupOptions,
  callback: LookupCallback,
): void {
  if (options.all === true) {
    callback(null, [...addresses])
    return
  }
  const first = addresses[0]
  callback(null, first?.address ?? '', first?.family)
}

/** A hostname as a lookup key: lowercased, without a trailing dot or IPv6 brackets. */
function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '')
}

/**
 * The hosts the environment's egress-proxy variables name — the only names a pinned lookup
 * resolves afresh.
 *
 * Read per dispatcher rather than cached, so a process that sets or clears the variables (a
 * test, a sandbox) is honoured. A value that is not a URL is skipped, as undici's own proxy
 * path would not use it either.
 */
function configuredProxyHostnames(): ReadonlySet<string> {
  const hosts = new Set<string>()
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY']) {
    const value = process.env[name]
    if (value === undefined || value === '') {
      continue
    }
    try {
      hosts.add(normalizeHostname(new URL(value).hostname))
    } catch {
      // Not a URL: nothing undici would proxy through either.
    }
  }
  return hosts
}

/**
 * undici's `fetch`, declared with the platform's own `fetch` types.
 *
 * Node's globals and the `undici` package each ship a declaration of `fetch`, and the two
 * disagree about `Headers` and `Blob` — same implementation, different `.d.ts` files. This is
 * the single place the two meet, and the cast adds the one thing only undici knows about: the
 * per-request `dispatcher` the socket is pinned with.
 */
const dispatcherFetch = undiciFetch as unknown as (
  url: string,
  init: RequestInit & { dispatcher: Dispatcher },
) => Promise<Response>

/**
 * The default transport: undici's `fetch` over a dispatcher built for this one hop.
 *
 * The dispatcher is pinned to the addresses the guard approved for the hop ({@link
 * pinnedDispatcher}) and closed when the response is finished — body read whole, failed or
 * cancelled — so no socket and no pin outlives the call. A response with no body is already
 * finished and closes at once.
 */
const defaultTransport: SafeFetchTransport = async (url, init) => {
  const dispatcher = pinnedDispatcher(new URL(url).hostname, init.addresses)
  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    // Closing is idempotent and never throws: a second caller joining the first, a dispatcher
    // that has already gone, both resolve.
    closing ??= dispatcher.close().then(
      () => undefined,
      () => undefined,
    )
    return closing
  }

  let response: Response
  try {
    response = await dispatcherFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      redirect: init.redirect,
      dispatcher,
    })
  } catch (error) {
    await close()
    throw error
  }
  return settleDispatcher(response, close)
}

/**
 * The response, with `close` run once its body has finished, failed or been cancelled.
 *
 * This is the transport's half of "no socket outlives the call": the guard's own
 * {@link guardBody} wrapper composes over the stream this returns, so a body it caps, errors
 * on a stall or the caller cancels all propagate down and close the connection.
 */
function settleDispatcher(response: Response, close: () => Promise<void>): Response {
  const body = response.body
  if (body === null) {
    void close()
    return response
  }
  const reader = body.getReader()
  let finished = false
  const finish = async (): Promise<void> => {
    if (finished) {
      return
    }
    finished = true
    await close()
  }
  const settled = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          // The connection is closed before the stream ends, so a caller that has read the
          // whole body knows the socket is already gone.
          await finish()
          controller.close()
          return
        }
        controller.enqueue(result.value)
      } catch (error) {
        await finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        await finish()
      }
    },
  })
  return new Response(settled, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** The default resolver: every address `node:dns` has for the name. */
const defaultResolver: AddressResolver = async (hostname) => {
  const addresses = await dnsResolve(hostname, { all: true, verbatim: true })
  return addresses.map((entry) => entry.address)
}

/** The caller's signal and a deadline, as one signal. Either aborting aborts the request. */
function withTimeout(
  signal: AbortSignal | null | undefined,
  timeoutMs: number | null,
): AbortSignal {
  const deadline = timeoutMs === null ? null : AbortSignal.timeout(timeoutMs)
  if (signal === null || signal === undefined) {
    return deadline ?? new AbortController().signal
  }
  return deadline === null ? signal : AbortSignal.any([signal, deadline])
}

/**
 * The same response, with its body capped in bytes and watched for a stall.
 *
 * A response with no body, and one whose limits are both off, come back untouched. Otherwise
 * the body is read through this wrapper and a **new** `Response` is built around it, so the
 * guard travels with the body wherever the caller takes it (`json()`, `text()`, the stream
 * itself) — the AI SDK reads a provider response exactly that way.
 */
function guardBody(response: Response, limits: Limits): Response {
  const body = response.body
  if (body === null || NULL_BODY_STATUSES.has(response.status)) {
    return response
  }
  if (limits.maxBytes === null && limits.idleTimeoutMs === null) {
    return response
  }
  const reader = body.getReader()
  let received = 0
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await withIdleTimeout(reader.read(), limits.idleTimeoutMs)
        if (result.done) {
          controller.close()
          return
        }
        received += result.value.byteLength
        if (limits.maxBytes !== null && received > limits.maxBytes) {
          void reader.cancel().catch(() => undefined)
          controller.error(
            new SafeFetchError(
              'too_large',
              `the response is larger than the ${limits.maxBytes}-byte limit`,
            ),
          )
          return
        }
        controller.enqueue(result.value)
      } catch (error) {
        void reader.cancel().catch(() => undefined)
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * `reading`, rejected with a {@link SafeFetchError} when nothing arrives for `idleTimeoutMs`.
 *
 * The timer is cleared the moment the read settles either way, so a healthy stream pays one
 * `setTimeout` per chunk and nothing else. A caller's abort needs no handling here: the signal
 * is tied to the request, so an abort rejects the read itself.
 */
function withIdleTimeout<T>(reading: Promise<T>, idleTimeoutMs: number | null): Promise<T> {
  if (idleTimeoutMs === null) {
    return reading
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SafeFetchError('idle_timeout', `no data for ${idleTimeoutMs}ms`))
    }, idleTimeoutMs)
    reading.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

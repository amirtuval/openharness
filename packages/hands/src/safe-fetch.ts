/**
 * `safeFetch`: the one way openharness makes an outbound request to a URL a **user** supplied
 * (epic #245, A3a).
 *
 * Everything else the server fetches is a constant URL it wrote itself (the model-catalogue
 * adapters, the key-validation requests), so there is no address to choose and nothing to
 * guard. A provider credential's endpoint is different: an Azure OpenAI endpoint is typed by
 * the user, and a URL the user chose is exactly what an SSRF guard is for. `safeFetch` is that
 * guard, and it is built here — in `@openharness/hands`, its first real code — because the
 * tools' own `web_fetch` will reuse it (epic #245, decision M1).
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
 * 4. **Connect to the address that was checked.** The dispatcher's `connect.lookup` answers
 *    from the addresses step 3 approved, so the connection cannot be re-resolved — a second
 *    lookup cannot rebind the name to an internal address between the check and the connect.
 *    SNI and the `Host` header stay the original hostname; only the socket's address is pinned.
 * 5. **Redirects, one hop at a time.** `redirect: 'manual'` means undici never follows a
 *    `Location` for us, so steps 1–4 run again for every hop, and a redirect to a private
 *    address is refused exactly as a direct one is. The number of hops is capped.
 * 6. **Limits.** A response body is capped in bytes and a call in total time — per call, because
 *    a save-time check and a model request want very different numbers (see
 *    {@link SAVE_TIME_LIMITS} and {@link STREAMING_LIMITS}).
 *
 * ## The egress proxy
 *
 * A deployment that reaches the internet through a proxy sets `HTTP_PROXY` / `HTTPS_PROXY` /
 * `NO_PROXY`. `catalog/provider-fetch.ts` in the server reads them through undici's
 * {@link EnvHttpProxyAgent} for the catalogue's constant URLs; `safeFetch` uses the same agent,
 * so a proxied deployment works with no extra flag, and with no proxy configured it is an
 * ordinary direct connection.
 *
 * Through a proxy the **check still runs on the target host** (steps 1–3, which is the half
 * that matters), but the *pin* does not: an HTTP proxy resolves the target itself and there is
 * no way to hand it an address to connect to, so the connection step belongs to the proxy. A
 * direct connection pins. Which is why the range check is unconditional and the pin is what
 * the proxy path gives up — the check is the guard, the pin is the hardening on top of it.
 * `NO_PROXY` is honoured by the agent: a host the deployment exempts is connected to directly,
 * and then it is pinned like any other.
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
  /** How many redirects may be followed, each re-checked. Defaults to {@link DEFAULT_MAX_REDIRECTS}. */
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
 * same deadline the catalogue's own calls carry (C1).
 */
export const SAVE_TIME_LIMITS = {
  maxBytes: 1024 * 1024,
  timeoutMs: 10_000,
  idleTimeoutMs: null,
} as const satisfies SafeFetchOptions

/**
 * The limits a **streaming model call** uses: no total deadline and no size cap.
 *
 * A model streams a long reply, and a cap on either would cut a legitimate answer. What is
 * still bounded is an idle stream: {@link STREAMING_IDLE_TIMEOUT_MS} without a single byte is
 * a hung connection, not a slow answer. The caller passes its own abort signal for the cases
 * only it knows about (a user pressing stop).
 */
export const STREAMING_LIMITS = {
  maxBytes: null,
  timeoutMs: null,
  idleTimeoutMs: 120_000,
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
    pinAddresses(hostname, addresses)

    const headers = new Headers(headerInit)
    const response = await transport(url.href, {
      method,
      headers,
      body,
      signal,
      redirect: 'manual',
    })

    const location = response.headers.get('location')
    if (REDIRECT_STATUSES.has(response.status)) {
      if (location === null) {
        throw new SafeFetchError(
          'invalid_redirect',
          `${url.href} answered ${response.status} without a Location header`,
        )
      }
      if (hop >= maxRedirects) {
        throw new SafeFetchError(
          'too_many_redirects',
          `${url.href} redirected more than ${maxRedirects} times`,
        )
      }
      // Per the fetch spec: 303 always becomes a GET, a 301/302 on a POST becomes a GET, and
      // 307/308 keep the method and the body. A body that cannot be sent twice (a stream) is
      // dropped with the redirect rather than reused.
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new SafeFetchError('invalid_redirect', `${url.href} sent a malformed Location`)
      }
      if (
        response.status === 303 ||
        (method === 'POST' && (response.status === 301 || response.status === 302))
      ) {
        method = 'GET'
        body = undefined
      }
      current = next.href
      continue
    }
    return guardBody(response, limits)
  }
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

/**
 * The `connect.lookup` undici hands the socket, and the addresses each checked host resolved to.
 *
 * This is what makes step 4 of the module doc real: the socket is opened at the address the
 * guard approved, never at whatever a second DNS lookup would return. A host that is not in the
 * map — the proxy, or a host some other caller connects to — is resolved ordinarily.
 */
const pinnedAddresses = new Map<string, LookupAddress[]>()

function pinAddresses(hostname: string, addresses: readonly string[]): void {
  pinnedAddresses.set(
    hostname.toLowerCase(),
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  )
}

/** One dispatcher for the process, built on first use with the environment it started in. */
let proxyDispatcher: EnvHttpProxyAgent | null = null

function dispatcher(): Dispatcher {
  proxyDispatcher ??= new EnvHttpProxyAgent({ connect: { lookup: pinnedLookup } })
  return proxyDispatcher
}

/**
 * The lookup undici's connector calls for a new socket.
 *
 * A pinned host answers with the addresses the guard checked; anything else — the proxy's own
 * host, a host never passed through {@link safeFetch} — is resolved with the ordinary resolver.
 * Node calls this with `all: true` when `autoSelectFamily` is on (the default) and with a bare
 * address otherwise, so both shapes are answered.
 */
/** The lookup shape `node:net` declares — what undici's connector hands to the socket. */
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

function pinnedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  const pinned = pinnedAddresses.get(hostname.toLowerCase())
  const answer = (addresses: readonly LookupAddress[]): void => {
    if (options.all === true) {
      callback(null, [...addresses])
      return
    }
    const first = addresses[0]
    callback(null, first?.address ?? '', first?.family)
  }
  if (pinned !== undefined && pinned.length > 0) {
    answer(pinned)
    return
  }
  dnsResolve(hostname, { all: true, verbatim: true }).then(answer, (error: unknown) => {
    // A failed lookup is reported with an empty address: the error is the answer, and the
    // callback's own type requires one either way.
    callback(error instanceof Error ? error : new Error(String(error)), '')
  })
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
 * The default transport: undici's `fetch` over the pinned, proxy-aware dispatcher.
 *
 * Every request carries {@link dispatcher}, whose `connect.lookup` answers from the addresses
 * the guard approved — which is what makes step 4 of the module doc real.
 */
const defaultTransport: SafeFetchTransport = (url, init) =>
  dispatcherFetch(url, { ...init, dispatcher: dispatcher() })

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

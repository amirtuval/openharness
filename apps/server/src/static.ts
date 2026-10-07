import { readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

/**
 * Serving a built web app from a directory, for `OPENHARNESS_WEB_DIR`.
 *
 * The server is the web app's origin in the single-binary deployment: `apps/web` builds to a
 * folder of static files, the server hands them out at `/`, and the app talks to `/v1` on the
 * same origin — which is also what makes an API key optional in that setup, since there is no
 * cross-origin request to make.
 *
 * Two rules for *what* is served, and nothing else:
 *
 * - a request that names a file in the directory gets that file;
 * - any other read that is not under `/v1` gets `index.html`, because the web app routes with
 *   the URL hash and only ever asks the server for `/` and its assets.
 *
 * A **read** is `GET` or its bodyless twin `HEAD` (#196): a link checker, an uptime probe or a
 * CDN revalidating an entry asks the same question with `HEAD`, and answering it `404` here
 * would both be a lie and stop Cloud CDN from caching a file the `GET` serves.
 *
 * ## Caching (#151, deployment epic #148)
 *
 * The deployment puts Cloud CDN in front of this origin (`cacheMode: USE_ORIGIN_HEADERS`), so
 * every response here has to say what it is worth. Three classes, decided by the file that is
 * actually served — a request for a missing asset falls back to the shell and is cached like
 * the shell:
 *
 * - **content-hashed assets** (what Vite emits under `assets/`): the name changes with the
 *   bytes, so a year of `immutable` is safe and is what makes a deploy invisible to the CDN;
 * - **`index.html`**, the shell a route loads: `no-cache` — it may be stored, but never
 *   reused without asking this server again, because the asset names inside it change on
 *   every deploy;
 * - **everything else at the root** (favicon, manifest, images): a short public max-age — not
 *   hashed, so a deploy may change it, but not so short that a CDN re-fetch is pointless.
 *
 * Nothing here is user-specific — the files are the same for everyone — so these are the only
 * cache directives this module has to get right.
 */

/** What a file extension is served as. Anything else is bytes. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/** The file a directory is served as, and the fallback for a path that names none. */
const INDEX_FILE = 'index.html'

/** The `assets` folder Vite writes content-hashed files to by default. */
const ASSETS_DIR = 'assets'

/** A year, immutable: the file name contains a hash of the file, so it can never change. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

/** Revalidate every time: the shell names the hashed assets, which change on a deploy. */
const SHELL_CACHE = 'no-cache'

/** An hour: a root file that is not hashed, so a deploy may change it under this name. */
const SHORT_CACHE = 'public, max-age=3600'

/**
 * What the file served from `relativePath` (relative to the web directory) may say about
 * caching — the three classes in the module comment, applied.
 */
export function cacheControlFor(relativePath: string): string {
  const normalized = relativePath.split(sep).join('/')
  if (normalized.startsWith(`${ASSETS_DIR}/`)) {
    return IMMUTABLE_CACHE
  }
  if (extname(normalized).toLowerCase() === '.html') {
    // `index.html`, the SPA fallback, and any stray page: all name hashed assets and all
    // have to be revalidated, whatever their path.
    return SHELL_CACHE
  }
  return SHORT_CACHE
}

/** The `content-type` of a path, from its extension. */
export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Read one file out of the web directory.
 *
 * @param root the directory `OPENHARNESS_WEB_DIR` points at
 * @param requestPath the request path, percent-encoded, as it arrived
 * @param method the request's method; `HEAD` is served the same file as `GET`, with the same
 *   status and the same headers, and no body (#196)
 * @returns the file's response, `index.html` for a path that names no file, or `null` when
 *   there is no index either — which is what leaves the request to the API's 404
 */
export async function serveWebAsset(
  root: string,
  requestPath: string,
  method: string,
): Promise<Response | null> {
  const withBody = method !== 'HEAD'
  const directory = resolve(root)
  const target = resolveTarget(directory, requestPath)
  if (target !== null) {
    const file = await fileTarget(target)
    if (file !== null) {
      return fileResponse(directory, file, withBody)
    }
  }
  // The web app routes on the hash, so every other path is the app itself: hand it the shell
  // and let it decide what to render.
  return fileResponse(directory, join(directory, INDEX_FILE), withBody)
}

/**
 * The absolute path a request maps to, or `null` when it escapes the directory.
 *
 * A path that climbs out of the web root — `../`, an encoded `%2e%2e`, an absolute path — is
 * refused rather than resolved: the server has no business reading files it was not asked to
 * serve.
 */
function resolveTarget(directory: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) {
    return null
  }
  const target = resolve(directory, decoded.replace(/^\/+/, ''))
  if (target !== directory && !target.startsWith(directory + sep)) {
    return null
  }
  return target
}

/** `target` when it is a readable file, or the `index.html` inside it when it is a directory. */
async function fileTarget(target: string): Promise<string | null> {
  try {
    const info = await stat(target)
    if (info.isDirectory()) {
      const index = join(target, INDEX_FILE)
      return (await stat(index)).isFile() ? index : null
    }
    return info.isFile() ? target : null
  } catch {
    return null
  }
}

/**
 * Read one file of the web directory into a response, or `null` when it is not there.
 *
 * `path` is always inside `directory` (`resolveTarget` and the fallback built it), so the
 * cache class can be read off the path relative to the directory: the *served* file decides
 * it, not the requested path.
 *
 * With `withBody` false the file is still read — `content-length` is one of the headers a
 * `HEAD` has to answer with — but the response carries no body, which is the only difference
 * between the two reads (#196).
 */
async function fileResponse(
  directory: string,
  path: string,
  withBody: boolean,
): Promise<Response | null> {
  let body: Uint8Array<ArrayBuffer>
  try {
    body = new Uint8Array(await readFile(path))
  } catch {
    return null
  }
  return new Response(withBody ? body : null, {
    status: 200,
    headers: {
      'content-type': contentTypeOf(path),
      'content-length': String(body.byteLength),
      'cache-control': cacheControlFor(relative(directory, path)),
    },
  })
}

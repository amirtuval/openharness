import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

/**
 * Serving a built web app from a directory, for `OPENHARNESS_WEB_DIR`.
 *
 * The server is the web app's origin in the single-binary deployment: `apps/web` builds to a
 * folder of static files, the server hands them out at `/`, and the app talks to `/v1` on the
 * same origin — which is also what makes an API key optional in that setup, since there is no
 * cross-origin request to make.
 *
 * Two rules, and nothing else:
 *
 * - a request that names a file in the directory gets that file;
 * - any other GET that is not under `/v1` gets `index.html`, because the web app routes with
 *   the URL hash and only ever asks the server for `/` and its assets.
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

/** The `content-type` of a path, from its extension. */
export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Read one file out of the web directory.
 *
 * @param root the directory `OPENHARNESS_WEB_DIR` points at
 * @param requestPath the request path, percent-encoded, as it arrived
 * @returns the file's response, `index.html` for a path that names no file, or `null` when
 *   there is no index either — which is what leaves the request to the API's 404
 */
export async function serveWebAsset(root: string, requestPath: string): Promise<Response | null> {
  const directory = resolve(root)
  const target = resolveTarget(directory, requestPath)
  if (target !== null) {
    const file = await fileTarget(target)
    if (file !== null) {
      return fileResponse(file, contentTypeOf(file))
    }
  }
  // The web app routes on the hash, so every other path is the app itself: hand it the shell
  // and let it decide what to render.
  const index = join(directory, INDEX_FILE)
  return fileResponse(index, contentTypeOf(INDEX_FILE))
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

/** Read a file into a response, or `null` when it is not there. */
async function fileResponse(path: string, contentType: string): Promise<Response | null> {
  let body: Uint8Array<ArrayBuffer>
  try {
    body = new Uint8Array(await readFile(path))
  } catch {
    return null
  }
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.byteLength),
  }
  if (contentType.startsWith('text/html')) {
    // A rebuilt app must not be served from a cache: the asset names inside it change.
    headers['cache-control'] = 'no-cache'
  }
  return new Response(body, { status: 200, headers })
}

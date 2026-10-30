/**
 * A git repository served over smart HTTP on loopback, for tests (epic #349, K3).
 *
 * The import's clone is a conversation with a git server, and the only honest way to test it
 * is to have one: this fixture builds a repository from a map of files, serves it the way a
 * forge does (`GET /info/refs?service=git-upload-pack` for the advert, `POST /git-upload-pack`
 * for the packfile), and answers the URL of a clone. A test can then drive the **real**
 * `cloneRepository` — the real `isomorphic-git`, the real `safeFetch` guard, a real
 * packfile — against it, with no internet, no forge account and no flakiness, and it can
 * {@link GitFixture.commit} again to move the branch for a refresh test.
 *
 * It is exported from `@openharness/hands/testing` rather than kept inside one test file
 * because three suites want it: this package's clone tests, the server's import routes, and
 * the end-to-end QA specs of #355. What is *not* reusable is the network: a fixture is one
 * loopback listener, started and closed by the test that asks for it.
 *
 * ## Why the `git` binary
 *
 * The served side is real `git` — `git upload-pack --stateless-rpc`, which is exactly what
 * `git http-backend` runs — because the *client* is what is under test. Writing a packfile by
 * hand would test `isomorphic-git` against our own idea of the format rather than against
 * git's, and the one thing a fixture must not do is agree with a bug. So this module needs a
 * `git` executable on the path ({@link gitAvailable} says whether there is one), and a suite
 * that needs it skips itself with a note when there is not — the same rule the Postgres suites
 * follow for a database.
 *
 * Nothing here is in the import's path: the implementation never spawns a process (K3), and
 * this file is a test helper, imported by tests alone.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The files of a repository, by path from its root.
 *
 * A string is written as UTF-8 text. A `Uint8Array` is written as its bytes — which is how a
 * fixture holds a file that is not text at all (a PNG, a font): a JavaScript string cannot
 * carry invalid UTF-8, so a binary fixture has to be bytes rather than a string that happens
 * to contain a NUL.
 */
export type GitFileMap = Readonly<Record<string, string | Uint8Array>>

/** What {@link createGitFixture} is asked for. */
export interface GitFixtureOptions {
  /** The first commit's files; `{}` by default, which is a repository with an empty root. */
  readonly files?: GitFileMap
  /** The branch every commit lands on; `main` by default. */
  readonly branch?: string
  /** The name and address git records as the committer; a fixture's own by default. */
  readonly author?: { readonly name: string; readonly email: string }
}

/** A repository served on loopback, and the moves a test makes on it. */
export interface GitFixture {
  /**
   * The URL to clone: `http://127.0.0.1:<port>/<name>.git`.
   *
   * `http`, not `https`, and loopback — which is what a test needs and what an import would
   * never be handed (K3 wants `https`, and the guard refuses a loopback address unless the
   * self-host flag allows it). A test driving the clone passes `allowPrivate: true`; one
   * testing the guard's refusal passes it `false` and expects a refusal.
   */
  readonly url: string
  /** The directory the repository really lives in — for a test that wants to inspect it. */
  readonly directory: string
  /** Rewrite the working tree to exactly `files` and commit; answers the new commit sha. */
  commit(files: GitFileMap, message?: string): Promise<string>
  /** Point a lightweight tag at a commit (`HEAD` by default); for a ref that is a tag. */
  tag(name: string, at?: string): Promise<void>
  /** Create a branch at a commit (`HEAD` by default); for a ref that is a branch. */
  branch(name: string, at?: string): Promise<void>
  /** The branch's current commit sha. */
  head(): Promise<string>
  /** Stop the listener and delete the repository. Idempotent. */
  close(): Promise<void>
}

/** Whether a `git` executable is on the path — the fixture skips itself without one. */
export async function gitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/**
 * Build a repository from `options.files` and serve it on a loopback port.
 *
 * @throws Error when no `git` is on the path — a suite should ask {@link gitAvailable} first
 *   and skip rather than fail
 */
export async function createGitFixture(options: GitFixtureOptions = {}): Promise<GitFixture> {
  if (!(await gitAvailable())) {
    throw new Error('the git fixture needs a `git` executable on the path')
  }
  const branch = options.branch ?? 'main'
  const author = options.author ?? { name: 'openharness test', email: 'test@example.com' }
  const directory = await mkdtemp(join(tmpdir(), 'openharness-git-'))
  const name = 'skills.git'

  const repo = (...args: string[]): Promise<string> =>
    run('git', [
      '-C',
      directory,
      '-c',
      'commit.gpgsign=false',
      '-c',
      `user.name=${author.name}`,
      '-c',
      `user.email=${author.email}`,
      ...args,
    ])

  await repo('init', '-q', '--initial-branch', branch)
  await writeTree(directory, options.files ?? {})
  await commitAll(repo, 'the first commit')

  const server = createServer((request, response) => {
    handle(request, response, directory, name).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
      }
      response.end()
    })
  })
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}/${name}`

  return {
    url,
    directory,

    async commit(files, message = 'another commit') {
      await writeTree(directory, files)
      return commitAll(repo, message)
    },

    async tag(tagName, at) {
      await repo('tag', tagName, at ?? 'HEAD')
    },

    async branch(branchName, at) {
      await repo('branch', branchName, at ?? 'HEAD')
    },

    async head() {
      return (await repo('rev-parse', 'HEAD')).trim()
    },

    async close() {
      // A cloned connection may still be idle in keep-alive; close them so `close` does not
      // wait for a socket nobody is going to use again.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** Rewrite the tree to exactly `files`: everything else is deleted, so a commit can remove one. */
async function writeTree(directory: string, files: GitFileMap): Promise<void> {
  const kept = new Set<string>()
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    kept.add(path)
  }
  // Files the caller dropped from the map are removed from the working tree too, so a commit
  // that deletes a file really deletes it.
  await removeUnkept(directory, directory, kept)
}

/** Delete every file under `root` that `kept` does not name, keeping `.git` alone. */
async function removeUnkept(
  root: string,
  current: string,
  kept: ReadonlySet<string>,
): Promise<void> {
  for (const entry of await readdir(current)) {
    if (entry === '.git') {
      continue
    }
    const full = join(current, entry)
    const relative = full.slice(root.length + 1)
    const children = await readdir(full).catch(() => null)
    if (children === null) {
      if (!kept.has(relative)) {
        await rm(full, { force: true })
      }
      continue
    }
    if (![...kept].some((path) => path.startsWith(`${relative}/`))) {
      await rm(full, { recursive: true, force: true })
      continue
    }
    await removeUnkept(root, full, kept)
  }
}

/** `git add -A` and one commit; answers the commit sha. */
async function commitAll(
  repo: (...args: string[]) => Promise<string>,
  message: string,
): Promise<string> {
  await repo('add', '-A')
  await repo('commit', '-q', '--allow-empty', '-m', message)
  return (await repo('rev-parse', 'HEAD')).trim()
}

/** Serve one request the way `git http-backend` does, for the two endpoints a clone uses. */
async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
  name: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  // The two escape hatches a guard test needs: a hop that leaves the fixture, and one that
  // comes back to it. Everything else under the repository name is the real protocol.
  if (path.endsWith('/redirect/private/info/refs')) {
    // A hop that leaves the fixture for an address a deployment must not dial — the link-local
    // metadata service — so a test can prove the guard re-checks every redirect.
    response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
    response.end()
    return
  }
  if (path.endsWith('/redirect/self/info/refs')) {
    // A hop that comes back to the fixture, so a test can prove the guard follows one at all.
    response.writeHead(302, {
      location: path.replace('/redirect/self', '') + url.search,
    })
    response.end()
    return
  }
  if (path.includes('/stall/')) {
    // A server that accepts and never answers, for the deadline.
    return
  }

  if (!path.startsWith(`/${name}`)) {
    // What a host that is not a forge says: a page, not a git service.
    response.writeHead(404, { 'content-type': 'text/html' })
    response.end('<html><body>not a git repository</body></html>')
    return
  }

  if (path === `/${name}/info/refs`) {
    if (url.searchParams.get('service') !== 'git-upload-pack') {
      response.writeHead(403)
      response.end()
      return
    }
    const advert = await run('git', [
      'upload-pack',
      '--stateless-rpc',
      '--advertise-refs',
      directory,
    ])
    response.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'cache-control': 'no-cache',
    })
    // The v0 smart-HTTP advertisement: the service announcement, a flush packet, then git's own
    // ref advertisement.
    response.write(`001e# service=git-upload-pack\n0000`)
    response.end(Buffer.from(advert, 'binary'))
    return
  }

  if (path === `/${name}/git-upload-pack` && request.method === 'POST') {
    const body = await readBody(request)
    const pack = await run('git', ['upload-pack', '--stateless-rpc', directory], body)
    response.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'cache-control': 'no-cache',
    })
    response.end(Buffer.from(pack, 'binary'))
    return
  }

  response.writeHead(404)
  response.end()
}

/** Read a whole request body. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

/**
 * Run a program and answer its stdout as **binary**.
 *
 * `binary` rather than `utf8` on purpose: a packfile is bytes, and a decode/encode round trip
 * through a JavaScript string would corrupt it — a bug that only shows up on the repositories
 * whose deltas happen to hold invalid UTF-8.
 */
function run(command: string, args: readonly string[], input?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args])
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(' ')} exited ${code}: ${Buffer.concat(errors).toString('utf8')}`,
          ),
        )
        return
      }
      resolve(Buffer.concat(chunks).toString('binary'))
    })
    if (input !== undefined) {
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })
}

/** The port the listener got, once it is accepting. */
function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the git fixture got no port'))
        return
      }
      resolve(address.port)
    })
  })
}

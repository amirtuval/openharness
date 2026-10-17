import { readFileSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { fileURLToPath } from 'node:url'

import { createGitFixture, gitAvailable } from '@openharness/hands/testing'
import type { GitFixture, GitFileMap } from '@openharness/hands/testing'

/**
 * The skills pass's repository, shared by the web spec (W30) and the `oh` spec (C-skills).
 *
 * Both QA specs of #355 import from the same collection repository over a **loopback** git
 * server, so the pass needs no network and no forge account — and, because a repository must be
 * moved for a refresh to have anything to show, the fixture is the only way to drive the second
 * half of K5 at all (`@openharness/hands/testing` is where the reader is; this module is the one
 * copy of the files, so the two specs cannot drift).
 *
 * ## The collection
 *
 * Six candidates, which is every kind of candidate the preview has an opinion about:
 *
 * | folder             | what it is                                                       |
 * | ------------------ | ---------------------------------------------------------------- |
 * | `release-notes`    | valid, with a `references/` and a `scripts/` folder, and a hint   |
 * | `summarize-thread` | valid, `disable-model-invocation: true` (K1: the reader's own)    |
 * | `house-style`      | valid, `user-invocable: false` (K1: the model's own)              |
 * | `broken-skill`     | **invalid** — its frontmatter names a folder that is not its own  |
 * | `huge-skill`       | **oversized** — a `SKILL.md` past the 20 KB cap of K4             |
 * | `compact`          | a **reserved** name — `compact` is a built-in slash command (K7)  |
 *
 * So three candidates are importable and three are not, and the preview has to say why for each
 * of the three. A root `SKILL.md` is deliberately absent: one would be a seventh candidate,
 * named for the repository, and the rule that reads it is `skills-import.test.ts`'s.
 *
 * ## The https front
 *
 * The import route takes an `https://` URL and nothing else (K3) while `createGitFixture` serves
 * plain HTTP, so this module puts a TLS-terminating proxy in front of it — the same machinery
 * `e2e/fixtures/skills-https/` exists for. The stack must trust that fixture's CA
 * (`NODE_EXTRA_CA_CERTS=<repo>/e2e/fixtures/skills-https/ca.pem`) and must allow a private
 * address (`OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1`); without the second one every import is
 * refused before it is attempted, which is exactly what S5's refusal half then proves.
 *
 * The front answers under an `/org/skills.git` path rather than at `/skills.git` because
 * `parseGitUrl` only reads a browse URL's `tree` separator from the third path segment on — a
 * marker with no `owner/repo` in front of it is a repository's own name. `/org/skills.git` is
 * what makes `…/org/skills.git/tree/main/skills/release-notes` split into a ref and a path with
 * no network, so S2 runs on the fixture like every other case.
 */

/** The repository the fixture serves: the collection above, one folder per candidate. */
export const SKILLS_FILES: GitFileMap = {
  'skills/release-notes/SKILL.md': [
    '---',
    'name: release-notes',
    'description: Writes the release notes for a version from the commits since the last tag.',
    'argument-hint: version',
    '---',
    '',
    '# Release notes',
    '',
    'Write the release notes for $ARGUMENTS, one paragraph per change.',
    '',
    'Read `references/tone.md` before you write a word of it, and follow the tone it asks for.',
    'Never run `scripts/publish.sh`: nothing in a skill folder is executed here.',
    '',
  ].join('\n'),
  'skills/release-notes/references/tone.md':
    '# Tone\n\nPlain words, no marketing. One short paragraph per change.\n',
  'skills/release-notes/scripts/publish.sh':
    '#!/bin/sh\n# Publishes the notes. This build never runs it (K2).\necho publishing\n',
  'skills/summarize-thread/SKILL.md': [
    '---',
    'name: summarize-thread',
    'description: Summarizes a long thread into its decisions.',
    'disable-model-invocation: true',
    '---',
    '',
    '# Summarize a thread',
    '',
    'Read the thread and list its decisions.',
    '',
  ].join('\n'),
  'skills/house-style/SKILL.md': [
    '---',
    'name: house-style',
    'description: The wording and formatting rules every answer in this house follows.',
    'user-invocable: false',
    '---',
    '',
    '# House style',
    '',
    'Short sentences. No exclamation marks. Numbers as digits.',
    '',
  ].join('\n'),
  'skills/broken-skill/SKILL.md': [
    '---',
    'name: a-name-that-is-not-the-folder',
    'description: This one can never be imported, and the preview says why.',
    '---',
    '',
    '# Broken',
    '',
  ].join('\n'),
  'skills/huge-skill/SKILL.md': [
    '---',
    'name: huge-skill',
    'description: A `SKILL.md` past the 20 KB cap of K4, so the preview refuses it.',
    '---',
    '',
    '# Huge',
    '',
    // The cap is on the file (K4: `SKILL.md` <= 20 KB), so the padding is what makes this
    // candidate `over-limit`. `x `.repeat(11_000) is about 22 KB.
    'x '.repeat(11_000),
    '',
  ].join('\n'),
  'skills/compact/SKILL.md': [
    '---',
    'name: compact',
    'description: A folder whose name is a built-in command, so no import may take it.',
    '---',
    '',
    '# Compact',
    '',
  ].join('\n'),
}

/**
 * The same repository after one push: `SKILL.md` edited, one file added and one removed.
 *
 * All three of the diff's lists are exercised by one commit on purpose (K5) — a refresh whose
 * summary reads `1 file added, 1 file removed, 1 file changed` is the whole of what the screen
 * has to draw.
 */
export const SKILLS_FILES_CHANGED: GitFileMap = {
  ...without(SKILLS_FILES, 'skills/release-notes/scripts/publish.sh'),
  'skills/release-notes/SKILL.md': [
    '---',
    'name: release-notes',
    'description: Writes the release notes for a version from the commits since the last tag.',
    'argument-hint: version',
    '---',
    '',
    '# Release notes',
    '',
    'Write the release notes for $ARGUMENTS, one paragraph per change, newest first.',
    '',
    'Read `references/tone.md` before you write a word of it, and `references/format.md` for the',
    'shape the notes take.',
    '',
  ].join('\n'),
  'skills/release-notes/references/format.md':
    '# Format\n\nA heading per version, one bullet per change.\n',
}

/** A file map without one path — how the push's tree drops the script the first one carried. */
function without(files: GitFileMap, path: string): GitFileMap {
  return Object.fromEntries(Object.entries(files).filter(([key]) => key !== path))
}

/** The path prefix the https front answers under: what makes a browse URL splittable. */
export const FIXTURE_REPO_PATH = '/org/skills.git'

/** The folder each candidate lives in, so a spec names a case without repeating its path. */
export const CANDIDATE_PATHS = {
  'release-notes': 'skills/release-notes',
  'summarize-thread': 'skills/summarize-thread',
  'house-style': 'skills/house-style',
  'broken-skill': 'skills/broken-skill',
  'huge-skill': 'skills/huge-skill',
  compact: 'skills/compact',
} as const

/** The three candidates an import can really take; the other three carry problems. */
export const IMPORTABLE_CANDIDATES = ['release-notes', 'summarize-thread', 'house-style'] as const

/** A repository on loopback, fronted by https, ready for an import route to be pointed at. */
export interface SkillsRepo {
  /** The `https://` clone URL, as an import is given it. */
  readonly url: string
  /** The same repository, as a browse URL naming `path` at `ref` — the S2 shape. */
  browse(path: string, ref?: string): string
  /** Rewrite the working tree to exactly `files` and commit; answers the new commit sha. */
  commit(files: GitFileMap, message?: string): Promise<string>
  /** The branch's current commit sha. */
  head(): Promise<string>
  /** Stop the front and the fixture and delete the repository. Idempotent. */
  close(): Promise<void>
}

/**
 * The directory holding the front's certificate: `QA_SKILLS_FIXTURE_TLS`, or the committed
 * throwaway pair beside `e2e/fixtures/`.
 *
 * The stack trusts the CA at `e2e/fixtures/skills-https/ca.pem` (see that folder's README), so
 * the default is what a stack started per `e2e/AGENTS.md` already works with; the variable is
 * for a deployment whose trust store holds some other certificate, the same override
 * `QA_SKILLS_FIXTURE_TLS` always was.
 */
export function skillsFixtureTlsDir(): string {
  return (
    process.env.QA_SKILLS_FIXTURE_TLS ??
    fileURLToPath(new URL('../fixtures/skills-https', import.meta.url))
  )
}

/** Whether this machine can serve the fixture at all — it needs a real `git`. */
export const skillsFixtureAvailable = gitAvailable

/**
 * Start the collection repository, and an https front in front of it.
 *
 * @throws Error when there is no `git` on the path — ask {@link skillsFixtureAvailable} first
 *   and skip rather than fail, the rule every fixture-fuelled suite follows
 */
export async function startSkillsRepo(files: GitFileMap = SKILLS_FILES): Promise<SkillsRepo> {
  const repo = await createGitFixture({ files })
  const front = await httpsFront(repo, skillsFixtureTlsDir())
  return {
    url: front.url,
    browse(path, ref) {
      return `${front.url}/tree/${ref ?? 'main'}/${path}`
    },
    commit: (next, message) => repo.commit(next, message),
    head: () => repo.head(),
    async close() {
      await front.close()
      await repo.close()
    },
  }
}

/**
 * A TLS-terminating proxy in front of the fixture's plain-HTTP smart-HTTP server.
 *
 * Everything the git client sends is forwarded as it arrived — the handshake is a `GET
 * /info/refs` and a `POST /git-upload-pack`, and both have to reach the fixture's real server —
 * with the `/org` prefix dropped, so the product's URL is a browse-ready one and the fixture
 * still answers at its own path.
 *
 * @param repo the fixture to front
 * @param tlsDir the directory holding the certificate and its key
 */
async function httpsFront(
  repo: GitFixture,
  tlsDir: string,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const target = new URL(repo.url)
  const server: Server = createHttpsServer(
    {
      cert: readFileSync(`${tlsDir}/server.pem`),
      key: readFileSync(`${tlsDir}/server.key`),
    },
    (incoming, outgoing) => {
      // The fixture's own path inside whatever was asked for. A request that names no
      // repository is answered the way a host that is not a forge answers — a 404 — rather
      // than being forwarded as something the fixture would have to make sense of.
      const at = (incoming.url ?? '').indexOf(target.pathname)
      if (at === -1) {
        outgoing.writeHead(404, { 'content-type': 'text/plain' })
        outgoing.end('not a git repository')
        return
      }
      const forwarded = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: (incoming.url ?? '').slice(at),
          method: incoming.method,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
          answer.pipe(outgoing)
        },
      )
      forwarded.on('error', () => {
        outgoing.writeHead(502)
        outgoing.end()
      })
      incoming.pipe(forwarded)
    },
  )
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `https://127.0.0.1:${String(port)}${FIXTURE_REPO_PATH}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}

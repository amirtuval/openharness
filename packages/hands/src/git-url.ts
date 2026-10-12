/**
 * Reading the URL an import was given (epic #349, K3): the repository, and the ref and path
 * inside it.
 *
 * A user pastes one of two things. Most often a **browse URL** — the address bar of the page
 * they are looking at, `https://github.com/owner/repo/tree/main/skills/release-notes` or
 * `https://gitlab.com/group/project/-/tree/v1.2/skills` — which names all three of the things
 * an import needs and spells them the forge's way. Sometimes a plain **clone URL** —
 * `https://github.com/owner/repo` — which names only the repository. Both are turned into the
 * same three fields, so nothing downstream has to know which one it was, and a browse URL is
 * never passed to a clone: the `/tree/…` half is not something a git server serves.
 *
 * Three rules, all of them K3's ("Input: a public `https://` git URL") and all of them
 * enforced here rather than at the guard, because they are about what a user may *type* and
 * not about where a connection may go:
 *
 * - **`https://` only.** `git://`, `ssh://`, `http://` and `git@host:path` are refused — the
 *   last cannot even be parsed as a URL, and the others are schemes a public repository is not
 *   read over here. (A `http://` URL is refused by *this* function; {@link cloneRepository}
 *   itself accepts it, which is what lets a test drive a loopback fixture through the real
 *   guard — see the package's AGENTS.md.)
 * - **No credentials.** A URL carrying `user:token@` is refused rather than stripped: K3 is
 *   "private repositories are not supported, no credentials are sent", and silently dropping a
 *   token a user pasted would import *something else* while looking like it worked.
 * - **A repository, named.** A URL whose path is empty names no repository and is refused.
 *
 * The split of a browse URL follows the forge's own grammar, and takes the **first** segment
 * after `tree` as the ref. That is what git itself would do with a URL of this shape (a forge
 * cannot tell `main/foo` from a branch `main/foo` either — it resolves it against the refs it
 * has), and a user whose ref really holds a slash can say so explicitly: an explicit `ref` and
 * `path` are honoured over anything a browse URL implies.
 */

/** Why a URL was refused, as a stable code. */
export type GitUrlErrorCode =
  /** Not `https:` — `http`, `git`, `ssh`, `file`, or something that is not a URL at all. */
  | 'not_https'
  /** The URL carries a user name, password or token. */
  | 'credentials'
  /** The URL names no repository. */
  | 'no_repository'

/**
 * A URL this module refuses, with a stable {@link GitUrlErrorCode}.
 *
 * The message never repeats the credentials of a URL it refused, which is the one thing here
 * that could hold a secret.
 */
export class GitUrlError extends Error {
  /** What was wrong; see {@link GitUrlErrorCode}. */
  readonly code: GitUrlErrorCode

  constructor(code: GitUrlErrorCode, message: string) {
    super(message)
    this.name = 'GitUrlError'
    this.code = code
  }
}

/** Whether a value is the {@link GitUrlError} this module raises, across a bundle boundary. */
export function isGitUrlError(value: unknown): value is GitUrlError {
  if (value instanceof GitUrlError) {
    return true
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (value as Partial<GitUrlError>).name === 'GitUrlError'
}

/** A repository and the place inside it an import reads from: the three fields of K3. */
export interface GitSourceLocation {
  /** The `https://` URL a git server serves, ready to clone. */
  readonly url: string
  /** The branch, tag or commit a browse URL named, or `null` when it named none. */
  readonly ref: string | null
  /** The folder inside the repository a browse URL named, or `null` when it named none. */
  readonly path: string | null
}

/** One forge's browse-URL grammar: the segment that introduces a ref, and that it has no owner. */
interface ForgeGrammar {
  /** The path segment before a ref (`tree` on GitHub, `-` on GitLab). */
  readonly marker: string
  /** The word that follows GitLab's `-` marker. */
  readonly verb?: string
}

/**
 * The forges whose browse URLs are split, and the segment that introduces the ref.
 *
 * GitHub's is `/{owner}/{repo}/tree/{ref}/{path}` and GitLab's is
 * `/{namespace…}/{project}/-/tree/{ref}/{path}` — the `-` exists on GitLab precisely so a
 * group called `tree` cannot be mistaken for the separator, which is why the two cannot share
 * one rule.
 */
const FORGES: readonly ForgeGrammar[] = [{ marker: 'tree' }, { marker: '-', verb: 'tree' }]

/**
 * Read an import's URL into the repository, the ref and the path (K3).
 *
 * @param input the URL a user typed or pasted
 * @throws GitUrlError when it is not `https`, carries credentials, or names no repository
 */
export function parseGitUrl(input: string): GitSourceLocation {
  const trimmed = input.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new GitUrlError('not_https', 'A skill is imported from an `https://` git URL.')
  }
  if (parsed.protocol !== 'https:') {
    throw new GitUrlError('not_https', 'A skill is imported from an `https://` git URL.')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    // Never repeated in the message: a pasted URL may carry a token (K3 — no credentials are
    // sent, and a user should not leave one in a chat transcript either).
    throw new GitUrlError(
      'credentials',
      'The URL carries credentials; openharness imports public repositories only.',
    )
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0)

  // The **earliest** separator wins, whichever forge's grammar it is: a GitLab path
  // (`group/project/-/tree/main`) also contains a bare `tree` later on, and taking the first
  // match either way is what keeps the `-` out of the repository.
  const at = segments.findIndex((segment, index) => {
    // From index 2 on: a marker earlier than that would leave no `owner/repo` in front of it,
    // so a marker there is a repository's own name (`https://github.com/tree/main`) and not a
    // separator.
    if (index < 2) {
      return false
    }
    return FORGES.some(
      (forge) =>
        segment === forge.marker &&
        (forge.verb === undefined || segments[index + 1] === forge.verb),
    )
  })
  if (at !== -1) {
    const forge = FORGES.find((candidate) => segments[at] === candidate.marker)
    // The repository is everything before the marker, the ref is the first segment after it
    // (GitLab's marker is the `-` and its verb `tree`, which is one more to skip), and the
    // path is the rest.
    const repository = segments.slice(0, at)
    const after = segments.slice(at + 1 + (forge?.verb === undefined ? 0 : 1))
    const [ref, ...rest] = after
    if (repository.length === 0 || ref === undefined) {
      throw new GitUrlError(
        'no_repository',
        'That URL names no repository for openharness to import from.',
      )
    }
    return {
      url: `${parsed.origin}/${repository.join('/')}`,
      ref: decodeSegment(ref),
      path: rest.length === 0 ? null : decodeSegment(rest.join('/')),
    }
  }

  if (segments.length === 0) {
    throw new GitUrlError(
      'no_repository',
      'That URL names no repository for openharness to import from.',
    )
  }
  return { url: `${parsed.origin}/${segments.join('/')}`, ref: null, path: null }
}

/**
 * One URL segment, percent-decoded — a branch or folder name may hold a space or a `%`
 * (`release%20notes`).
 *
 * `decodeURIComponent` throws on a stray `%`, which is a URL that says nothing rather than a
 * reason to fail: the segment is then taken as it is written, and whatever it names is looked
 * up (and not found) downstream.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

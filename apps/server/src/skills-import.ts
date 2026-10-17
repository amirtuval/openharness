import {
  cloneRepository,
  isGitCloneError,
  isGitUrlError,
  parseGitUrl,
  repositoryName,
  type ClonedFile,
  type ClonedRepository,
  type CloneRepositoryOptions,
  type GitUrlErrorCode,
} from '@openharness/hands'
import {
  MAX_SKILL_FILES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_MAX_BYTES,
  SKILL_IMPORT_MESSAGES,
  SKILL_MAX_BYTES,
  SKILL_MD_FILENAME,
  SKILL_MD_MAX_BYTES,
  isReservedSkillName,
  isSkillName,
  skillFileSize,
  type PreviewSkillImportResponse,
  type RefreshSkillPreviewResponse,
  type Skill,
  type SkillFile,
  type SkillFrontmatter,
  type SkillId,
  type SkillImportFailure,
  type SkillImportRequest,
  type SkillImportSource,
  type SkillProblem,
  type SkillSource,
  type UserId,
} from '@openharness/protocol'
import {
  DuplicateSkillNameError,
  type SkillFileInput,
  type SkillSnapshotInput,
  type SkillStore,
} from '@openharness/session'
import { parse as parseYaml } from 'yaml'

import { diffSnapshots, skillMdDiff, type DiffableFile } from './skills-diff'

/**
 * Importing a skill from a public repository, and refreshing one (epic #349, K3/K5).
 *
 * This module is the whole of the server's half of the four routes that read a repository:
 *
 * ```
 * POST /v1/me/skills/import/preview        what a repository holds under a path — nothing stored
 * POST /v1/me/skills/import                the picked candidates, stored as skills
 * POST /v1/me/skills/{id}/refresh/preview  the stored source cloned again, diffed against the snapshot
 * POST /v1/me/skills/{id}/refresh          the confirmed commit, replacing the snapshot
 * ```
 *
 * Four decisions shape it, and they are the epic's:
 *
 * - **Import is two steps, and the server holds nothing between them** (K3). The preview reads
 *   the repository and answers; the import reads it *again* and refuses to store anything
 *   unless the ref still resolves to the commit the preview named. So what a user approved is
 *   what gets stored, never whatever the branch became in between — and a restart between the
 *   two requests costs nothing but the second clone.
 * - **A candidate carries its problems, and the preview never fails over one** (K3). One
 *   repository may hold a good skill and a broken one: the broken one is listed with its
 *   reasons and the good one is importable. Only the **import** refuses, and only for the
 *   candidate the caller picked.
 * - **Nothing is read from git after an import** (K3). What is stored is a snapshot of the
 *   files; the repository is not consulted again except by a refresh the user asks for (K5).
 * - **A skill is the user's own instructions and grants nothing** (K10). Nothing here reads
 *   `allowed-tools` or any other frontmatter field into a permission: the whole frontmatter is
 *   stored and shown, and the checks are the format's own (K1) and the limits of K4.
 *
 * ## Where the clone lives
 *
 * The clone is `@openharness/hands`' (`cloneRepository`, K3: `isomorphic-git` through
 * `safeFetch`, shallow, in memory) and reaches this module as a function, so a test drives the
 * real routes against a repository on loopback, and a deployment gets the real guard with its
 * own self-host setting. Nothing here spawns a process or opens a socket of its own.
 */

/** The clone this service uses: `@openharness/hands`' own, unless a test says otherwise. */
export type CloneRepository = (options: CloneRepositoryOptions) => Promise<ClonedRepository>

/** How {@link createSkillImportService} is configured. */
export interface SkillImportOptions {
  /** Where imported snapshots are stored. */
  readonly skills: SkillStore
  /**
   * How a repository is read. `@openharness/hands`' `cloneRepository` by default — the one
   * place a test replaces, pointing it at the repository fixture of its own.
   */
  readonly clone?: CloneRepository
  /**
   * Whether a private, loopback or link-local address may be dialled — the deployment's
   * self-host setting (`OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS`), the same one a remote MCP
   * server and a custom OpenAI-compatible endpoint read (#249; #303, X10). Off by default.
   */
  readonly allowPrivateUrls?: boolean
  /** The clone's total download cap; K4's 20 MB by default. */
  readonly maxBytes?: number
  /** The clone's deadline; 60 s by default, `null` for none. */
  readonly timeoutMs?: number | null
}

/** The import and refresh half of `/v1/me/skills` (epic #349, K3/K5). */
export interface SkillImportService {
  /** Read a repository and answer what could be imported (K3). Nothing is stored. */
  preview(ownerId: UserId, source: SkillImportSource): Promise<PreviewSkillImportResponse>
  /** Store the picked candidates, if the ref still resolves to the previewed commit. */
  importSkills(ownerId: UserId, request: SkillImportRequest): Promise<Skill[]>
  /**
   * Clone a stored skill's source again and answer what changed (K5).
   *
   * `null` for a skill id that is not this owner's — the 404 the route answers — and nothing
   * else: a repository that cannot be read, or one that no longer holds the skill, throws.
   */
  previewRefresh(ownerId: UserId, skillId: SkillId): Promise<RefreshSkillPreviewResponse | null>
  /** Replace a skill's snapshot with the commit a preview named, or `null` for another owner's. */
  refresh(ownerId: UserId, skillId: SkillId, commitSha: string): Promise<Skill | null>
}

/**
 * A repository that could not be read, or a skill that could not be imported — the protocol's
 * `skill_import_error` (422).
 *
 * `failure` is one of the protocol's codes, so the sentence a user reads is the one the
 * protocol spells; `detail` is the caller's own input (the ref, the path, the candidate's
 * name) and never anything the server learned; and `problems` carries a candidate's own
 * problems when the failure is that the candidate cannot be stored — what the preview already
 * showed the user, restated by the import that refused it.
 */
export class SkillImportFailureError extends Error {
  /** Which failure this is, in the protocol's vocabulary. */
  readonly failure: SkillImportFailure
  /** The caller's own input the failure is about. */
  readonly detail: string | undefined
  /** The problems of a candidate that could not be imported, when that is the failure. */
  readonly problems: readonly SkillProblem[]

  constructor(
    failure: SkillImportFailure,
    detail?: string,
    problems: readonly SkillProblem[] = [],
  ) {
    super(`${SKILL_IMPORT_MESSAGES[failure]}${detail === undefined ? '' : ` (${detail})`}`)
    this.name = 'SkillImportFailureError'
    this.failure = failure
    this.detail = detail
    this.problems = problems
  }
}

/**
 * A selection the import cannot act on — the protocol's 400 `invalid_request_error`.
 *
 * Two shapes, and both are the caller's mistake rather than the repository's (which is why
 * neither is a {@link SkillImportFailureError}): a name no candidate has, and the same name
 * picked twice — the second of which would otherwise be a partial write, the first copy stored
 * and the second refused by the store's own uniqueness rule.
 */
export class InvalidSkillSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSkillSelectionError'
  }

  /** A name no candidate under the path has. */
  static unknown(name: string): InvalidSkillSelectionError {
    return new InvalidSkillSelectionError(`no candidate skill is named ${JSON.stringify(name)}`)
  }

  /** One name picked more than once, which no batch can store. */
  static repeated(name: string): InvalidSkillSelectionError {
    return new InvalidSkillSelectionError(
      `${JSON.stringify(name)} is picked more than once; pick each candidate once`,
    )
  }
}

/** Build the service the skill import and refresh routes use. */
export function createSkillImportService(options: SkillImportOptions): SkillImportService {
  const clone = options.clone ?? cloneRepository

  /** One clone of a location, with the epic's limits and the deployment's self-host setting. */
  const readRepository = async (location: SkillLocation): Promise<ClonedRepository> => {
    try {
      return await clone({
        url: location.url,
        ref: location.ref,
        ...(options.allowPrivateUrls === true ? { allowPrivate: true } : {}),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
    } catch (error) {
      throw asFailure(error)
    }
  }

  /**
   * The two sides of a refresh comparison for one stored skill (K5).
   *
   * The stored side is read **file by file** through the store's own read — a store answers a
   * listing and never contents, which is what keeps fifty skills one small answer (K4) — and
   * the new side comes from a second clone of the same source. The candidate is found by the
   * skill's **name**, which is what identifies it among its owner's skills and what its folder
   * is called (K1), so a folder that moved under an unchanged name still refreshes.
   */
  const compareRefresh = async (ownerId: UserId, skill: Skill): Promise<RefreshComparison> => {
    const stored: DiffableFile[] = []
    for (const file of skill.files) {
      const content = await options.skills.getFile(skill.id, { ownerId }, file.path)
      stored.push({ path: file.path, content: content?.content ?? '' })
    }

    const location = readStoredSource(skill.source)
    const repository = await readRepository(location)
    const found = discover(repository.files, location.path, location.name)
    const candidate = found.find((entry) => entry.name === skill.name)
    if (candidate === undefined) {
      throw new SkillImportFailureError(
        'skill_not_importable',
        `${skill.name} is not in ${location.url} any more`,
      )
    }
    return {
      commit_sha: repository.commit_sha,
      oldFiles: stored,
      after: candidate.files,
      problems: candidate.problems,
    }
  }

  return {
    async preview(ownerId, source) {
      const location = readSource(source)
      const repository = await readRepository(location)
      const found = discover(repository.files, location.path, location.name)
      const taken = new Set((await options.skills.list({ ownerId })).map((skill) => skill.name))

      return {
        url: location.url,
        ref: location.ref,
        path: location.path,
        commit_sha: repository.commit_sha,
        candidates: found.map((candidate) => ({
          name: candidate.name,
          folder: candidate.folder,
          description: candidate.description,
          files: [...candidate.listing],
          skill_md: candidate.skillMd,
          problems: [...candidate.problems],
          name_taken: taken.has(candidate.name),
        })),
      }
    },

    async importSkills(ownerId, request) {
      const source: SkillImportSource = {
        url: request.url,
        ...(request.ref === undefined ? {} : { ref: request.ref }),
        ...(request.path === undefined ? {} : { path: request.path }),
      }
      const location = readSource(source)
      const repository = await readRepository(location)
      // The whole point of the second step: what was previewed is what is stored. A ref that
      // has moved since the preview is a conflict rather than a silent upgrade.
      requireCommit(repository.commit_sha, request.commit_sha)

      const found = discover(repository.files, location.path, location.name)
      const byName = new Map(found.map((candidate) => [candidate.name, candidate]))
      const seen = new Set<string>()
      const picked = request.names.map((name) => {
        const candidate = byName.get(name)
        if (candidate === undefined) {
          throw InvalidSkillSelectionError.unknown(name)
        }
        if (seen.has(name)) {
          throw InvalidSkillSelectionError.repeated(name)
        }
        seen.add(name)
        return candidate
      })

      // Everything is checked before anything is written, so a refused import stores nothing —
      // the rule every other write in this server follows.
      for (const candidate of picked) {
        if (candidate.problems.length > 0) {
          throw new SkillImportFailureError(
            'skill_not_importable',
            candidate.name,
            candidate.problems,
          )
        }
      }
      const taken = new Set((await options.skills.list({ ownerId })).map((skill) => skill.name))
      for (const candidate of picked) {
        if (taken.has(candidate.name)) {
          throw new DuplicateSkillNameError(ownerId, candidate.name)
        }
      }

      const stored: Skill[] = []
      for (const candidate of picked) {
        stored.push(
          await options.skills.create({
            ownerId,
            name: candidate.name,
            enabled: true,
            ...snapshotOf(candidate, location, repository.commit_sha),
          }),
        )
      }
      return stored
    },

    async previewRefresh(ownerId, skillId) {
      const scope = { ownerId }
      const skill = await options.skills.get(skillId, scope)
      if (skill === null) {
        return null
      }
      const comparison = await compareRefresh(ownerId, skill)
      const difference = diffSnapshots(comparison.oldFiles, comparison.after)
      const previous =
        comparison.oldFiles.find((file) => file.path === SKILL_MD_FILENAME)?.content ?? null
      const next = comparison.after.find((file) => file.path === SKILL_MD_FILENAME)?.content ?? null

      return {
        commit_sha: comparison.commit_sha,
        changed:
          difference.added.length > 0 ||
          difference.removed.length > 0 ||
          difference.changed.length > 0,
        files_added: [...difference.added],
        files_removed: [...difference.removed],
        files_changed: [...difference.changed],
        skill_md_diff: skillMdDiff(previous, next),
        problems: [...comparison.problems],
      }
    },

    async refresh(ownerId, skillId, commitSha) {
      const scope = { ownerId }
      const skill = await options.skills.get(skillId, scope)
      if (skill === null) {
        return null
      }
      const location = readStoredSource(skill.source)
      const repository = await readRepository(location)
      requireCommit(repository.commit_sha, commitSha)

      const found = discover(repository.files, location.path, location.name)
      const candidate = found.find((entry) => entry.name === skill.name)
      if (candidate === undefined) {
        throw new SkillImportFailureError(
          'skill_not_importable',
          `${skill.name} is not in ${location.url} any more`,
        )
      }
      if (candidate.problems.length > 0) {
        throw new SkillImportFailureError(
          'skill_not_importable',
          candidate.name,
          candidate.problems,
        )
      }

      const replaced = await options.skills.replaceSnapshot(
        skillId,
        scope,
        snapshotOf(candidate, location, repository.commit_sha),
      )
      return replaced
    },
  }
}

/** A place to read a repository from: the three fields a clone takes, after URL parsing. */
interface SkillLocation {
  readonly url: string
  readonly ref: string | null
  readonly path: string | null
  /**
   * The repository's name — the last segment of its URL's path, minus a trailing `.git`
   * (`@openharness/hands`' `repositoryName`).
   *
   * It is the one thing here that is not a field of the clone: a `SKILL.md` at the repository's
   * own root is a candidate (K3), and since a skill's name is its folder's (K1) and the root is
   * not a folder, the repository's name is what its frontmatter has to agree with.
   */
  readonly name: string
}

/**
 * Read a request's URL, ref and path into the three fields a clone takes.
 *
 * A browse URL (`…/tree/<ref>/<path>`) arrives as one string and leaves split in three
 * (`parseGitUrl`), and an **explicit** `ref` or `path` beats whatever the URL implied: the
 * request is the more specific statement, and a user whose ref really holds a slash says so
 * this way.
 *
 * A URL this refuses — not `https`, carrying credentials, naming no repository — is the 400
 * `invalid_request_error` a bad parameter gets: it is the caller's input and not a repository's
 * state, which is why it is not a {@link SkillImportFailureError}.
 */
function readSource(source: SkillImportSource): SkillLocation {
  let parsed
  try {
    parsed = parseGitUrl(source.url)
  } catch (error) {
    if (isGitUrlError(error)) {
      throw new SkillSourceRefusalError(error.code, error.message)
    }
    throw error
  }
  return {
    url: parsed.url,
    ref: emptyToNull(source.ref) ?? parsed.ref,
    path: normalizePath(emptyToNull(source.path) ?? parsed.path),
    // The name comes from the **repository** URL, never from what the user typed: a browse
    // URL's `/tree/…` half is not part of the repository.
    name: repositoryName(parsed.url),
  }
}

/** A stored skill's source as a location; an import always recorded all three (K3). */
function readStoredSource(source: SkillSource): SkillLocation {
  return {
    url: source.url,
    ref: source.ref,
    path: source.path,
    // Re-derived from the URL the import stored, so a root skill keeps the name it was checked
    // against however long ago it was imported.
    name: repositoryName(source.url),
  }
}

/**
 * A URL or a path a caller named that this server will not read — the 400 `invalid_request_error`.
 *
 * Its own error so the route maps one thing: a source the *caller* got wrong (an `http://` URL,
 * credentials in the URL, a URL naming no repository, a folder path with a `..` in it) reads
 * differently from a repository that could not be cloned, and only the second is a
 * `skill_import_error` (422). The three URL codes are `@openharness/hands`' own; `invalid_path`
 * is this module's, for a folder the URL grammar never saw.
 */
export class SkillSourceRefusalError extends Error {
  /** What was wrong with the source. */
  readonly code: GitUrlErrorCode | 'invalid_path'

  constructor(code: GitUrlErrorCode | 'invalid_path', message: string) {
    super(message)
    this.name = 'SkillSourceRefusalError'
    this.code = code
  }
}

/** An empty string means "nothing was said", which is what an absent field means too. */
function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * A folder path from a request, as the repository spells it: forward-slashed, no leading or
 * trailing slash, and no `..` that could climb out of what was asked for.
 *
 * A path holding `..` is refused rather than resolved against the repository's root: it cannot
 * mean anything but a mistake, and a resolved one would import a folder nobody named.
 */
function normalizePath(value: string | null): string | null {
  if (value === null) {
    return null
  }
  const segments = value.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.includes('..')) {
    throw new SkillSourceRefusalError(
      'invalid_path',
      'A skill folder is named with a plain relative path, with no `..` in it.',
    )
  }
  return segments.length === 0 ? null : segments.join('/')
}

/** One folder holding a `SKILL.md`, as the discovery built it. */
interface DiscoveredCandidate {
  /**
   * The folder's path from the repository's root; `''` when the candidate *is* the repository's
   * root — a `SKILL.md` sitting there, whose name is the repository's.
   */
  readonly folder: string
  /**
   * The folder's name — the candidate's identity, and the name the frontmatter has to agree
   * with. The repository's name for the root candidate, the folder's own otherwise.
   */
  readonly name: string
  /** `SKILL.md` exactly as the repository holds it. */
  readonly skillMd: string
  /** The frontmatter's `description`, or `null` when the frontmatter did not parse. */
  readonly description: string | null
  /** The frontmatter's other fields, as parsed; `{}` when it did not parse. */
  readonly frontmatter: SkillFrontmatter
  /** The folder's files, contents included, in path order. */
  readonly files: readonly SkillFileInput[]
  /** The same files as a listing — paths and sizes, never contents. */
  readonly listing: readonly SkillFile[]
  /** Everything wrong with this candidate; empty when it is importable. */
  readonly problems: readonly SkillProblem[]
}

/**
 * One place a `SKILL.md` was found: the file, the folder that holds it, and the name it is
 * checked against.
 */
interface SkillFolder {
  /** The `SKILL.md`'s path from the repository's root — the sort key. */
  readonly path: string
  /** The folder holding it, from the repository's root; `''` for the repository's own root. */
  readonly folder: string
  /** The name a skill from this folder takes: the folder's, or the repository's at the root. */
  readonly name: string
}

/**
 * Every folder holding a `SKILL.md` under `path` (K3), each with its files and its problems.
 *
 * The path is a **prefix**, not a folder to descend into: asking for `skills` finds
 * `skills/release-notes/SKILL.md` and `skills/release-notes/nested/SKILL.md` alike, because
 * "every `SKILL.md` under the path is a candidate" is what K3 says. A folder's files are
 * everything under it, recursively — a skill's reference material lives in subfolders — so a
 * nested skill's files are also its parent's, which is what the folders really hold.
 *
 * **The repository's own root is a candidate when a `SKILL.md` sits there** — the shape a
 * single-skill repository has. A candidate is a folder (K1: a skill's name is its folder's) and
 * the root is not one, so the repository itself is read as the folder: the root candidate's
 * `folder` is `''` and its name is the repository's, which is what the frontmatter has to agree
 * with. A `SKILL.md` directly under a named `path` is the same candidate one level down and
 * keeps that folder's own name.
 *
 * A root skill's files are the **whole tree under the root** — the repository is what the skill
 * is, rather than a folder holding it — with one exclusion: a folder below it that holds a
 * `SKILL.md` is a candidate of its own, and its whole subtree belongs to that candidate and not
 * to the root. Without the exclusion a repository's root skill would store every other skill's
 * files beside its own. The exclusion is the root's alone; a **nested** candidate keeps the rule
 * above, so its own nested candidates' files are still its own.
 *
 * @throws SkillImportFailureError when the path is not in the repository, or holds no `SKILL.md`
 */
function discover(
  files: readonly ClonedFile[],
  path: string | null,
  repository: string,
): DiscoveredCandidate[] {
  const prefix = path === null ? '' : `${path}/`
  if (path !== null && !files.some((file) => file.path === path || file.path.startsWith(prefix))) {
    throw new SkillImportFailureError('path_not_found', path)
  }

  const skillMds: SkillFolder[] = []
  // The repository's own root, when a `SKILL.md` sits there. `path !== null` means the scan
  // starts below the root, so only a whole-repository scan can find this one.
  if (path === null && files.some((file) => file.path === SKILL_MD_FILENAME)) {
    skillMds.push({ path: SKILL_MD_FILENAME, folder: '', name: repository })
  }
  for (const file of files) {
    if (!file.path.startsWith(prefix) || !file.path.endsWith(`/${SKILL_MD_FILENAME}`)) {
      continue
    }
    const folder = file.path.slice(0, -SKILL_MD_FILENAME.length - 1)
    skillMds.push({ path: file.path, folder, name: lastSegment(folder) })
  }
  skillMds.sort((left, right) => comparePaths(left.path, right.path))
  if (skillMds.length === 0) {
    throw new SkillImportFailureError('no_skills_found', path ?? 'the repository root')
  }

  // Every folder below the root that is a candidate of its own — what a root skill does not
  // take as its files (above).
  const nested = skillMds.map((found) => found.folder).filter((folder) => folder !== '')

  const names = new Map<string, number>()
  for (const found of skillMds) {
    names.set(found.name, (names.get(found.name) ?? 0) + 1)
  }

  return skillMds.map((found) => {
    const own = files
      .filter((file) => (found.folder === '' ? true : isWithin(file.path, found.folder)))
      .filter((file) => found.folder !== '' || !nested.some((other) => isWithin(file.path, other)))
      .map((file) => ({ path: relativeTo(found.folder, file.path), content: decode(file.content) }))
      .sort((left, right) => comparePaths(left.path, right.path))

    const skillMd = own.find((file) => file.path === SKILL_MD_FILENAME)?.content ?? ''
    const frontmatter = parseFrontmatter(skillMd)
    const problems: SkillProblem[] = []

    const name = found.name
    if (problems.length === 0 && frontmatter === null) {
      problems.push(
        problem(
          'invalid-frontmatter',
          'SKILL.md must open with YAML frontmatter and a closing `---` line.',
        ),
      )
    }
    if (frontmatter !== null) {
      const declared = frontmatter.name
      if (typeof declared !== 'string' || declared.length === 0) {
        problems.push(problem('invalid-frontmatter', 'The frontmatter must carry a `name`.'))
      } else if (declared !== name) {
        problems.push(
          problem(
            'name-mismatch',
            `The frontmatter names the skill ${JSON.stringify(declared)} but its folder is ${JSON.stringify(name)}.`,
          ),
        )
      } else if (!isSkillName(name)) {
        problems.push(
          problem(
            'invalid-frontmatter',
            'A skill name is lowercase letters, digits and interior dashes, at most 64 characters.',
          ),
        )
      } else if (isReservedSkillName(name)) {
        problems.push(problem('reserved-name', `${name} is a built-in command.`))
      }

      const description = frontmatter.description
      if (typeof description !== 'string' || description.length === 0) {
        problems.push(problem('invalid-frontmatter', 'The frontmatter must carry a `description`.'))
      } else if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
        problems.push(
          problem(
            'over-limit',
            `The description is ${description.length} characters; the limit is ${SKILL_DESCRIPTION_MAX_LENGTH}.`,
          ),
        )
      }
    }
    if ((names.get(name) ?? 0) > 1) {
      problems.push(
        problem(
          'duplicate-name',
          `More than one candidate under the path is named ${JSON.stringify(name)}.`,
        ),
      )
    }

    const sizes = new Map(own.map((file) => [file.path, skillFileSize(file.content)]))
    const mdSize = sizes.get(SKILL_MD_FILENAME) ?? 0
    if (mdSize > SKILL_MD_MAX_BYTES) {
      problems.push(limitProblem(SKILL_MD_FILENAME, mdSize, SKILL_MD_MAX_BYTES))
    }
    for (const file of own) {
      const size = sizes.get(file.path) ?? 0
      if (file.path !== SKILL_MD_FILENAME && size > SKILL_FILE_MAX_BYTES) {
        problems.push(limitProblem(file.path, size, SKILL_FILE_MAX_BYTES))
      }
    }
    const total = [...sizes.values()].reduce((sum, size) => sum + size, 0)
    if (total > SKILL_MAX_BYTES) {
      problems.push(limitProblem('The skill', total, SKILL_MAX_BYTES))
    }
    if (own.length > MAX_SKILL_FILES) {
      problems.push(
        problem(
          'over-limit',
          `The skill holds ${own.length} files; the limit is ${MAX_SKILL_FILES}.`,
        ),
      )
    }

    return {
      folder: found.folder,
      name,
      skillMd,
      description: descriptionOf(frontmatter),
      frontmatter: otherFields(frontmatter),
      files: own,
      listing: own.map((file) => ({ path: file.path, size: sizes.get(file.path) ?? 0 })),
      problems,
    }
  })
}

/**
 * Paths in the order a store lists them: code point by code point.
 *
 * The same comparison `SkillStore` uses, so a preview's file listing and the stored skill's are
 * the same list in the same order — `SKILL.md` before `reference/tone.md`, as it is in the
 * snapshot the import writes. `localeCompare` would order those two the other way round, which
 * would make a preview read differently from the skill it becomes.
 */
function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** One problem, in the protocol's shape. */
function problem(code: SkillProblem['code'], message: string): SkillProblem {
  return { code, message }
}

/** A limit broken, said the way a user measures it: kilobytes, once, to one decimal. */
function limitProblem(what: string, size: number, limit: number): SkillProblem {
  return problem('over-limit', `${what} is ${kb(size)}; the limit is ${kb(limit)}.`)
}

/** A byte count as kilobytes, the way a person reads a limit. */
function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * A `SKILL.md`'s frontmatter as a plain object, or `null` when there is none to read.
 *
 * The format is K1's: the file opens with a `---` line, the YAML runs to the next line that is
 * exactly `---`, and the body follows. A file that does not open with one, whose YAML does not
 * parse, or whose YAML is not a mapping has no frontmatter — and that is the one thing every
 * other check depends on, which is why it is answered rather than reported here.
 */
function parseFrontmatter(text: string): Record<string, unknown> | null {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') {
    return null
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end === -1) {
    return null
  }
  return parseFrontmatterBlock(lines.slice(1, end))
}

/** The field `argument-hint` at the start of its own line — the format's own spelling, top level. */
const ARGUMENT_HINT_LINE = /^argument-hint\s*:/

/**
 * A frontmatter block as a mapping, with `argument-hint` kept as the file wrote it (K1).
 *
 * The Agent Skills format and Claude Code both spell an argument hint as a bracketed
 * placeholder, and **neither is a YAML string**: `argument-hint: [version]` is a flow sequence,
 * and `argument-hint: [pr-number] [priority]` is not valid YAML at all. The hint is free text
 * the format only ever shows, so it is read off its own line (the text after the colon,
 * trimmed) whenever YAML does not already answer with a plain string — and a block whose YAML
 * fails **only** because of that line is read with the line set aside rather than refused, so a
 * skill written for Claude Code imports unchanged. A value the file quoted (`"[version]"`) is a
 * string already and is left to YAML, which is the one spelling that keeps its own quotes.
 */
function parseFrontmatterBlock(lines: readonly string[]): Record<string, unknown> | null {
  const parsed = parseYamlBlock(lines.join('\n'))
  if (parsed !== null) {
    return withRawArgumentHint(parsed, lines)
  }
  // The YAML did not parse. It may be the one line the format's own bracket spelling made
  // unparseable: read the block again without it, and only if the rest is a mapping has the
  // failure been understood rather than papered over.
  const hintIndex = lines.findIndex((line) => ARGUMENT_HINT_LINE.test(line))
  if (hintIndex === -1) {
    return null
  }
  const rest = parseYamlBlock(lines.filter((_, index) => index !== hintIndex).join('\n'))
  if (rest === null) {
    return null
  }
  const raw = lineValue(lines[hintIndex] ?? '')
  return raw === null ? rest : { ...rest, 'argument-hint': raw }
}

/** A value YAML did not answer as a plain string is replaced by the text its line carried. */
function withRawArgumentHint(
  parsed: Record<string, unknown>,
  lines: readonly string[],
): Record<string, unknown> {
  if (typeof parsed['argument-hint'] === 'string') {
    return parsed
  }
  const line = lines.find((candidate) => ARGUMENT_HINT_LINE.test(candidate))
  const raw = line === undefined ? null : lineValue(line)
  return raw === null ? parsed : { ...parsed, 'argument-hint': raw }
}

/** The text after a frontmatter field's colon, trimmed, or `null` when it is empty. */
function lineValue(line: string): string | null {
  const value = line.slice(line.indexOf(':') + 1).trim()
  return value === '' ? null : value
}

/** Parse a block of YAML, answering `null` for anything that is not a mapping. */
function parseYamlBlock(yaml: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = parseYaml(yaml)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  return parsed as Record<string, unknown>
}

/** A candidate's `description`, or `null` when the frontmatter did not carry a usable one. */
function descriptionOf(frontmatter: Record<string, unknown> | null): string | null {
  const description = frontmatter?.description
  return typeof description === 'string' && description.length > 0 ? description : null
}

/**
 * The frontmatter's other fields, as the resource stores them (K1).
 *
 * `name` and `description` are left out because the resource carries them as its own fields;
 * everything else — `license`, `metadata`, the honoured `disable-model-invocation`,
 * `user-invocable` and `argument-hint`, and anything a future format adds — rides in here
 * whole, which is what lets a skill written elsewhere import unchanged.
 */
function otherFields(frontmatter: Record<string, unknown> | null): SkillFrontmatter {
  if (frontmatter === null) {
    return {}
  }
  const { name: _name, description: _description, ...rest } = frontmatter
  return rest
}

/** One candidate as the snapshot a store writes. */
function snapshotOf(
  candidate: DiscoveredCandidate,
  location: SkillLocation,
  commitSha: string,
): SkillSnapshotInput {
  return {
    description: candidate.description ?? '',
    frontmatter: candidate.frontmatter,
    source: {
      url: location.url,
      ref: location.ref,
      path: location.path,
      commit_sha: commitSha,
    },
    files: candidate.files,
  }
}

/**
 * Refuse an import or a refresh whose commit is not the one the preview named (K3/K5).
 *
 * A ref that moved between the two calls is a **conflict** — the resource is not in the state
 * the request assumed — and the message tells the caller what to do about it, which is to
 * preview again.
 */
function requireCommit(actual: string, previewed: string): void {
  if (actual !== previewed) {
    throw new StaleSkillCommitError(previewed, actual)
  }
}

/**
 * The ref moved between a preview and the confirm — the protocol's 409 `conflict_error`.
 *
 * Its own error rather than a {@link SkillImportFailureError}: nothing is wrong with the
 * repository or the skill, and the request can simply be made again against a fresh preview.
 */
export class StaleSkillCommitError extends Error {
  /** The commit the caller confirmed. */
  readonly previewed: string
  /** The commit the ref resolves to now. */
  readonly actual: string

  constructor(previewed: string, actual: string) {
    super(
      `the ref has moved since the preview: it named ${previewed} and now resolves to ${actual}. ` +
        'Preview the import again and confirm the commit it answers with.',
    )
    this.name = 'StaleSkillCommitError'
    this.previewed = previewed
    this.actual = actual
  }
}

/** The last segment of a forward-slashed path. */
function lastSegment(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? path : path.slice(at + 1)
}

/** Whether a file at `path` is inside `folder` — the folder itself, or something under it. */
function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
}

/**
 * A file's path as the folder holding it spells it: `SKILL.md` for `release-notes/SKILL.md`
 * under `release-notes`, and the path itself under the repository's own root (`''`).
 */
function relativeTo(folder: string, path: string): string {
  if (folder === '') {
    return path
  }
  return path === folder ? '' : path.slice(folder.length + 1)
}

/**
 * A blob as text.
 *
 * A `SKILL.md` or any other file of a skill that is not valid UTF-8 is not text this build can
 * store — a snapshot's contents are strings — so the bytes are decoded with a replacement
 * character rather than failing the whole candidate: what the user sees is the file with what
 * could not be read marked, and the size checks (K4) are computed on what is really stored.
 */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * What a {@link SkillImportFailureError} says to the user: the protocol's sentence, the
 * caller's own detail, and — for a candidate that cannot be stored — that candidate's problems,
 * which are what the preview already showed.
 */
export function skillImportFailureMessage(error: SkillImportFailureError): string {
  if (error.problems.length === 0) {
    return error.message
  }
  return `${error.message} ${error.problems.map((problem) => problem.message).join(' ')}`
}

/** A clone failure as the protocol's vocabulary — the two code sets are one list. */
function asFailure(error: unknown): SkillImportFailureError {
  if (isGitCloneError(error)) {
    return new SkillImportFailureError(error.code, error.message)
  }
  throw error
}

/** What a refresh compares: the stored snapshot's files, the new clone's, and its problems. */
interface RefreshComparison {
  /** The commit the re-clone landed on. */
  readonly commit_sha: string
  /** The stored snapshot's files, contents read one by one from the store. */
  readonly oldFiles: readonly DiffableFile[]
  /** The freshly cloned candidate's files. */
  readonly after: readonly SkillFileInput[]
  /** Everything wrong with the new snapshot. */
  readonly problems: readonly SkillProblem[]
}

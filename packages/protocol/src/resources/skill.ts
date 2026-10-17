import { z } from 'zod'

import { TimestampSchema } from '../common'
import { SkillIdSchema } from '../ids'
import type { ModeToolOverride } from './mode'
import { UserIdSchema } from './user'

/**
 * The `skill` resource and the endpoints that manage it:
 *
 * - `GET    /v1/me/skills`
 * - `GET    /v1/me/skills/{skill_id}`                (with the `SKILL.md` file's content)
 * - `GET    /v1/me/skills/{skill_id}/files/{path}`   (one file's content)
 * - `POST   /v1/me/skills/{skill_id}`                (update `enabled`)
 * - `DELETE /v1/me/skills/{skill_id}`
 *
 * // extension: Anthropic's Managed Agents API has `skills` on an agent as a per-run reference
 * to a skill Anthropic holds. openharness does not: a **user** imports skills they have
 * reviewed (epic #349, K3), each is a snapshot of a folder of files stored under their own id
 * (K4), and a skill is a per-user resource like a mode or a remote MCP server. Import and
 * refresh — the two routes that write a snapshot — are #351; this module is the resource those
 * routes answer with, the vocabulary the rest of the epic reads, and the limits they enforce.
 *
 * ## The format (K1)
 *
 * A skill is a folder with a `SKILL.md` at its root: YAML frontmatter carrying a `name` and a
 * `description`, then a Markdown body — plus any other files the folder holds. The format is
 * the open [Agent Skills](https://agentskills.io) one, used unchanged, so a skill written for
 * another harness imports as it is. `name` is lowercase letters, digits and interior hyphens,
 * at most {@link SKILL_NAME_MAX_LENGTH} characters, and it matches the folder's name;
 * `description` is at most {@link SKILL_DESCRIPTION_MAX_LENGTH} characters.
 *
 * Three optional frontmatter fields are **honoured** (a later sub-issue reads them; this one
 * stores them with the rest): `disable-model-invocation: true`, a command only the user runs;
 * `user-invocable: false`, one only the model uses; and `argument-hint`, shown in the `/` menu.
 * Every other field — `license`, `metadata`, `compatibility`, `allowed-tools`, … — is stored
 * and shown and otherwise ignored.
 */

/** Longest skill name the API accepts (K1): 64 characters. */
export const SKILL_NAME_MAX_LENGTH = 64

/**
 * The shape of a skill name (K1): lowercase letters, digits and interior hyphens.
 *
 * Narrower than the open format's prose on two points, both of which the format's own
 * examples satisfy: no leading or trailing hyphen, and no uppercase. It is the same pattern a
 * remote MCP server's name takes ({@link isMcpServerName}), restated here because the two are
 * free to diverge — a skill name is a folder's name and a slash command, not a tool prefix.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Whether `value` has the shape of a skill name — {@link SKILL_NAME_PATTERN}, and a length inside the cap. */
export function isSkillName(value: string): boolean {
  return value.length > 0 && value.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(value)
}

/**
 * The names a skill may not take: every built-in slash command (epic #349, K7).
 *
 * A built-in command is a **client action** the user types — `/compact` today, and `/new`,
 * `/model`, `/mode`, `/agents` and `/skills` as their features land — and it is not a skill.
 * A skill that took one of these names would be unreachable in the `/` menu and ambiguous in a
 * transcript, so the list is reserved: {@link SkillNameSchema} refuses a skill named for one.
 *
 * It is spelled **once**, here, because three sides have to agree on it and none owns it: the
 * import's validation (#351), the resource this schema describes, and the `/` menu, which
 * reads the built-ins from this constant beside the user's own skills (#352, #353, #354).
 */
export const RESERVED_SKILL_NAMES = ['compact', 'new', 'model', 'mode', 'agents', 'skills'] as const

/** One of the built-in slash commands ({@link RESERVED_SKILL_NAMES}), as a type. */
export type ReservedSkillName = (typeof RESERVED_SKILL_NAMES)[number]

/** Whether `value` is a built-in slash command's name, which no skill may take. */
export function isReservedSkillName(value: string): boolean {
  return (RESERVED_SKILL_NAMES as readonly string[]).includes(value)
}

/**
 * A skill name: the rule of K1 shape-checked by {@link isSkillName} and reserved names refused.
 *
 * Both checks are here rather than at a caller because this schema is the one place a name is
 * validated — a name that reaches a store has already passed it.
 */
export const SkillNameSchema = z
  .string()
  .refine(isSkillName, {
    error:
      `a skill name is 1–${SKILL_NAME_MAX_LENGTH} lowercase letters, digits and interior ` +
      'dashes, e.g. `release-notes` — and it matches the skill folder’s name',
  })
  .refine((name) => !isReservedSkillName(name), {
    error: `a skill may not take a built-in command name (${RESERVED_SKILL_NAMES.join(', ')})`,
  })

export type SkillName = z.infer<typeof SkillNameSchema>

/** Longest skill description the format allows (K1): 1024 characters. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024

/**
 * The file every skill's folder carries (K1): the frontmatter that names and describes it,
 * then the instructions a model or a user reads.
 *
 * It is the one path with a bound of its own ({@link SKILL_MD_MAX_BYTES}) and the one every
 * skill must hold: a snapshot without it is not a skill, and a store refuses one.
 */
export const SKILL_MD_FILENAME = 'SKILL.md'

/**
 * The most characters a slash invocation's arguments may carry (K7).
 *
 * The arguments ride the `user.message` as typed and are substituted into the body the model is
 * given, so they are part of a request's size like anything else; the cap keeps a paste from
 * becoming a message the protocol stores without bound. It is generous — a skill invocation is a
 * sentence, not a document.
 */
export const SKILL_ARGUMENTS_MAX_LENGTH = 10_000

/**
 * The honoured frontmatter fields, as a `Skill` states them (epic #349, K1).
 *
 * Three of the format's fields change what a skill *is* to this build, and every consumer that
 * has to know — the listing (K6), the `/` menu (K7), the settings screens (#353) — reads them
 * through {@link skillSettingsOf} rather than off `frontmatter` itself, so "what does
 * `user-invocable` default to?" has one answer. The rest of the frontmatter is stored and shown
 * and otherwise ignored.
 */
export interface SkillSettings {
  /**
   * `disable-model-invocation: true`: a command only the **user** runs (K6).
   *
   * The model is not told the skill exists — it is out of the listing — and `skill` refuses it
   * if the model asks for it anyway by name.
   */
  readonly disableModelInvocation: boolean
  /**
   * `user-invocable: false`: a skill only the **model** uses (K7), refused as a slash command.
   *
   * Absent means `true`: a skill is something its user can run, which is the format's own
   * reading and the one that makes importing a skill do something.
   */
  readonly userInvocable: boolean
  /** `argument-hint`: shown beside the command in a `/` menu, or `null` when the file names none. */
  readonly argumentHint: string | null
}

/**
 * The three honoured fields of a skill's snapshot (K1), read one way by every consumer.
 *
 * A field is honoured only in the shape the format documents — a real `true` for
 * `disable-model-invocation`, a real `false` for `user-invocable`, a string for `argument-hint`
 * (or the flow-sequence array the format's own `[version]` spelling parses to, rendered back as
 * written) — because the frontmatter is open and untyped ({@link SkillFrontmatterSchema}): a
 * value a hand-written file got wrong is an ignored field rather than a skill that behaves
 * differently from what it says. The lookup is case-sensitive to the field names the format uses.
 */
export function skillSettingsOf(skill: Skill): SkillSettings {
  const frontmatter = skill.frontmatter
  return {
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    userInvocable: frontmatter['user-invocable'] !== false,
    argumentHint: argumentHintOf(frontmatter['argument-hint']),
  }
}

/**
 * Whether one skill is **on** for a request, given the mode's override (epic #349, K8).
 *
 * The rule is the one every reader must apply: **a mode that names the skill wins; a skill it
 * does not name follows the user's `enabled`**. A map entry naming a skill the user no longer
 * has never matches anything, so a mode that named a deleted skill is simply ignored. It is
 * exported from the protocol — rather than written once in the server and once in each
 * frontend — because the server's `assertInvocableSkills` and the `/` menu have to answer with
 * the same effective set: a menu row the server refuses, or a missing row the server would
 * accept, is a bug that only one shared rule can prevent.
 *
 * @param skill the skill as the store lists it (its stored `enabled`, never an effective one)
 * @param override the resolved mode's `tools` patch, or `null` for no override
 */
export function skillInForce(skill: Skill, override: ModeToolOverride | null): boolean {
  return override?.skills?.[skill.id] ?? skill.enabled
}

/**
 * The effective skills of a list, in its own order (K8) — {@link skillInForce} applied to
 * every one of them.
 *
 * The order is deliberately the input's (the store lists a user's skills oldest first), so a
 * frontend that shows the effective set and one that shows the stored list agree on
 * everything but the on/off answer.
 */
export function skillsInForce(
  skills: readonly Skill[],
  override: ModeToolOverride | null,
): Skill[] {
  return skills.filter((skill) => skillInForce(skill, override))
}

/**
 * `argument-hint` as the text a `/` menu shows, or `null` for a value that is not one.
 *
 * A string is the hint itself, trimmed; an empty one names nothing. An **array** is the
 * format's own bracket spelling read as YAML — `argument-hint: [version]` is a flow sequence,
 * not a string — and it is still the hint the file meant, so it is rendered back the way the
 * line wrote it (`[version]`, `[a, b]`). A snapshot imported since the import keeps the raw
 * line (see `apps/server`'s discovery), so this half is for one stored before that: the shape
 * the file has never changes the hint a reader sees.
 */
function argumentHintOf(value: unknown): string | null {
  if (typeof value === 'string') {
    const hint = value.trim()
    return hint.length === 0 ? null : hint
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    const items = value.map((item) => item.trim()).filter((item) => item !== '')
    return items.length === 0 ? null : `[${items.join(', ')}]`
  }
  return null
}

/**
 * A `SKILL.md` file's **body**: everything after its YAML frontmatter (K1, K6).
 *
 * The one reading of where the frontmatter ends, so the body a model is handed is the same in
 * the tool that serves it, the context builder that renders a slash invocation and any client
 * that shows a skill. The rules are the format's own:
 *
 * - the file opens with a line that is exactly `---` (a leading byte-order mark is tolerated);
 * - the frontmatter runs to the next line that is exactly `---` or `...`;
 * - everything after it is the body, trimmed of the blank lines that separate the two.
 *
 * A file that does not open a frontmatter block has no frontmatter to strip and is its own body,
 * and so is one whose block never closes — the markers are what make a block, and a file without
 * them is not one. Nothing here parses YAML: the parsed frontmatter is the resource's own field
 * ({@link Skill.frontmatter}), and this helper only knows where the text it came from begins.
 */
export function skillBody(content: string): string {
  const text = content.startsWith(BOM) ? content.slice(BOM.length) : content
  const lines = text.split('\n')
  if (!isFrontmatterFence(lines[0])) {
    return text.trim()
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (isClosingFence(lines[index])) {
      return lines
        .slice(index + 1)
        .join('\n')
        .trim()
    }
  }
  return text.trim()
}

/** The byte-order mark a file saved by a Windows editor may open with. */
const BOM = '\uFEFF'

/** Whether a line opens a `SKILL.md`'s frontmatter block. */
function isFrontmatterFence(line: string | undefined): boolean {
  return line?.trim() === '---'
}

/** Whether a line closes one: the format's ending marker, or YAML's own document end. */
function isClosingFence(line: string | undefined): boolean {
  const trimmed = line?.trim()
  return trimmed === '---' || trimmed === '...'
}

/**
 * The size limits of K4, in bytes.
 *
 * They bound what one import may store, and they are enforced by the store's callers — the
 * import (#351) refuses a skill that breaks one with the reason, which is why they are
 * constants here rather than checks inside a store. Sizes are counts of **bytes**, not
 * characters ({@link skillFileSize}), so a limit means the same thing whatever the files hold.
 */

/** Largest `SKILL.md` a skill may carry: 20 KB. */
export const SKILL_MD_MAX_BYTES = 20 * 1024

/** Largest of any one file of a skill: 256 KB. */
export const SKILL_FILE_MAX_BYTES = 256 * 1024

/** Largest whole skill, its files together: 2 MB. */
export const SKILL_MAX_BYTES = 2 * 1024 * 1024

/** Most files one skill may hold: 100. */
export const MAX_SKILL_FILES = 100

/**
 * Most skills one user may hold: 50.
 *
 * A store rule as well as a caller's — the store counts and inserts under a per-owner lock, so
 * two concurrent creates cannot both take the last slot, exactly as modes and remote MCP
 * servers do.
 */
export const MAX_SKILLS_PER_USER = 50

/**
 * Largest clone an import may download: 20 MB (K4).
 *
 * A constant only, for now: the shallow clone it bounds is #351's, and it is here because the
 * limit belongs with the others rather than in the module that happens to consume it first.
 */
export const SKILL_CLONE_MAX_BYTES = 20 * 1024 * 1024

/**
 * Largest total of **unpacked** blob bytes one clone may read: 100 MB.
 *
 * The download cap above bounds the compressed pack, and a pack of highly compressible content
 * can inflate to orders of magnitude more than its download size — `SKILL_CLONE_MAX_BYTES` of
 * zeros is gigabytes once read. The clone therefore also caps the sum of the blobs it really
 * inflates, and refuses past it with `over_limit`.
 *
 * The number is the most a legitimate import could need: fifty skills (§
 * {@link MAX_SKILLS_PER_USER}) each at the whole-skill limit (§ {@link SKILL_MAX_BYTES}). A
 * caller that reads only a folder's own blobs — the import passes its `path` to the clone —
 * therefore cannot reach it with skills that pass K4, while a repository whose content unpacks
 * past it is refused rather than left to exhaust the process.
 */
export const SKILL_INFLATE_MAX_BYTES = SKILL_MAX_BYTES * MAX_SKILLS_PER_USER

/**
 * The size of a file's content in bytes — what {@link SkillFile.size} counts.
 *
 * Bytes rather than characters, because a limit of "20 KB" has to mean the same thing for a
 * file of ASCII and a file of CJK or emoji: `TextEncoder` counts what would really be stored,
 * and it is a Web API both a browser and Node 24 have, so this package stays browser-safe.
 *
 * A base64 file's `size` is the number of bytes it decodes to, not the length of the base64
 * text: the limits of K4 count the file itself, and a base64 string is a third larger than the
 * bytes it carries. The arithmetic below is exact for the canonical base64 the import writes
 * (including a final group padded with `=` or `==`), and requires no `atob` — which keeps this
 * function usable in `@openharness/protocol`'s browser-safe program.
 */
export function skillFileSize(content: string, encoding: SkillFileEncoding = 'utf8'): number {
  if (encoding === 'base64') {
    const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
    return Math.floor((content.length * 3) / 4) - padding
  }
  return new TextEncoder().encode(content).length
}

/**
 * How a file's content is spelled in storage (K4).
 *
 * A skill's files are not all text: a folder may ship an icon, a font or a `.docx`, and the
 * import stores those losslessly rather than decoding them into mojibake. `utf8` is the
 * ordinary case — `content` is the file's text; `base64` is a non-text file — `content` is the
 * file's bytes, base64-encoded — and `size` is the original byte length either way.
 *
 * The encoding is what Postgres needs: its `text` type rejects a NUL byte outright, so a
 * binary file cannot be stored as text at all (`invalid byte sequence for encoding "UTF8":
 * 0x00`), and a file that is not valid UTF-8 cannot be kept faithfully as a string. Base64 is
 * the lossless spelling every store accepts.
 */
export const SkillFileEncodingSchema = z.enum(['utf8', 'base64'])

export type SkillFileEncoding = z.infer<typeof SkillFileEncodingSchema>

/**
 * // extension: the frontmatter fields besides `name` and `description`, as parsed.
 *
 * Open and JSON-valued on purpose: the format allows any field, its own examples carry nested
 * maps and lists (`metadata`, `allowed-tools`), and a deployment must not have to know a field
 * to store or show it. The honoured keys of K1 (`disable-model-invocation`, `user-invocable`,
 * `argument-hint`) ride here beside the ignored ones, so a reader sees exactly what the file
 * said — what the import (#351) writes is the parsed frontmatter with the two fields the
 * resource carries as its own ({@link Skill.name}, {@link Skill.description}) left out.
 */
export const SkillFrontmatterSchema = z.record(z.string(), z.unknown())

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

/**
 * One file of a skill, as a **listing** reports it: where it is and how big it is, and never
 * its content.
 *
 * `path` is relative to the skill folder and spelled with forward slashes (`SKILL.md`,
 * `reference/notes.md`); the file's content has a read of its own
 * (`GET /v1/me/skills/{skill_id}/files/{path}`). Keeping the content out of the resource is
 * what makes a listing of fifty skills one small answer whatever the snapshots hold — and what
 * keeps the store free to move contents to object storage later (K4) without a resource
 * changing shape.
 */
export const SkillFileSchema = z.object({
  /** The file's path inside the skill folder, relative and forward-slashed. */
  path: z.string().min(1),
  /** The content's size in bytes (see {@link skillFileSize}), not its character count. */
  size: z.number().int().min(0),
})

export type SkillFile = z.infer<typeof SkillFileSchema>

/**
 * Where a skill's snapshot came from (K3, K4): the public git URL it was imported from, the
 * ref and path it was taken at, and the commit it was cloned.
 *
 * Recorded so a user can see what they imported and re-run the same clone by hand, and so a
 * refresh knows what to compare against (K5): the diff is against `commit_sha`. The fields are
 * the import's own input: `url` is the `https://` git URL, `ref` the branch, tag or commit the
 * user asked for, `path` the folder inside the repository, and `commit_sha` the commit the
 * clone really landed on. `ref` and `path` are `null` when the user named none, and so is
 * `commit_sha` for a snapshot nothing cloned — a skill a test wrote directly.
 */
export const SkillSourceSchema = z.object({
  /** The public `https://` git URL the skill was imported from. */
  url: z.string(),
  /** The branch, tag or commit the clone was asked for, or `null` for the repository's default. */
  ref: z.string().nullable(),
  /** The folder inside the repository the skill was taken from, or `null` for its root. */
  path: z.string().nullable(),
  /** The commit the clone landed on, or `null` for a snapshot nothing cloned. */
  commit_sha: z.string().nullable(),
})

export type SkillSource = z.infer<typeof SkillSourceSchema>

/**
 * A user's imported skill, as the API returns it.
 *
 * `files` is a **listing** — each file's path and size ({@link SkillFileSchema}) — and never
 * its content: reading one file is its own request, and the `SKILL.md` the resource is
 * described by comes with the single-skill read
 * ({@link GetSkillResponseSchema}).
 */
export const SkillSchema = z.object({
  id: SkillIdSchema,
  /**
   * // extension: the discriminant, so the resource can be told from an agent or a session in
   * a bag of mixed resources. Anthropic has no per-user skill resource.
   */
  type: z.literal('skill'),
  /**
   * // extension: the user this skill belongs to (epic #65, A4). Read-only: the server sets it
   * from the caller, no request carries it, and another user's skill is answered as missing.
   */
  owner_id: UserIdSchema,
  /** The skill's name (K1), unique among its owner's skills and the command it is run as. */
  name: SkillNameSchema,
  /** The one-line description the model is told about the skill (K1). */
  description: z.string().max(SKILL_DESCRIPTION_MAX_LENGTH),
  /** The frontmatter's other fields, as parsed — see {@link SkillFrontmatterSchema}. */
  frontmatter: SkillFrontmatterSchema,
  /** Where the snapshot came from: the URL, the ref, the path and the commit (K3, K4). */
  source: SkillSourceSchema,
  /** The snapshot's files, each with its path and size — never its content. */
  files: z.array(SkillFileSchema),
  /**
   * Whether the skill is on for this user's chats (K8).
   *
   * A skill is on when it is imported, and the user turns it off; a mode may override which
   * skills are on (K8) through its own `skills` map, which is a **patch** over this field and
   * never a change to it — this is the stored default, not the effective set.
   */
  enabled: z.boolean(),
  /** When the snapshot was first stored. */
  imported_at: TimestampSchema,
  /** When the snapshot was last replaced by a refresh (K5), or {@link Skill.imported_at} if never. */
  refreshed_at: TimestampSchema,
})

export type Skill = z.infer<typeof SkillSchema>

/**
 * One file of a skill, with its content: the answer of
 * `GET /v1/me/skills/{skill_id}/files/{path}`.
 *
 * The path and size the listing carries are repeated beside the content so a reader does not
 * have to pair this answer with a listing to know what it is holding. The content is the file
 * **exactly as stored** — the snapshot is the skill, and a refresh that changed the file is a
 * new snapshot rather than an edit to this one.
 */
export const SkillFileContentSchema = z.object({
  /** The file's path inside the skill folder, the one that was asked for. */
  path: z.string().min(1),
  /** The content's size in bytes (see {@link skillFileSize}) — the original file's, in bytes. */
  size: z.number().int().min(0),
  /**
   * How `content` is spelled: the file's text (`utf8`), or its bytes base64-encoded
   * (`base64`). Required, because a reader that assumed text would show mojibake for a
   * binary file — and a model that read one as base64 would be told nothing useful.
   */
  encoding: SkillFileEncodingSchema,
  /** The file's content, as the snapshot holds it — see `encoding`. */
  content: z.string(),
})

export type SkillFileContent = z.infer<typeof SkillFileContentSchema>

/**
 * Response of `GET /v1/me/skills/{skill_id}`: the resource, plus `SKILL.md`'s content.
 *
 * The one read that carries a file's content without a second request, because the `SKILL.md`
 * is what a settings screen (and a user) reads a skill by: its frontmatter is already split
 * across {@link Skill.name}, {@link Skill.description} and {@link Skill.frontmatter}, and what
 * is left is the instructions. The content is the **whole file** — frontmatter and body — as
 * the snapshot stored it, so what a reader sees is what the model would be handed.
 */
export const GetSkillResponseSchema = SkillSchema.extend({
  /** `SKILL.md` as stored: the frontmatter, then the Markdown body. */
  content: z.string(),
})

export type GetSkillResponse = z.infer<typeof GetSkillResponseSchema>

/**
 * Response of `GET /v1/me/skills`.
 *
 * No pagination envelope, the shape the mode, credential and MCP-server lists use: a user
 * holds at most {@link MAX_SKILLS_PER_USER}, so the response is bounded and a settings screen
 * shows them all at once.
 */
export const ListSkillsResponseSchema = z.object({
  data: z.array(SkillSchema),
})

export type ListSkillsResponse = z.infer<typeof ListSkillsResponseSchema>

/**
 * Body of `POST /v1/me/skills/{skill_id}`. Response: {@link SkillSchema}.
 *
 * `enabled` and nothing else: what a skill is, is its snapshot, and the only field of one a
 * user changes without a refresh (K5) is whether it is on (K8) — a new snapshot comes from
 * re-importing, which is #351's. Required rather than optional: a body that names no field
 * says nothing, so there is no patch to apply.
 */
export const UpdateSkillRequestSchema = z.object({
  /** Whether the skill is on for this user's chats (K8). */
  enabled: z.boolean(),
})

export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequestSchema>

/**
 * The distinct ways an import can fail (K3), as stable codes.
 *
 * Every one of them is a **request the server understood** and could not carry out — the URL
 * is fine as a URL, but it is not a repository, or not this one's branch, or the deployment
 * refuses to dial the address it names. They are deliberately apart from one another rather
 * than one generic refusal, because a user who pasted a URL is owed the difference between
 * *their* mistake (a path that is not there, a branch that does not exist), *the
 * repository's* state (empty, or not a repository at all), and *this deployment's* policy (a
 * private address, no credentials to send); only the last two are the server's to explain,
 * and all three are the caller's to act on differently.
 *
 * The code does not travel on its own — the error envelope has room for a type and a message
 * and nothing else — so {@link SKILL_IMPORT_MESSAGES} is the one spelling of each sentence,
 * shared by the server that raises it and the client that shows it.
 */
export const SKILL_IMPORT_FAILURES = [
  /** The host could not be reached at all: DNS failed, or the connection did not open. */
  'unreachable',
  /** Something answered, but it is not a git repository — an HTML page, a 404, a proxy. */
  'not_a_repository',
  /** The repository is private, or the server demanded credentials this deployment never sends. */
  'authentication_required',
  /** The repository exists, but it has no such branch, tag or commit. */
  'ref_not_found',
  /** The repository exists, but it holds no such folder. */
  'path_not_found',
  /** The path holds no `SKILL.md` at all, so there is nothing to import (K1). */
  'no_skills_found',
  /**
   * The repository was read, and a skill the caller picked cannot be imported as it stands:
   * its frontmatter does not parse, its name is not the folder's, or it breaks a limit of K4
   * ({@link SKILL_PROBLEM_CODES}). The distinction from the failures above is which side is at
   * fault — the repository read worked and the skill is the problem.
   */
  'skill_not_importable',
  /** The clone broke one of the limits of K4 — the 20 MB download, or its deadline. */
  'over_limit',
  /** The address the URL names is private, loopback, link-local or metadata — refused (K3). */
  'refused_address',
] as const

/** One of the ways an import can fail ({@link SKILL_IMPORT_FAILURES}). */
export type SkillImportFailure = (typeof SKILL_IMPORT_FAILURES)[number]

/**
 * What each import failure says to the user, as a sentence.
 *
 * One spelling per code, so the server that raises the error, the tests that pin it and a
 * client that shows it cannot drift apart. A failure whose message needs a detail — which
 * ref, which path — takes the sentences below and appends it, which is what the server's
 * import does; the detail is always the caller's own input, never anything the server knows.
 */
export const SKILL_IMPORT_MESSAGES: Record<SkillImportFailure, string> = {
  unreachable: 'The repository could not be reached.',
  not_a_repository: 'That URL is not a public git repository.',
  authentication_required:
    'That repository is private or requires credentials, and openharness imports public repositories only.',
  ref_not_found: 'That branch, tag or commit is not in the repository.',
  path_not_found: 'That folder is not in the repository.',
  no_skills_found: 'That folder holds no SKILL.md, so there is no skill to import.',
  skill_not_importable: 'That skill cannot be imported as it stands.',
  over_limit: 'That repository is larger than the import limit.',
  refused_address: 'That address is not a public one, so this deployment will not fetch it.',
}

/**
 * One thing wrong with a candidate skill an import found (K1, K4).
 *
 * A **candidate** is a folder holding a `SKILL.md`; a problem is a reason it cannot be
 * imported as it stands, and a candidate carries every problem it has rather than the first,
 * so a preview can show a user the whole story of a folder at once. Nothing here fails the
 * preview: a repository holding one good skill and one broken one offers the good one, and the
 * broken one with its reasons.
 *
 * `code` is the stable half a client branches on, `message` the sentence it shows.
 */
export const SKILL_PROBLEM_CODES = [
  /** The `SKILL.md` has no frontmatter, or the YAML does not parse, or `name`/`description` are missing or malformed (K1). */
  'invalid-frontmatter',
  /** The frontmatter's `name` is not the folder's name (K1). */
  'name-mismatch',
  /** The name is a built-in slash command's ({@link RESERVED_SKILL_NAMES}, K7). */
  'reserved-name',
  /** Two candidates under the path would import under the same name. */
  'duplicate-name',
  /** One of the limits of K4 is broken: the `SKILL.md`, a file, the whole skill, or the file count. */
  'over-limit',
] as const

/** One of the reasons a candidate skill cannot be imported ({@link SKILL_PROBLEM_CODES}). */
export type SkillProblemCode = (typeof SKILL_PROBLEM_CODES)[number]

/** One reason a candidate cannot be imported as it stands. */
export const SkillProblemSchema = z.object({
  /** The stable code; see {@link SKILL_PROBLEM_CODES}. */
  code: z.enum(SKILL_PROBLEM_CODES),
  /** The sentence to show, naming the field or the limit it is about. */
  message: z.string(),
})

export type SkillProblem = z.infer<typeof SkillProblemSchema>

/**
 * One folder holding a `SKILL.md` that an import found, as a **preview** reports it (K3).
 *
 * Nothing has been stored: this is what the server would import, so the user can read the
 * `SKILL.md` and the file list and decide. `name` is the **folder's** name — the identity a
 * candidate is picked by, and the name the frontmatter has to agree with (K1) — while
 * `description` is the frontmatter's, or `null` when the frontmatter did not parse (`name`
 * then carries the folder's name alone, and what the frontmatter said is in its problems).
 *
 * `skill_md` is the **whole** `SKILL.md` — frontmatter and body — because that is what a
 * reader reviews before approving an import, and `files` is a listing (paths and sizes,
 * never contents) exactly as a stored skill's is.
 */
export const SkillImportCandidateSchema = z.object({
  /** The folder's name (K1) — the key an import picks this candidate by. */
  name: z.string(),
  /**
   * The folder's path in the repository, from the repository's root, forward-slashed.
   *
   * `""` is the repository's own root: a `SKILL.md` sitting there is a candidate like any other,
   * named (its `name`) for the repository rather than for a folder that does not exist.
   */
  folder: z.string(),
  /** The frontmatter's `description` (K1), or `null` when the frontmatter did not parse. */
  description: z.string().nullable(),
  /** The folder's files, relative to it, each with its size — never its content. */
  files: z.array(SkillFileSchema),
  /** `SKILL.md` as it is in the repository: the frontmatter, then the Markdown body. */
  skill_md: z.string(),
  /** Everything wrong with this candidate ({@link SkillProblemSchema}); empty when it is importable. */
  problems: z.array(SkillProblemSchema),
  /**
   * Whether the caller already has a skill by this name.
   *
   * A preview carries it — rather than leaving the client to diff two reads — because it is
   * the one reason a candidate a user picked will be refused on the import that follows, and
   * the store's rule is per user (K4). It is a separate field and not a {@link SkillProblem}:
   * nothing is wrong with the skill, and the answer a user wants is "you already have one of
   * these", which is not a shape a code could carry without naming the other skill.
   */
  name_taken: z.boolean(),
})

export type SkillImportCandidate = z.infer<typeof SkillImportCandidateSchema>

/**
 * Where an import is to read from: the repository, and the optional ref and path inside it.
 *
 * The three fields a user types, and the three `SkillSource` records. `ref` and `path` are
 * optional rather than nullable because a body names only what the user said — a browse URL
 * (`…/tree/<ref>/<path>`) fills them in server-side, and a repository's default branch is what
 * an absent `ref` means (K3).
 */
export const SkillImportSourceSchema = z.object({
  /** A public `https://` git URL, or a GitHub/GitLab browse URL (`…/tree/<ref>/<path>`). */
  url: z.string(),
  /** The branch, tag or commit to read, or absent for the repository's default branch. */
  ref: z.string().optional(),
  /** The folder inside the repository to look in, or absent for its root. */
  path: z.string().optional(),
})

export type SkillImportSource = z.infer<typeof SkillImportSourceSchema>

/**
 * Body of `POST /v1/me/skills/import/preview`. Response: {@link PreviewSkillImportResponseSchema}.
 *
 * The first of the import's two steps (K3): nothing is stored, and the answer is what a
 * repository holds under the path. The same body is the second step's, plus the commit the
 * preview resolved and the names the user picked — see {@link SkillImportRequestSchema}.
 */
export const PreviewSkillImportRequestSchema = SkillImportSourceSchema

export type PreviewSkillImportRequest = z.infer<typeof PreviewSkillImportRequestSchema>

/**
 * Response of `POST /v1/me/skills/import/preview`: the commit the clone landed on and every
 * candidate it found (K3).
 *
 * `url`, `ref` and `path` are the server's reading of the request — a browse URL arrives as
 * one string and leaves split in three — and `commit_sha` is the commit that reading landed
 * on. The three are echoed because they are what a following
 * {@link SkillImportRequestSchema} has to name, together with that commit, for the import to
 * be the one that was previewed.
 */
export const PreviewSkillImportResponseSchema = z.object({
  /** The `https://` git URL the clone was made from, with a browse URL split apart. */
  url: z.string(),
  /** The ref the clone was made at, or `null` for the repository's default branch. */
  ref: z.string().nullable(),
  /** The folder that was looked in, or `null` for the repository's root. */
  path: z.string().nullable(),
  /** The commit the clone landed on; an import naming this commit is the one that was previewed. */
  commit_sha: z.string(),
  /** Every `SKILL.md` under the path, each with its problems; empty only when there are none. */
  candidates: z.array(SkillImportCandidateSchema),
})

export type PreviewSkillImportResponse = z.infer<typeof PreviewSkillImportResponseSchema>

/**
 * Body of `POST /v1/me/skills/import`. Response: {@link ImportSkillsResponseSchema}.
 *
 * The second step (K3): the same source, the commit the preview resolved, and the **names** of
 * the candidates the user picked. The server clones again — it holds nothing between the two
 * calls — and refuses the import when the ref no longer resolves to `commit_sha`, so what is
 * stored is what was reviewed rather than whatever the branch has become. `names` is
 * deliberately the candidates' names and not their folders: a name is what a skill is
 * identified by among its owner's skills (K4), and a candidate whose name is `null` could not
 * be stored under one anyway.
 */
export const SkillImportRequestSchema = SkillImportSourceSchema.extend({
  /** The commit the preview resolved; the clone must land on it again or the import is refused. */
  commit_sha: z.string(),
  /** The names of the candidates to import, at least one, as the preview spelled them. */
  names: z.array(z.string()).min(1),
})

export type SkillImportRequest = z.infer<typeof SkillImportRequestSchema>

/**
 * Response of `POST /v1/me/skills/import`: the skills that were stored, in the order asked for.
 *
 * The same envelope {@link ListSkillsResponseSchema} uses — a `data` array, no pagination —
 * because the answer is the resources themselves, so a client can draw the new rows without a
 * second read.
 *
 * The whole batch is stored or nothing is (the same rule every other write here follows): a
 * picked name that is not a candidate is the 400 `invalid_request_error`, a picked candidate
 * that still has a problem is the 422 `skill_import_error` carrying that candidate's own
 * problems, and a name the caller already has is the 409 `conflict_error` the store raises —
 * each of them before the first skill is written.
 */
export const ImportSkillsResponseSchema = z.object({
  data: z.array(SkillSchema),
})

export type ImportSkillsResponse = z.infer<typeof ImportSkillsResponseSchema>

/**
 * Body of `POST /v1/me/skills/{skill_id}/refresh`. Response: {@link SkillSchema}.
 *
 * A refresh is by hand and always previewed first (K5): the preview clones the skill's stored
 * source again and answers what changed, and this confirms it by naming the commit the preview
 * resolved. As with an import, a ref that has moved since the preview is refused, so what a
 * user confirmed is what gets stored.
 */
export const RefreshSkillRequestSchema = z.object({
  /** The commit the refresh preview resolved. */
  commit_sha: z.string(),
})

export type RefreshSkillRequest = z.infer<typeof RefreshSkillRequestSchema>

/**
 * Response of `POST /v1/me/skills/{skill_id}/refresh/preview`: what a re-clone found (K5).
 *
 * The clone is of the skill's **stored** source — the same URL, ref and path it was imported
 * from — and the comparison is against the stored snapshot, so nothing here depends on the
 * caller remembering anything. `changed` is the whole answer in one boolean (a client that
 * only wants to offer a button reads it and skips the rest); the three lists are the file
 * story, and `skill_md_diff` is the unified diff of the one file a skill is really read by.
 *
 * The lists hold **paths** (relative to the skill folder) rather than listings, because what a
 * reader wants from a diff is which files moved; the sizes are on the snapshot the skill
 * already carries.
 */
export const RefreshSkillPreviewResponseSchema = z.object({
  /** The commit the re-clone landed on. */
  commit_sha: z.string(),
  /**
   * Whether anything at all is different from the stored snapshot — the three lists empty and
   * no diff. `false` is the "already up to date" answer, and it is still a commit: a refresh
   * preview of an unchanged skill names the commit it is unchanged at, so a confirm is
   * still possible (and is a no-op on the snapshot but moves `refreshed_at`).
   */
  changed: z.boolean(),
  /** Files the new snapshot has and the stored one does not. */
  files_added: z.array(z.string()),
  /** Files the stored snapshot has and the new one does not. */
  files_removed: z.array(z.string()),
  /** Files both hold with different content. */
  files_changed: z.array(z.string()),
  /** The unified diff of `SKILL.md`, or `null` when that file is unchanged. */
  skill_md_diff: z.string().nullable(),
  /**
   * Everything wrong with the new snapshot (K1, K4).
   *
   * A refresh is not refused by a preview: a repository that has since grown a `SKILL.md` over
   * the limit is shown as such, and whether to keep the snapshot the user has is the user's
   * answer to give. A confirm of a snapshot with a problem is the one thing the route refuses
   * — replacing a working skill with a broken one is not a refresh.
   */
  problems: z.array(SkillProblemSchema),
})

export type RefreshSkillPreviewResponse = z.infer<typeof RefreshSkillPreviewResponseSchema>

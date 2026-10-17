import { z } from 'zod'

import { TimestampSchema } from '../common'
import { SkillIdSchema } from '../ids'
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
 * The size of a file's content in bytes — what {@link SkillFile.size} counts.
 *
 * Bytes rather than characters, because a limit of "20 KB" has to mean the same thing for a
 * file of ASCII and a file of CJK or emoji: `TextEncoder` counts what would really be stored,
 * and it is a Web API both a browser and Node 24 have, so this package stays browser-safe.
 */
export function skillFileSize(content: string): number {
  return new TextEncoder().encode(content).length
}

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
  /** The content's size in bytes (see {@link skillFileSize}). */
  size: z.number().int().min(0),
  /** The file's content, as the snapshot holds it. */
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

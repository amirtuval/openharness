/**
 * `skill` and `skill_read`: the model's way to read what a user imported (epic #349, K6).
 *
 * A **skill** is a folder of instructions in the open Agent Skills format (K1) that a user
 * imported and reviewed (K3). Two tools serve it, and both are **reads of a snapshot**:
 *
 * - `skill { name }` answers a skill's instructions — `SKILL.md` with its frontmatter stripped
 *   ({@link skillBody}) — and the list of files the folder holds.
 * - `skill_read { name, path }` answers one of those files.
 *
 * Nothing runs. A skill's folder may hold scripts, and the model may read them, but this build
 * executes nothing it finds there (K2): the tools are text, the sandbox is the one that makes
 * every other built-in a read, and the listing says so in as many words
 * ({@link SKILL_SCRIPTS_NOTICE}) so a model does not waste a turn trying.
 *
 * ## What the tools are handed, and why they are built per request
 *
 * Which skills a chat has is the **user's** (K8): a skill's own `enabled`, overridden by the
 * mode the chat follows, resolved per request. So the set is not a host's registry tool but a
 * value a request builds from — {@link SkillToolOptions.skills} — and the deployment's own
 * listing has to know the two names to offer a switch for them
 * (`@openharness/brain`'s `SKILL_TOOL_DECLARATIONS`).
 *
 * `skill`'s **description is the listing** (K6): every skill the model may invoke, by name and
 * description, with the K2 note. It is built from the request's own skills, which is why the
 * tools cannot be one fixed `ToolDefinition` — and why a chat with no skill has neither tool
 * offered at all (the loop builds no registry for it).
 *
 * A skill marked `disable-model-invocation: true` is *not* in the listing and **both** tools
 * refuse it with the reason (K6, K7): the field means the user runs this command and the model
 * does not, and a refusal that said "no such skill" would invite the model to try the name
 * again. A `skill_read` that could still read it would be the same bypass from the other side.
 */

import { SKILL_MD_FILENAME, skillBody, skillSettingsOf } from '@openharness/protocol'
import type { Skill } from '@openharness/protocol'
import { z } from 'zod'

import { errorResult, textResult } from './tool'
import type { ToolDefinition } from './tool'

/** The name the model calls the tool by: read a skill's instructions. */
export const SKILL_TOOL_NAME = 'skill'

/** The name the model calls the tool by: read one file of a skill. */
export const SKILL_READ_TOOL_NAME = 'skill_read'

/**
 * How many characters of the **listing** the `skill` tool's description may carry (K6).
 *
 * The description is what a model reads before it decides to call anything, so it is worth
 * paying for — but it is paid on every request of every chat that has a skill, and a user may
 * hold fifty of them. The budget is shared equally between the skills present (see
 * {@link skillListingDescription}), so the cost is bounded whatever a snapshot says and one
 * long description cannot crowd the others out of the list entirely.
 */
export const SKILL_LISTING_MAX_CHARS = 4_000

/**
 * The shortest a cut description is worth showing: below this it would be an ellipsis and no
 * content, and the name alone says more.
 */
export const SKILL_LISTING_MIN_DESCRIPTION_CHARS = 40

/**
 * How much of a `skill` result a model request keeps (epic #303, X9; #306).
 *
 * The tool's own declaration of what its output costs: a `SKILL.md` is at most
 * `SKILL_MD_MAX_BYTES` (20 KB, about five thousand tokens), so this is above anything the file
 * bound can produce and the brain's share of the chat model's budget is what normally binds.
 */
export const SKILL_TOOL_MAX_RESULT_TOKENS = 8_192

/**
 * How much of a `skill_read` result a model request keeps (epic #303, X9; #306).
 *
 * Larger than {@link SKILL_TOOL_MAX_RESULT_TOKENS} because one file of a skill may be
 * `SKILL_FILE_MAX_BYTES` (256 KB, about sixty-four thousand tokens) — a reference document is
 * exactly what a skill's other files are for — and the result is a read the model asked for by
 * name. It is still a declaration rather than a claim: the brain caps a result to the smaller of
 * this and a fifth of the chat model's budget.
 */
export const SKILL_READ_MAX_RESULT_TOKENS = 16_384

/**
 * What the listing says about K2, in the model's own terms.
 *
 * Instruction skills only: the model can read every file of a skill, scripts included, and
 * nothing in this environment runs one. Saying it in the description is the cheapest place — a
 * model that knows it will not plan around a script it cannot run — and it is the whole of the
 * epic's K2 as far as the model is concerned.
 */
export const SKILL_SCRIPTS_NOTICE =
  'A skill is instructions and files only: a script it contains cannot be run in this ' +
  'environment, so read one as text rather than expecting to execute it.'

/** The input a `skill` call carries: the skill's name. */
export const SkillInputSchema = z.object({
  /** The skill's name, as the listing spells it. */
  name: z.string().min(1),
})

/** What a `skill` call carries. */
export type SkillInput = z.infer<typeof SkillInputSchema>

/** The input a `skill_read` call carries: the skill's name, and the file's path inside it. */
export const SkillReadInputSchema = z.object({
  /** The skill's name, as the listing spells it. */
  name: z.string().min(1),
  /** The file's path inside the skill folder, relative and forward-slashed (`reference/tone.md`). */
  path: z.string().min(1),
})

/** What a `skill_read` call carries. */
export type SkillReadInput = z.infer<typeof SkillReadInputSchema>

/**
 * One skill a request may use: its resource, and how to read its snapshot.
 *
 * The resource carries what the listing needs — the name and the description — and the honoured
 * frontmatter fields ({@link skillSettingsOf}); `readFile` answers one file of the snapshot by
 * path, or `null` for a path it does not hold. The read is a function rather than the files
 * themselves because a snapshot is up to 2 MB: a request listings fifty skills must not read
 * fifty folders to answer a question about their names.
 *
 * The host builds one of these per skill in force — the store has the contents, the brain never
 * does — and that is the whole of the seam between this tool and a deployment's storage.
 */
export interface OfferedSkill {
  /** The skill's resource: its name, description, frontmatter and file listing. */
  readonly skill: Skill
  /**
   * Read one file of this skill's snapshot, or `null` when it holds no file at that path.
   *
   * Called with a path a **model** produced, so an implementation must answer `null` rather than
   * raise for one its snapshot does not hold — and `null` for another owner's skill too, which
   * is the store's own rule (`@openharness/session`'s `SkillStore.getFile`).
   */
  readonly readFile: (path: string) => Promise<string | null>
}

/** What {@link createSkillTools} is handed: the skills a request has. */
export interface SkillToolOptions {
  /** The skills in force for the request, oldest first — `disable-model-invocation` ones included. */
  readonly skills: readonly OfferedSkill[]
}

/**
 * The `skill` and `skill_read` definitions a request offers, or an empty list for a request that
 * offers neither (K6).
 *
 * The two are built together because they answer one question over one set: neither is offered
 * without a skill the model may actually invoke, and both refuse the same names for the same
 * reasons. A caller — the loop — puts them in the request's registry and leaves the deciding to
 * {@link skillToolsOffered}.
 */
export function createSkillTools(options: SkillToolOptions): ToolDefinition[] {
  return [createSkillTool(options), createSkillReadTool(options)]
}

/** Whether a request with these skills offers the two tools at all (K6). */
export function skillToolsOffered(skills: readonly OfferedSkill[]): boolean {
  return modelInvocable(skills).length > 0
}

/**
 * `skill`: read a skill's instructions, and list its files.
 *
 * The description is the listing (K6) — every skill the model may invoke, with the K2 note —
 * and the result is the skill's body with its frontmatter removed, capped by the brain like
 * every other result. The body is the **user's own instructions**, not third-party data: there
 * is no untrusted-content notice here, and a skill cannot grant a permission it does not have
 * (K10) — the tools a call may make are the request's offer, whatever a skill's frontmatter
 * says.
 */
export function createSkillTool(options: SkillToolOptions): ToolDefinition<SkillInput> {
  const { skills } = options
  return {
    name: SKILL_TOOL_NAME,
    description: skillListingDescription(skills),
    inputSchema: SkillInputSchema,
    permission: 'allow',
    maxResultTokens: SKILL_TOOL_MAX_RESULT_TOKENS,
    run: async (input) => {
      const refusal = skillRefusal(skills, input.name)
      if (refusal !== null) {
        return errorResult(refusal)
      }
      const offered = skillNamed(skills, input.name)
      if (offered === undefined) {
        return errorResult(unknownSkill(skills, input.name))
      }
      const content = await offered.readFile(SKILL_MD_FILENAME)
      if (content === null) {
        // A skill always holds a `SKILL.md` — the store refuses a snapshot without one (K1) —
        // so this is a broken invariant rather than a name the model got wrong, and the answer
        // says what is missing instead of pretending the skill does not exist.
        return errorResult(
          `The ${SKILL_MD_FILENAME} file of ${JSON.stringify(input.name)} could not be read. ` +
            'The skill’s snapshot holds none, which should not happen.',
        )
      }
      return textResult(renderSkill(input.name, skillBody(content), offered.skill))
    },
  }
}

/**
 * `skill_read`: one file of a skill, as text.
 *
 * A file whose bytes are not UTF-8 text — an image, an archive, a compiled script — is answered
 * with a marker naming the path and the size rather than its content: the protocol's messages
 * are text, and storing mojibake as if it were readable is worse than saying what it is (K2).
 * An unknown path is an `is_error` listing the files the skill really holds, which is what a
 * model that guessed a name needs.
 */
export function createSkillReadTool(options: SkillToolOptions): ToolDefinition<SkillReadInput> {
  const { skills } = options
  return {
    name: SKILL_READ_TOOL_NAME,
    description:
      'Read one file of a skill this chat has, by the skill’s name and the file’s path ' +
      'inside it (as `skill` lists them). The content is text and nothing runs it: a file that ' +
      'is not text is reported as such rather than returned.',
    inputSchema: SkillReadInputSchema,
    permission: 'allow',
    maxResultTokens: SKILL_READ_MAX_RESULT_TOKENS,
    run: async (input) => {
      const refusal = skillRefusal(skills, input.name)
      if (refusal !== null) {
        return errorResult(refusal)
      }
      const offered = skillNamed(skills, input.name)
      if (offered === undefined) {
        return errorResult(unknownSkill(skills, input.name))
      }
      const content = await offered.readFile(input.path)
      if (content === null) {
        return errorResult(
          `${JSON.stringify(input.path)} is not a file of ${JSON.stringify(input.name)}. ` +
            `${fileList(offered.skill)}`,
        )
      }
      const size = sizeOf(offered.skill, input.path, content)
      if (looksBinary(content)) {
        return textResult(
          `${input.path} is a binary file of ${size} bytes, so its contents are not shown ` +
            'here. A skill is instructions and files to read; nothing runs one.',
        )
      }
      return textResult(content)
    },
  }
}

/**
 * The `skill` tool's description: the listing K6 asks for.
 *
 * Every skill the model may invoke, in the order the host listed them (oldest first), each as
 * `name: description`, then the K2 note. The descriptions share
 * {@link SKILL_LISTING_MAX_CHARS} equally — a whole listing is paid for on every request — and
 * one that is cut ends in an ellipsis, so a model can tell a short description from a
 * shortened one. Names are never cut: a name the model cannot read back is a name it cannot
 * call.
 *
 * A skill marked `disable-model-invocation: true` is left out entirely (K6): it is the user's
 * command, and a listing that named it would be inviting a call the tool then refuses.
 */
export function skillListingDescription(skills: readonly OfferedSkill[]): string {
  const listed = modelInvocable(skills)
  const head =
    'The user’s skills: reusable instructions they imported. Call this with a skill’s ' +
    'name to read its instructions, and `skill_read` to read one of its files. ' +
    SKILL_SCRIPTS_NOTICE
  if (listed.length === 0) {
    return `${head}\n\nThis chat has no skills available to you.`
  }
  const share = Math.max(
    SKILL_LISTING_MIN_DESCRIPTION_CHARS,
    Math.floor(SKILL_LISTING_MAX_CHARS / listed.length),
  )
  const lines = listed.map((offered) => {
    const description = cut(offered.skill.description.trim(), share)
    return description.length === 0
      ? `- ${offered.skill.name}`
      : `- ${offered.skill.name}: ${description}`
  })
  return `${head}\n\nSkills available in this chat:\n${lines.join('\n')}`
}

/**
 * Why a skill the model named may not be used, or `null` when it may.
 *
 * One reason, and one wording for it: a skill marked `disable-model-invocation: true` (K6) is
 * the user's command, and both tools refuse it — reading its instructions is the same thing as
 * invoking it, from the model's side.
 */
function skillRefusal(skills: readonly OfferedSkill[], name: string): string | null {
  const offered = skillNamed(skills, name)
  if (offered === undefined || !skillSettingsOf(offered.skill).disableModelInvocation) {
    return null
  }
  return (
    `${JSON.stringify(name)} is marked "disable-model-invocation", so only the user can run ` +
    'it. Carry on without it, or ask the user to run it themselves.'
  )
}

/** What a name no skill carries is answered with: the names that are there (K6). */
function unknownSkill(skills: readonly OfferedSkill[], name: string): string {
  const listed = modelInvocable(skills)
  if (listed.length === 0) {
    return `No skill named ${JSON.stringify(name)} is available to you: this chat has none.`
  }
  return (
    `No skill named ${JSON.stringify(name)} is available to you. The skills this chat has ` +
    `are: ${listed.map((offered) => offered.skill.name).join(', ')}.`
  )
}

/** The skills the model may invoke: everything in force except the user-only ones (K6). */
function modelInvocable(skills: readonly OfferedSkill[]): OfferedSkill[] {
  return skills.filter((offered) => !skillSettingsOf(offered.skill).disableModelInvocation)
}

/** The offered skill of that name, or `undefined`. */
function skillNamed(skills: readonly OfferedSkill[], name: string): OfferedSkill | undefined {
  return skills.find((offered) => offered.skill.name === name)
}

/** The `skill` result: the instructions, then the files a `skill_read` could read. */
function renderSkill(name: string, body: string, skill: Skill): string {
  const instructions = body.length === 0 ? '(this skill has no instructions)' : body
  return `${name}\n\n${instructions}\n\n${fileList(skill)}`
}

/** A skill's files, as both tools list them. */
function fileList(skill: Skill): string {
  if (skill.files.length === 0) {
    return 'This skill holds no files.'
  }
  const lines = skill.files.map((file) => `- ${file.path} (${file.size} bytes)`)
  return `Files (read one with ${SKILL_READ_TOOL_NAME}):\n${lines.join('\n')}`
}

/** The size a listing reports for a path, falling back to what the content really is. */
function sizeOf(skill: Skill, path: string, content: string): number {
  return (
    skill.files.find((file) => file.path === path)?.size ?? new TextEncoder().encode(content).length
  )
}

/** `text` cut to `max` characters, with an ellipsis where the rest went. */
function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

/**
 * Whether a file's content is not text this protocol can carry (K2).
 *
 * A snapshot stores a file **as the text it was read as**, so a binary file reaches here as a
 * string that decodes nothing: the import's decoder left U+FFFD where it could not read a byte.
 * Three signals, and any of them is enough — a NUL, which no text file holds; a replacement
 * character, which is a byte that was not valid UTF-8; or a tenth of the content being control
 * characters other than tab, newline and carriage return, which is what a compressed or
 * compiled file looks like once it has been decoded as text.
 *
 * It is a reading and not a promise: a file this misses is returned as text, which is what the
 * model asked for and what a request may cap.
 */
export function looksBinary(content: string): boolean {
  if (content.length === 0) {
    return false
  }
  let controls = 0
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0 || code === 0xfffd) {
      return true
    }
    // C0 controls other than tab (9), newline (10) and carriage return (13), and the C1 range.
    const isControl =
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)
    if (isControl) {
      controls += 1
    }
  }
  return controls * 10 > content.length
}

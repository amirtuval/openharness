import { skillsInForce, skillSettingsOf } from '@openharness/protocol'
import type {
  MessageSkill,
  ModeToolOverride,
  RefreshSkillPreviewResponse,
  ReservedSkillName,
  Skill,
  SkillFile,
  SkillImportCandidate,
  SkillSource,
} from '@openharness/protocol'

/**
 * The `/` menu and the slash invocation both frontends share (epic #349, K7; issue #353).
 *
 * Typing `/` in the composer opens one menu with two kinds of row in it, and the difference
 * between them is the whole of this module:
 *
 * - a **built-in command** is a **client action** — `/compact` asks the brain to summarize the
 *   older history — and it is never sent as a message and never a skill;
 * - a **skill** is one of the reader's own imported skills, and `/release-notes v1.2` sends an
 *   ordinary `user.message` whose text is what they typed, carrying `skill: { name, arguments }`
 *   so the brain loads the skill's instructions into that turn (K7).
 *
 * Both the web app and `oh` read the menu from here, so the two frontends cannot offer
 * different commands or send a different event for the same line — and neither can disagree
 * with the built-in names a skill may never take (`RESERVED_SKILL_NAMES`).
 *
 * The parse is deliberately strict, exactly as the composer's one command always was: a line is
 * a command only when its **first** token is `/` immediately followed by the whole name of one
 * of the commands on offer. `/Compact`, `/comp` and `hello /compact` are ordinary messages, and
 * so is `/not-a-skill` — nothing a reader writes as prose is swallowed, and a name nothing
 * offers is sent as words rather than as a skill the server would refuse.
 */

/**
 * One built-in slash command: an action the client runs, and never a skill (K7).
 *
 * The list is short on purpose — one entry today, `/compact [instructions]` (#283) — because a
 * built-in is only a command when the thing it does exists: a menu row that did nothing would
 * be worse than no row. The rest of {@link RESERVED_SKILL_NAMES} is what those rows will take
 * as they land (`/new`, `/model`, `/mode`, `/agents`, `/skills`), and reserving them now is
 * what keeps a skill from taking a name the menu is going to need: a skill named `model` would
 * be unreachable here and ambiguous in a transcript.
 */
export interface BuiltinCommand {
  /** The name without its slash — the token that selects it. Must be a reserved name. */
  readonly name: ReservedSkillName
  /** The usage line a hint or a menu row shows, brackets and all. */
  readonly usage: string
  /** One line saying what running it does. */
  readonly description: string
}

/**
 * Every built-in command the `/` menu offers, in the order it lists them.
 *
 * `slashCommands` puts these rows above the reader's skills, so the commands that always exist
 * are in a stable place and the skill rows grow under them. The names are all members of
 * `RESERVED_SKILL_NAMES` — a test holds the list to it — so a built-in can never collide with
 * an importable skill name.
 */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  {
    name: 'compact',
    usage: '/compact [instructions]',
    description: 'Summarize the older history now',
  },
]

/**
 * One row of the `/` menu: a built-in command, or one of the reader's skills.
 *
 * Two shapes in one shape, because the menu is one list: `kind` is what a caller branches on to
 * decide what a pick *does* — run the action, or fill the box with `/name ` and let the send
 * carry the `skill` — and `skillId`/`argumentHint` are what only a skill row has.
 */
export interface SlashCommand {
  /** The name without its slash: what a line's first token is matched against. */
  readonly name: string
  /** Whether this row is a client action or one of the reader's skills. */
  readonly kind: 'builtin' | 'skill'
  /** What the row says about itself: the command's sentence, or the skill's description. */
  readonly description: string
  /**
   * The usage a hint shows: `/compact [instructions]` for a built-in, and `/name <hint>` (or
   * just `/name`) for a skill that names an `argument-hint`.
   */
  readonly usage: string
  /** The skill's `argument-hint` (K1, K7), or `null` when it names none — or is a built-in. */
  readonly argumentHint: string | null
  /** The `skl_` id a skill row stands for, or `null` for a built-in. */
  readonly skillId: string | null
}

/**
 * The whole `/` menu: the built-in commands, then the reader's own usable skills (K7).
 *
 * A skill is offered when it is **on in this chat** and **user-invocable** (K1, K8) — a skill
 * whose frontmatter says `user-invocable: false` is one only the model uses, so it is not a
 * command the reader can type and never appears here. `disable-model-invocation` is the other
 * way round and does not filter a row out: a command only the reader runs is exactly what the
 * menu is for.
 *
 * **"On" is the effective answer**, not the stored switch: when the chat follows a mode, the
 * mode's `tools.skills` patch applies over the user's `enabled` — the same rule the server's
 * `assertInvocableSkills` and `listSkillsInForce` apply, read from
 * `@openharness/protocol`'s `skillsInForce` so a menu row and the server cannot disagree. A
 * menu built from `skill.enabled` alone offers a skill the server answers 400 for (the mode
 * turned it off) and hides one the server would accept (the mode turned it on).
 *
 * The skills are listed in the order the caller passes them (the API's own order, oldest
 * first), so two screens reading the same list build the same menu.
 *
 * @param skills the reader's skills, as `GET /v1/me/skills` answered — the stored `enabled`
 * @param override the tool override of the mode the chat follows (`Mode.tools`), or `null`/absent
 *   for a chat that follows none
 */
export function slashCommands(
  skills: readonly Skill[],
  override: ModeToolOverride | null = null,
): readonly SlashCommand[] {
  return [
    ...BUILTIN_COMMANDS.map((command): SlashCommand => ({
      name: command.name,
      kind: 'builtin',
      description: command.description,
      usage: command.usage,
      argumentHint: null,
      skillId: null,
    })),
    ...skillsInForce(skills, override)
      .filter(isInvocableSkill)
      .map((skill): SlashCommand => {
        const hint = skillSettingsOf(skill).argumentHint
        return {
          name: skill.name,
          kind: 'skill',
          description: skill.description,
          usage: hint === null ? `/${skill.name}` : `/${skill.name} <${hint}>`,
          argumentHint: hint,
          skillId: skill.id,
        }
      }),
  ]
}

/**
 * Whether a skill is one the reader can type: `user-invocable` (K1, K7).
 *
 * The on/off half is already answered by {@link skillsInForce} — and must be, because a mode
 * may turn a stored-off skill on (K8), so reading `skill.enabled` here would undo the override.
 */
function isInvocableSkill(skill: Skill): boolean {
  return skillSettingsOf(skill).userInvocable
}

/**
 * The word being typed after the `/`, or `null` when the box is not naming one.
 *
 * This is what a composer watches to open and filter the menu: `''` for a bare `/` (the menu
 * opens showing everything), `'co'` for `/co`, and `null` once the box has moved past the name
 * — `/compact keep the API decisions` is arguments, not a name — or is not a command line at
 * all. A `/` anywhere but the first non-space character is not one either: a sentence that
 * happens to contain a slash is a sentence.
 *
 * @param value the composer's current text
 */
export function slashCommandQuery(value: string): string | null {
  const trimmed = value.trimStart()
  if (!trimmed.startsWith('/')) {
    return null
  }
  const token = trimmed.slice(1)
  if (/\s/.test(token)) {
    return null
  }
  return token
}

/**
 * The rows a menu should show for what is being typed, in the order it shows them.
 *
 * A prefix match on the name, case-insensitively: `/` (`query` `''`) offers everything, `/co`
 * offers `/compact`, and `/release` offers the skills whose names start that way. A query
 * matching nothing answers an empty list, which is a menu that closes rather than a menu with a
 * wrong row in it — the line is an ordinary message then, and the next keystroke decides.
 *
 * @param commands the whole menu, from {@link slashCommands}
 * @param query the word after the `/`, from {@link slashCommandQuery}
 */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
): readonly SlashCommand[] {
  const needle = query.toLowerCase()
  return commands.filter((command) => command.name.toLowerCase().startsWith(needle))
}

/** The part of a `/` menu row {@link slashEnterAction} reads: its name and what kind of row it is. */
export interface SlashMenuRow {
  /** The name without its slash: what a line's first token is matched against. */
  readonly name: string
  /** Whether this row is a client action or one of the reader's skills. */
  readonly kind: 'builtin' | 'skill'
}

/** What pressing Enter means for the line in a `/` menu's box. */
export type SlashEnterAction =
  /** Run the built-in command now — the line names it in full and has nothing else to type. */
  | { readonly kind: 'run'; readonly name: string }
  /** Fill the box with `/name `, so the command's arguments can be typed next. */
  | { readonly kind: 'complete'; readonly name: string }
  /** Send the line: it is arguments (`/name args`), an ordinary message, or a miss. */
  | { readonly kind: 'send' }

/**
 * Decide what Enter does with the line a reader has typed in a `/` menu's box (K7; #354).
 *
 * The one rule both frontends use, so `oh` and the web app cannot disagree about what a keypress
 * does:
 *
 * - a **built-in** the box names **in full** is a command with nothing left to type (`/compact`,
 *   and `/new`, `/mode` as their rows land), so Enter **runs** it rather than filling the box a
 *   second time;
 * - a **skill** is never run from the menu — `/name arguments` is sent as an ordinary message
 *   carrying `skill` (K7) — so a row the reader is looking at is **completed** to `/name `, which
 *   is what makes its `argument-hint` the box's placeholder and lets the arguments follow;
 * - anything else — arguments already typed (`/name args`), a name nothing offers, or an ordinary
 *   message — is **sent**, the behaviour the box always had.
 *
 * A line that only *starts* a name completes to the row the reader is on — the `highlighted`
 * row, the one the arrows moved to — rather than to the first match.
 *
 * @param value the box's current text
 * @param commands the whole menu, from {@link slashCommands}
 * @param highlighted the row the menu is on, when it is up
 */
export function slashEnterAction(
  value: string,
  commands: readonly SlashMenuRow[],
  highlighted?: SlashMenuRow,
): SlashEnterAction {
  const query = slashCommandQuery(value)
  // Arguments are being typed, or the line is not a command line: Enter sends, as it always has.
  if (query === null) {
    return { kind: 'send' }
  }
  const exact = commands.find((command) => command.name === query)
  if (exact !== undefined && exact.kind === 'builtin') {
    return { kind: 'run', name: exact.name }
  }
  const row = highlighted ?? exact
  return row === undefined ? { kind: 'send' } : { kind: 'complete', name: row.name }
}

/**
 * A line the reader typed that names one of the commands on offer.
 *
 * `text` is what the message's content is when the command is a skill — what they typed, as
 * the protocol requires (K7) — and `arguments` is the rest of the line, trimmed, or `null` when
 * there was none.
 */
export interface SlashInvocation {
  /** The line as it will be stored: the whole command line, with its outer whitespace trimmed. */
  readonly text: string
  /** The command the line names. */
  readonly command: SlashCommand
  /** Everything after the name, trimmed, or `null` when the line carried nothing else. */
  readonly arguments: string | null
}

/**
 * Read a composer line as one of the commands on offer, or as nothing.
 *
 * The one parse both frontends use before sending: a line that names a command is an
 * invocation, and a line that names none is an ordinary message the caller sends as words.
 * Only the exact spelling of a name is accepted — the whole first token, matched against the
 * list — so a partially typed `/comp` is not `/compact`, and a message that opens with a slash
 * something else wrote is not a command.
 *
 * @param value the composer's current text
 * @param commands the whole menu, from {@link slashCommands}
 */
export function parseSlashCommand(
  value: string,
  commands: readonly SlashCommand[],
): SlashInvocation | null {
  const trimmed = value.trim()
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (match === null) {
    return null
  }
  const name = match[1] ?? ''
  const command = commands.find((candidate) => candidate.name === name)
  if (command === undefined) {
    return null
  }
  const rest = (match[2] ?? '').trim()
  return { text: trimmed, command, arguments: rest === '' ? null : rest }
}

/**
 * The `skill` field a slash invocation rides on its `user.message`, or `null` for a built-in.
 *
 * A built-in command is a client action and never an invocation of a skill (K7), so it answers
 * `null` — the caller runs the action instead of sending anything. A skill's arguments are
 * omitted rather than sent as an empty string, so the brain substitutes `$ARGUMENTS` only when
 * there were words to substitute (and appends nothing when there were none).
 */
export function invocationSkill(invocation: SlashInvocation): MessageSkill | null {
  if (invocation.command.kind !== 'skill') {
    return null
  }
  return {
    name: invocation.command.name,
    ...(invocation.arguments === null ? {} : { arguments: invocation.arguments }),
  }
}

/**
 * Whether a built-in command name is one a skill may not take — the invariant between the menu
 * and the reserved list, as a function so the test that holds them together reads as one.
 */
export function isBuiltinCommandName(name: string): boolean {
  return BUILTIN_COMMANDS.some((command) => command.name === name)
}

/**
 * The badge a skill's row carries, or `null` for a skill with both halves available (K1).
 *
 * Two frontmatter fields change who can use a skill, and a reader looking at a list of them
 * cannot see which — so each is named on the row: `command only` for
 * `disable-model-invocation: true` (the model is never told it exists, K6) and `model only` for
 * `user-invocable: false` (it is not a command they can type, K7). Read through
 * `skillSettingsOf` so the words and the behaviour cannot disagree.
 */
export function skillBadgeLabel(skill: Skill): string | null {
  const settings = skillSettingsOf(skill)
  if (settings.disableModelInvocation) {
    return 'command only'
  }
  if (!settings.userInvocable) {
    return 'model only'
  }
  return null
}

/**
 * A short, stable rendering of a commit id: the first seven characters Git itself would print.
 *
 * @param sha a full commit sha, as a skill's source records it
 */
export function shortCommit(sha: string): string {
  return sha.slice(0, 7)
}

/**
 * Where a skill came from, as one line: the URL, the ref and path it was taken at, and the
 * commit it landed on (K3, K4).
 *
 * It is what a settings row shows under a skill's name — the URL is the reader's own input
 * (they can re-run the same clone by hand from it), the ref and path are the two fields they
 * had to open **Advanced** to name, and the commit is what the snapshot really is: a branch
 * that moves does not change what was imported. A snapshot nothing cloned (a test's own skill)
 * has no commit and reads as just the URL.
 */
export function skillSourceLabel(source: SkillSource): string {
  const parts = [source.url]
  if (source.ref !== null) {
    parts.push(source.ref)
  }
  if (source.path !== null) {
    parts.push(source.path)
  }
  const where = parts.join(' · ')
  return source.commit_sha === null ? where : `${where} @ ${shortCommit(source.commit_sha)}`
}

/** A byte count as a reader reads it: `312 B`, `1.2 KB`, `2.4 MB`. */
export function skillFileSizeLabel(size: number): string {
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Whether a previewed candidate can be imported as it stands (K3).
 *
 * Two things stop one, and they are kept apart by the protocol because they mean different
 * things: the candidate's own `problems` (bad frontmatter, a name that is not the folder's, a
 * reserved name, a limit of K4) and `name_taken` (nothing is wrong with the skill — the reader
 * already has one of these). Either way the checkbox is off and cannot be turned on, because
 * the import is refused rather than fixed by picking it.
 */
export function candidateSelectable(candidate: SkillImportCandidate): boolean {
  return candidate.problems.length === 0 && !candidate.name_taken
}

/** The names of the candidates a preview offers that could really be imported. */
export function importableCandidateNames(candidates: readonly SkillImportCandidate[]): string[] {
  return candidates.filter(candidateSelectable).map((candidate) => candidate.name)
}

/** One file a refresh would change, and how (K5). */
export interface RefreshFileChange {
  /** What happened to the file. */
  readonly kind: 'added' | 'removed' | 'changed'
  /** The file's path inside the skill folder. */
  readonly path: string
}

/**
 * Every file a refresh preview would change, in one list — added first, then removed, then
 * changed, which is the order the protocol's three lists are read in.
 *
 * @param preview a refresh preview's answer
 */
export function refreshFileChanges(
  preview: RefreshSkillPreviewResponse,
): readonly RefreshFileChange[] {
  return [
    ...preview.files_added.map((path): RefreshFileChange => ({ kind: 'added', path })),
    ...preview.files_removed.map((path): RefreshFileChange => ({ kind: 'removed', path })),
    ...preview.files_changed.map((path): RefreshFileChange => ({ kind: 'changed', path })),
  ]
}

/**
 * What a refresh preview came to, in one sentence — `unchanged`, or what moved (K5).
 *
 * The count is the whole answer for a reader deciding whether to confirm: `2 files added, 1
 * changed`. `SKILL.md` is not called out separately, because it is one of the files the three
 * lists hold and the diff beside this sentence is where it is read.
 *
 * @param preview a refresh preview's answer
 */
export function refreshChangeSummary(preview: RefreshSkillPreviewResponse): string {
  if (!preview.changed) {
    return 'unchanged'
  }
  const counts: readonly (readonly [number, string])[] = [
    [preview.files_added.length, 'added'],
    [preview.files_removed.length, 'removed'],
    [preview.files_changed.length, 'changed'],
  ]
  const parts = counts
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${count === 1 ? 'file' : 'files'} ${word}`)
  // `changed` with nothing in the three lists is a `SKILL.md` that differs in a way the lists
  // do not describe — the one thing the boolean and the lists disagree about — so say so
  // rather than printing an empty summary.
  return parts.length === 0 ? 'the snapshot differs' : parts.join(', ')
}

/**
 * The files of a skill or a candidate as one list a screen reads: each path and how big it is.
 *
 * A thin pass-through today, and here for the reason the rest of this module is: the two
 * previews, the stored resource and both frontends all show "the files" and must show the same
 * ones in the same order.
 */
export function skillFileList(files: readonly SkillFile[]): readonly SkillFile[] {
  return [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
}

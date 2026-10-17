import {
  candidateSelectable,
  importableCandidateNames,
  shortCommit,
  type Client,
} from '@openharness/client'
import type {
  PreviewSkillImportResponse,
  RefreshSkillPreviewResponse,
  Skill,
  SkillImportCandidate,
} from '@openharness/protocol'
import { Box, Text, render, useApp, useInput } from 'ink'
import type { ReactElement } from 'react'

import { candidateReasons, skillImportHeading, SkillImportPicker } from '../components/skill-import'
import {
  refreshConfirmHeading,
  refreshFileLines,
  SkillRefreshConfirm,
} from '../components/skill-refresh'
import { skillRowDetail, skillRowHead } from '../components/skills'
import { installSignals } from '../signals'
import { restoreTerminal } from '../terminal'
import { isYes, readLine, reportFailure, type CommandIo } from './io'
import type { SkillsAction } from '../args'

/**
 * `oh skills` (epic #349, K3/K5/K7/K8; #354) — the terminal's skills, and the same list `/skills`
 * opens in a chat.
 *
 * | command                                        | what it does                                                   |
 * | ---------------------------------------------- | -------------------------------------------------------------- |
 * | `oh skills`                                    | list your skills: name, on/off, badge, source and description   |
 * | `oh skills add <url> [--ref] [--path]`         | preview a repository, then pick what to import (`--all`, `--name`) |
 * | `oh skills refresh <name>`                     | show what changed and the `SKILL.md` diff, then confirm (`--yes`) |
 * | `oh skills enable <name>` / `disable <name>`   | turn one on or off (K8)                                         |
 * | `oh skills remove <name>`                      | delete one and its snapshot (asks; `--yes` skips)               |
 *
 * The import is two steps (K3) and both are here: `add` reads the repository — the commit it
 * landed on and every candidate, with its files, its whole `SKILL.md` and its problems — prints
 * that, and then either imports what the flags named or opens the pick. The pick is the CLI's
 * one interactive step, and it is the same component `/skills` uses (`components/skill-import`);
 * with no terminal and neither `--all` nor `--name`, there is nobody to pick, so it is a usage
 * error rather than an import of something nobody chose.
 *
 * A refresh is by hand and previewed the same way (K5): the diff is printed, and the snapshot is
 * replaced only on the reader's `y` (or `--yes`). A snapshot the preview found problems with
 * cannot be stored — the route refuses it — so that is a refusal here too, with exit `1`.
 *
 * Errors are the server's own sentences (`SKILL_IMPORT_MESSAGES`, the protocol's problem
 * messages) and the exit codes are the CLI's: `0` did it, `1` the server or the name said no,
 * `2` the command line or the terminal could not.
 */

/** The streams an Ink screen needs; the command's own sinks are separate (they print lines). */
export interface SkillsTerminal {
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
}

/** Run one `oh skills` action. */
export async function runSkills(
  client: Client,
  io: CommandIo,
  action: SkillsAction,
  terminal: SkillsTerminal,
): Promise<number> {
  try {
    switch (action.action) {
      case 'list': {
        const { data } = await client.skills.list()
        for (const line of formatSkills(data)) io.stdout(line)
        return 0
      }
      case 'add':
        return await runAdd(client, io, action, terminal)
      case 'refresh':
        return await runRefresh(client, io, action.name, action.yes, terminal)
      case 'enable':
      case 'disable':
        return await runEnabled(client, io, action.name, action.action === 'enable')
      case 'remove':
        return await runRemove(client, io, action.name, action.yes, terminal)
    }
  } catch (error) {
    return reportFailure(io, error)
  }
}

/**
 * The skills listing: one line per skill, then the source and description under it.
 *
 * The name, whether it is on, and the badge its frontmatter earns lead (K8, K1); where the
 * snapshot came from — the URL, the ref and path, and the short commit (K3) — and what the skill
 * says it does follow. The same words the `/skills` screen draws (`skillRowHead`/`skillRowDetail`),
 * so the listing and the screen cannot describe one skill two ways.
 */
export function formatSkills(skills: readonly Skill[]): readonly string[] {
  if (skills.length === 0) {
    return [
      'No skills yet. Import one with `oh skills add <url>`, or press i on `/skills` in a chat.',
    ]
  }
  const lines: string[] = []
  for (const skill of skills) {
    lines.push(skillRowHead(skill))
    lines.push(`  ${skillRowDetail(skill)}`)
  }
  return lines
}

/** `oh skills add`: preview, then the pick or the names the flags gave. */
async function runAdd(
  client: Client,
  io: CommandIo,
  action: Extract<SkillsAction, { action: 'add' }>,
  terminal: SkillsTerminal,
): Promise<number> {
  const preview = await client.skills.previewImport({
    url: action.url,
    ...(action.ref === undefined ? {} : { ref: action.ref }),
    ...(action.path === undefined ? {} : { path: action.path }),
  })
  for (const line of formatSkillCandidates(preview)) io.stdout(line)

  if (action.all && action.names.length > 0) {
    io.stderr('oh: use either --all or --name <n>, not both.')
    return 2
  }

  const chosen =
    action.all || action.names.length > 0
      ? namedCandidates(
          preview,
          action.all ? importableCandidateNames(preview.candidates) : action.names,
        )
      : null

  if (chosen !== null && !chosen.ok) {
    io.stderr(`oh: ${chosen.error}`)
    return 1
  }
  if (chosen !== null && chosen.names.length === 0) {
    io.stderr('oh: nothing in that repository can be imported as it stands.')
    return 1
  }

  if (chosen !== null) {
    return await importNames(client, io, preview, chosen.names)
  }

  if (terminal.stdin.isTTY !== true) {
    io.stderr(
      'oh: choosing what to import needs a terminal, and stdin is not one.\n' +
        '  name them instead: --all, or --name <n> for each one.',
    )
    return 2
  }

  const picked = await mountSkillPicker(preview, terminal)
  if (picked === null) {
    io.stdout('Not imported.')
    return 0
  }
  return await importNames(client, io, preview, picked)
}

/** Store the picked names at the previewed commit, and say what was stored. */
async function importNames(
  client: Client,
  io: CommandIo,
  preview: PreviewSkillImportResponse,
  names: readonly string[],
): Promise<number> {
  const stored = await client.skills.import({
    url: preview.url,
    ...(preview.ref === null ? {} : { ref: preview.ref }),
    ...(preview.path === null ? {} : { path: preview.path }),
    commit_sha: preview.commit_sha,
    names: [...names],
  })
  const names_ = stored.data.map((skill) => skill.name)
  io.stdout(
    `Imported ${names_.length === 1 ? names_[0] : `${names_.length} skills`}${
      names_.length === 1 ? '' : `: ${names_.join(', ')}`
    }.`,
  )
  return 0
}

/**
 * The names an import would be asked for, checked against the preview before the request.
 *
 * A name the preview did not offer, or one whose candidate cannot be imported as it stands
 * (its problems, or a name already taken), is the reader's mistake and is named here rather
 * than sent: the route would refuse the whole batch, and a message about *this* name is more
 * use than a batch error.
 */
function namedCandidates(
  preview: PreviewSkillImportResponse,
  names: readonly string[],
):
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  const wanted = [...new Set(names)]
  const offered = new Map(preview.candidates.map((candidate) => [candidate.name, candidate]))
  const picked: string[] = []
  for (const name of wanted) {
    const candidate = offered.get(name)
    if (candidate === undefined) {
      const known = preview.candidates.map((entry) => entry.name)
      return {
        ok: false,
        error:
          known.length === 0
            ? `no skill named ${name} was offered; nothing under that path holds a SKILL.md.`
            : `no skill named ${name} was offered; the preview found ${known.join(', ')}.`,
      }
    }
    if (!candidateSelectable(candidate)) {
      return { ok: false, error: `${name} cannot be imported: ${candidateReasonText(candidate)}.` }
    }
    picked.push(name)
  }
  return { ok: true, names: picked }
}

/** A candidate's reasons as one sentence, for the refusal a `--name` naming a broken one gets. */
function candidateReasonText(candidate: SkillImportCandidate): string {
  return candidateReasons(candidate).join('; ')
}

/**
 * The printed preview: where the clone landed, then a line per candidate and its problems.
 *
 * `+` is a candidate an import can store and `!` one it cannot, with the reasons indented under
 * it — the same story the pick draws, so a reader who is about to pick (or to write `--name`)
 * has read the whole of it.
 */
export function formatSkillCandidates(preview: PreviewSkillImportResponse): readonly string[] {
  const lines = [skillImportHeading(preview)]
  if (preview.candidates.length === 0) {
    lines.push('  Nothing under that path holds a SKILL.md.')
    return lines
  }
  for (const candidate of preview.candidates) {
    const importable = candidateSelectable(candidate)
    const description = candidate.description === null ? '' : ` — ${candidate.description}`
    lines.push(
      `  ${importable ? '+' : '!'} ${candidate.name}${description}${
        importable ? '' : '  (cannot be imported)'
      }`,
    )
    for (const reason of candidateReasons(candidate)) lines.push(`      ${reason}`)
  }
  return lines
}

/** `oh skills refresh <name>`: the diff, then the confirm. */
async function runRefresh(
  client: Client,
  io: CommandIo,
  name: string,
  yes: boolean,
  terminal: SkillsTerminal,
): Promise<number> {
  const skill = await findSkill(client, io, name)
  if (skill === undefined) return 1

  const preview = await client.skills.previewRefresh(skill.id)
  for (const line of formatSkillRefresh(skill.name, preview)) io.stdout(line)

  if (preview.problems.length > 0) {
    // The one thing the route refuses (K5): replacing a working skill with a broken one is not
    // a refresh. The problems are the reason, and the snapshot the reader has is untouched.
    io.stderr(`oh: the new snapshot cannot be stored, so nothing was replaced.`)
    return 1
  }
  if (!preview.changed) {
    io.stdout(`Already up to date at ${shortCommit(preview.commit_sha)}.`)
    return 0
  }

  // The confirm is a screen when there is a terminal to draw it on (the diff above is already in
  // the scrollback), and a plain line when there is not — with `--yes` skipping both.
  const confirmed = yes
    ? true
    : terminal.stdin.isTTY === true
      ? await mountSkillRefreshConfirm(skill.name, preview, terminal)
      : await confirm(terminal, `Replace the snapshot of ${skill.name}? [y/N] `)
  if (!confirmed) {
    io.stdout('Not refreshed.')
    return 0
  }

  const refreshed = await client.skills.refresh(skill.id, { commit_sha: preview.commit_sha })
  io.stdout(`Refreshed ${refreshed.name} to ${shortCommit(preview.commit_sha)}.`)
  return 0
}

/** `oh skills enable|disable <name>`: one write, and the word for what it did (K8). */
async function runEnabled(
  client: Client,
  io: CommandIo,
  name: string,
  enabled: boolean,
): Promise<number> {
  const skill = await findSkill(client, io, name)
  if (skill === undefined) return 1
  const updated = await client.skills.update(skill.id, { enabled })
  io.stdout(`${updated.name} is ${updated.enabled ? 'on' : 'off'}.`)
  return 0
}

/** `oh skills remove <name>`: ask, then delete the skill and its snapshot. */
async function runRemove(
  client: Client,
  io: CommandIo,
  name: string,
  yes: boolean,
  terminal: SkillsTerminal,
): Promise<number> {
  const skill = await findSkill(client, io, name)
  if (skill === undefined) return 1
  const confirmed =
    yes || (await confirm(terminal, `Remove ${skill.name}? This cannot be undone [y/N] `))
  if (!confirmed) {
    io.stdout('Not removed.')
    return 0
  }
  await client.skills.delete(skill.id)
  io.stdout(`Removed ${skill.name}.`)
  return 0
}

/**
 * The skill a name refers to, or `undefined` (with the listing line already on stderr).
 *
 * The name is matched exactly first — a skill name is lowercase by rule, so that is the common
 * case — and then ignoring case, which is what a reader who capitalised the first letter meant.
 */
async function findSkill(client: Client, io: CommandIo, name: string): Promise<Skill | undefined> {
  const { data } = await client.skills.list()
  const exact = data.find((skill) => skill.name === name)
  const found =
    exact ?? data.find((skill) => skill.name.toLowerCase() === name.trim().toLowerCase())
  if (found === undefined) {
    io.stderr(
      data.length === 0
        ? `oh: no skill named ${name}; you have no skills. Import one with \`oh skills add <url>\`.`
        : `oh: no skill named ${name}. You have: ${data.map((skill) => skill.name).join(', ')}.`,
    )
  }
  return found
}

/** Ask a `[y/N]` question, on the terminal or on a pipe — the same rule the other commands use. */
async function confirm(terminal: SkillsTerminal, question: string): Promise<boolean> {
  if (terminal.stdin.isTTY !== true) {
    terminal.stdout.write(question)
    return isYes(await readLine(terminal.stdin))
  }
  const answer = await mountSkillConfirm(question, terminal)
  return answer === true
}

/** The refresh as the lines `oh skills refresh` prints: what changed, then the `SKILL.md` diff. */
export function formatSkillRefresh(
  name: string,
  preview: RefreshSkillPreviewResponse,
): readonly string[] {
  const lines = [refreshConfirmHeading(name, preview)]
  for (const line of refreshFileLines(preview)) lines.push(`  ${line}`)
  for (const problem of preview.problems) {
    lines.push(`  ${problem.code}: ${problem.message}`)
  }
  if (!preview.changed) {
    lines.push('  nothing changed.')
    return lines
  }
  if (preview.skill_md_diff !== null) {
    lines.push('  --- SKILL.md ---')
    for (const line of preview.skill_md_diff.split('\n')) lines.push(`  ${line}`)
  }
  return lines
}

/** Mount the import pick and settle with the names chosen, or `null` when the reader cancelled. */
export async function mountSkillPicker(
  preview: PreviewSkillImportResponse,
  terminal: SkillsTerminal,
): Promise<readonly string[] | null> {
  return await mountInk<readonly string[] | null>(terminal, <SkillPickerApp preview={preview} />)
}

/** Mount the refresh confirm and settle with whether the reader said yes. */
export async function mountSkillRefreshConfirm(
  name: string,
  preview: RefreshSkillPreviewResponse,
  terminal: SkillsTerminal,
): Promise<boolean> {
  return (
    (await mountInk<boolean>(
      terminal,
      <SkillRefreshConfirmApp name={name} preview={preview} />,
    )) === true
  )
}

/** Mount the `[y/N]` question of a remove/refresh with no diff to read. */
async function mountSkillConfirm(question: string, terminal: SkillsTerminal): Promise<boolean> {
  return (await mountInk<boolean>(terminal, <YesNoApp question={question} />)) === true
}

/**
 * Run an Ink app that settles a value through `useApp().exit(value)`, and give the terminal back.
 *
 * The same plumbing `oh mcp` uses — `exitOnCtrlC: false`, because Ctrl+C belongs to the screen —
 * with the difference that what settles is a value rather than an exit code, since the pick and
 * the confirm are decisions the command carries out itself.
 */
async function mountInk<T>(terminal: SkillsTerminal, element: ReactElement): Promise<T | null> {
  const { stdin, stdout, stderr } = terminal
  const restore = (): void => {
    restoreTerminal({ stdin, stdout })
  }

  let instance: ReturnType<typeof render> | undefined
  const settle = (code: number): void => {
    restore()
    if (instance === undefined) process.exit(code)
    instance.unmount()
  }

  const stopSignals = installSignals(process, {
    onInterrupt: () => {
      settle(130)
    },
    onTerminate: () => {
      settle(143)
    },
  })
  const onProcessExit = (): void => {
    restore()
  }
  process.once('exit', onProcessExit)

  try {
    instance = render(element, { stdin, stdout, stderr, exitOnCtrlC: false })
    return (await instance.waitUntilExit()) as T | null
  } finally {
    stopSignals()
    process.off('exit', onProcessExit)
    restore()
  }
}

/** The picker, as an Ink app: the component above, settling through `exit`. */
function SkillPickerApp({ preview }: { readonly preview: PreviewSkillImportResponse }) {
  const { exit } = useApp()
  return (
    <Box flexDirection="column">
      <Text dimColor>Pick the skills to import; Enter imports what is chosen.</Text>
      <SkillImportPicker
        preview={preview}
        onConfirm={(names) => {
          exit(names)
        }}
        onCancel={() => {
          exit(null)
        }}
      />
    </Box>
  )
}

/** The refresh confirm, as an Ink app. */
function SkillRefreshConfirmApp({
  name,
  preview,
}: {
  readonly name: string
  readonly preview: RefreshSkillPreviewResponse
}) {
  const { exit } = useApp()
  return (
    <SkillRefreshConfirm
      name={name}
      preview={preview}
      onConfirm={() => {
        exit(true)
      }}
      onCancel={() => {
        exit(false)
      }}
    />
  )
}

/** A one-line `[y/N]`, as an Ink app — the terminal path of a question a pipe reads by line. */
function YesNoApp({ question }: { readonly question: string }) {
  const { exit } = useApp()
  return (
    <YesNo
      question={question}
      onAnswer={(yes) => {
        exit(yes)
      }}
    />
  )
}

function YesNo({
  question,
  onAnswer,
}: {
  readonly question: string
  readonly onAnswer: (yes: boolean) => void
}) {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onAnswer(false)
      return
    }
    if (input === 'y' || input === 'Y') {
      onAnswer(true)
      return
    }
    if (input === 'n' || input === 'N' || key.return || key.escape) {
      onAnswer(false)
    }
  })
  // The question is spelled with its `[y/N]` by the caller — the same string the piped path
  // writes — so the screen draws it as it is rather than appending a second one.
  return <Text>{question}</Text>
}

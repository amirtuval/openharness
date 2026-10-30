import { refreshChangeSummary, refreshFileChanges } from '@openharness/client'
import type { RefreshSkillPreviewResponse } from '@openharness/protocol'
import { Box, Text, useInput } from 'ink'

/**
 * The refresh confirm (epic #349, K5; #354): "replace this snapshot with what the re-clone read?"
 *
 * A refresh is by hand and always previewed first, and the confirm is the second step — the
 * reader names the commit the preview resolved, and the server replaces the snapshot only if the
 * clone still lands on it. The diff itself is printed by the command that mounts this, into the
 * terminal's own scrollback, where a long unified diff belongs: what is left here is the
 * decision — the skill, what the preview came to, and `y`/`n`.
 *
 * A snapshot with `problems` cannot be stored (the route refuses it), so the screen says so and
 * offers no confirm rather than letting a key send a request that would be refused.
 */

/** The line the confirm opens with: the skill, and what the preview came to. */
export function refreshConfirmHeading(name: string, preview: RefreshSkillPreviewResponse): string {
  return `Refresh ${name}: ${refreshChangeSummary(preview)} @ ${preview.commit_sha.slice(0, 7)}`
}

/**
 * The files a refresh would move, one line each — `+ added`, `- removed`, `~ changed`.
 *
 * `SKILL.md` is not called out separately: it is one of the three lists, and its diff is what
 * the command prints above this. The list is empty for an unchanged snapshot, which is the
 * "already up to date" answer.
 */
export function refreshFileLines(preview: RefreshSkillPreviewResponse): readonly string[] {
  const marks = { added: '+', removed: '-', changed: '~' } as const
  return refreshFileChanges(preview).map((change) => `${marks[change.kind]} ${change.path}`)
}

export function SkillRefreshConfirm({
  name,
  preview,
  onConfirm,
  onCancel,
}: {
  readonly name: string
  readonly preview: RefreshSkillPreviewResponse
  /** Replace the snapshot at the previewed commit — `y`. */
  readonly onConfirm: () => void
  /** Leave it as it is — `n`, Esc, or Ctrl+C. */
  readonly onCancel: () => void
}) {
  const problems = preview.problems

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }
    if (key.escape) {
      onCancel()
      return
    }
    // A snapshot with problems is the one thing the route refuses (K3/K5), so there is nothing
    // to confirm: `y` does what any other key does here, and the line above says why.
    if ((input === 'y' || input === 'Y') && problems.length === 0) {
      onConfirm()
      return
    }
    if (input === 'n' || input === 'N' || key.return) {
      onCancel()
    }
  })

  return (
    <Box flexDirection="column">
      <Text>{refreshConfirmHeading(name, preview)}</Text>
      {refreshFileLines(preview).map((line) => (
        <Text key={line} dimColor>
          {`  ${line}`}
        </Text>
      ))}
      {problems.length > 0 && (
        <>
          <Text color="red">That snapshot cannot be stored:</Text>
          {problems.map((problem) => (
            <Text key={problem.code} color="red">
              {`  ${problem.code}: ${problem.message}`}
            </Text>
          ))}
        </>
      )}
      {problems.length === 0 ? (
        <Text>Replace the stored snapshot with this one? [y/N]</Text>
      ) : (
        <Text dimColor>Keeping the snapshot you have. Esc to leave.</Text>
      )}
    </Box>
  )
}

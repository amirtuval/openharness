import { candidateSelectable, importableCandidateNames, shortCommit } from '@openharness/client'
import type { PreviewSkillImportResponse, SkillImportCandidate } from '@openharness/protocol'
import { Box, Text, useInput } from 'ink'
import { useRef, useState } from 'react'

import {
  listJump,
  ScrollingList,
  useTerminalRows,
  VIEWPORT_HINT,
  viewportRows,
} from './list-viewport'

/**
 * The import pick (epic #349, K3; #354): the preview's candidates as a keyboard-driven checklist.
 *
 * The import is two steps, and this is the second one's decision — the reader picks which
 * candidates to store at the commit the preview resolved. A terminal has no pointer, so it is
 * the same flat list `/mcp` and `/tools` use: ↑/↓ move, **space** toggles the highlighted
 * candidate, **`a`** takes or drops them all, **Enter** imports what is chosen and **Esc**
 * cancels. A candidate that cannot be imported as it stands — its own `problems`, or a name the
 * reader already has — carries a `✗` and does not respond to space, because the import would
 * refuse it rather than fix it: the reason is on the line.
 *
 * The words are the protocol's own (`SkillProblem.message`, `name_taken`), so the terminal and
 * the page tell a reader the same story about a folder.
 */

/** The glyphs a candidate's row leads with: taken, choosable, or not choosable at all. */
export const CHOSEN_MARK = '◉'
export const UNCHOSEN_MARK = '○'
export const BLOCKED_MARK = '✗'

/** Whether space does anything to a candidate: only an importable one can be chosen (K3). */
export function candidateChosen(
  candidate: SkillImportCandidate,
  selected: readonly string[],
): boolean {
  return candidateSelectable(candidate) && selected.includes(candidate.name)
}

/** What a candidate's row leads with. A glyph, so it reads with colour off. */
export function candidateMark(
  candidate: SkillImportCandidate,
  selected: readonly string[],
): string {
  if (!candidateSelectable(candidate)) return BLOCKED_MARK
  return candidateChosen(candidate, selected) ? CHOSEN_MARK : UNCHOSEN_MARK
}

/**
 * The candidates' names that an import would store from this preview.
 *
 * Read off the chosen set through {@link candidateSelectable}, so a name that is not a candidate
 * or that cannot be imported never reaches the request — the two ways the server would refuse
 * the whole batch (K3).
 */
export function chosenNames(
  preview: PreviewSkillImportResponse,
  selected: readonly string[],
): string[] {
  return preview.candidates
    .filter((candidate) => candidateChosen(candidate, selected))
    .map((candidate) => candidate.name)
}

/**
 * The one line naming where the preview read from, and at which commit.
 *
 * The commit is what a following import names, so it is on screen: the reader is confirming a
 * snapshot of *this* commit, and a branch that moves in the meantime is refused rather than
 * silently imported.
 */
export function skillImportHeading(preview: PreviewSkillImportResponse): string {
  const where = [preview.url, preview.ref, preview.path].filter(
    (part): part is string => part !== null,
  )
  return `Import from ${where.join(' · ')} @ ${shortCommit(preview.commit_sha)}`
}

/**
 * Why a candidate cannot be imported as it stands, one line per reason, or an empty list.
 *
 * A candidate's own `problems` first (bad frontmatter, a name that is not the folder's, a
 * reserved name, a limit of K4), then `name_taken` — which is not a problem with the skill but
 * the one other answer a reader wants: they already have one of these.
 */
export function candidateReasons(candidate: SkillImportCandidate): readonly string[] {
  const reasons = candidate.problems.map((problem) => `${problem.code}: ${problem.message}`)
  if (candidate.name_taken) {
    reasons.push('you already have a skill with this name')
  }
  return reasons
}

/** One candidate's two lines, as plain strings — the shape a frame test can hold still. */
export function candidateLines(
  candidate: SkillImportCandidate,
  selected: readonly string[],
): readonly [string, string] {
  const description = candidate.description === null ? '' : ` — ${candidate.description}`
  const state = candidateSelectable(candidate) ? '' : '  (cannot be imported)'
  const files = `${candidate.files.length} ${candidate.files.length === 1 ? 'file' : 'files'}`
  const reasons = candidateReasons(candidate)
  const detail = reasons.length === 0 ? files : `${files} · ${reasons.join(' · ')}`
  return [`${candidateMark(candidate, selected)} ${candidate.name}${description}${state}`, detail]
}

export interface SkillImportPickerProps {
  /** What the preview found: the commit, and every candidate under the path. */
  readonly preview: PreviewSkillImportResponse
  /** Import these names, at the preview's commit — Enter, or `a` then Enter. */
  readonly onConfirm: (names: readonly string[]) => void
  /** Change nothing — Esc, or Ctrl+C. */
  readonly onCancel: () => void
  /**
   * What starts chosen; every importable candidate by default, which is what "import them all"
   * means and what the CLI's `--all` sends.
   */
  readonly initialSelection?: readonly string[] | undefined
}

export function SkillImportPicker({
  preview,
  onConfirm,
  onCancel,
  initialSelection,
}: SkillImportPickerProps) {
  const terminalRows = useTerminalRows()
  const candidates = preview.candidates
  const [index, setIndex] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>(
    () => initialSelection ?? importableCandidateNames(candidates),
  )
  // The chosen set the key handler reads: Ink hands `useInput` the latest *committed* render,
  // and a burst of keystrokes must not toggle a candidate against what the render it closed
  // over still held.
  const selectedRef = useRef(selected)

  const chrome = 3
  const capacity = viewportRows(terminalRows, chrome)

  const moveTo = (next: number): void => {
    setIndex(Math.min(Math.max(next, 0), Math.max(candidates.length - 1, 0)))
  }

  const toggle = (candidate: SkillImportCandidate | undefined): void => {
    if (candidate === undefined || !candidateSelectable(candidate)) return
    const chosen = selectedRef.current.includes(candidate.name)
    const next = chosen
      ? selectedRef.current.filter((name) => name !== candidate.name)
      : [...selectedRef.current, candidate.name]
    selectedRef.current = next
    setSelected(next)
  }

  const toggleAll = (): void => {
    const all = importableCandidateNames(candidates)
    const everyOne = all.length > 0 && all.every((name) => selectedRef.current.includes(name))
    const next = everyOne ? [] : all
    selectedRef.current = next
    setSelected(next)
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }
    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow) {
      moveTo(index - 1)
      return
    }
    if (key.downArrow) {
      moveTo(index + 1)
      return
    }
    const jumped = listJump(index, candidates.length, key, capacity)
    if (jumped !== null) {
      moveTo(jumped)
      return
    }
    if (input === ' ') {
      toggle(candidates[index])
      return
    }
    if (input === 'a') {
      toggleAll()
      return
    }
    if (key.return) {
      const names = chosenNames(preview, selectedRef.current)
      if (names.length > 0) onConfirm(names)
    }
  })

  const chosen = chosenNames(preview, selected)

  return (
    <Box flexDirection="column">
      <Text>{skillImportHeading(preview)}</Text>
      {candidates.length === 0 ? (
        <Text dimColor>Nothing under that path holds a SKILL.md.</Text>
      ) : (
        <ScrollingList
          items={candidates}
          index={index}
          rows={terminalRows}
          chrome={chrome}
          rowLines={2}
          renderRow={(candidate, position, marker) => {
            const [head, detail] = candidateLines(candidate, selected)
            return (
              <>
                <Text color={position === index ? 'cyan' : undefined}>{`${marker} ${head}`}</Text>
                <Text dimColor>{`  ${detail}`}</Text>
              </>
            )
          }}
        />
      )}
      <Text dimColor>
        {`space choose · a all · ${VIEWPORT_HINT} · Enter import ${chosen.length === 0 ? '— nothing chosen' : `(${chosen.length})`} · Esc cancel`}
      </Text>
    </Box>
  )
}

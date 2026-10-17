/**
 * What changed between two snapshots of a skill (epic #349, K5).
 *
 * A refresh is **by hand**: the user asks for one, the server clones the skill's stored source
 * again, and the answer is a diff against the snapshot they already have — files added,
 * removed and changed, and the `SKILL.md` diff, which is the one file a skill is really read
 * by. Confirming it replaces the snapshot; nothing here writes anything.
 *
 * The file story is **paths**, not listings: what a reader wants from a diff is which files
 * moved, and the sizes are on the snapshot the skill already carries. The `SKILL.md` story is
 * a **unified diff** — the format `git diff` prints, and the one every reader of a diff
 * already knows how to read — produced here rather than by a dependency, because the shape
 * wanted is a small one (three lines of context, one hunk per change group) and a diff library
 * would be a new dependency in the server for it.
 */

import type { SkillFileEncoding } from '@openharness/protocol'

/** One file of a snapshot: its path inside the skill folder, and its content. */
export interface DiffableFile {
  /** The file's path, relative to the skill folder and forward-slashed. */
  readonly path: string
  /** The file's content, exactly as the snapshot holds it. */
  readonly content: string
  /**
   * How `content` is spelled (`utf8`, or `base64` for a binary file).
   *
   * Compared beside the content: two spellings of the same bytes are the same file, but the
   * import only ever writes one spelling per byte sequence, so including it in the comparison
   * is a cheap guard against a file whose encoding changed being read as unchanged.
   */
  readonly encoding?: SkillFileEncoding
}

/** How two snapshots' file sets differ (K5). */
export interface SnapshotDiff {
  /** Paths the new snapshot has and the old one does not, in path order. */
  readonly added: readonly string[]
  /** Paths the old snapshot has and the new one does not, in path order. */
  readonly removed: readonly string[]
  /** Paths both hold with different content, in path order. */
  readonly changed: readonly string[]
}

/** The file every skill's folder carries (K1) — the one a refresh shows a diff of. */
const SKILL_MD = 'SKILL.md'

/** How many unchanged lines are shown around a change. */
const CONTEXT_LINES = 3

/**
 * Which files were added, removed and changed between two snapshots.
 *
 * The comparison is by **content**, so a file a touch or a whitespace-only edit moved is
 * reported as changed — which is the honest answer for a snapshot: what is stored is the text,
 * so what differs is the text.
 */
export function diffSnapshots(
  before: readonly DiffableFile[],
  after: readonly DiffableFile[],
): SnapshotDiff {
  const oldFiles = new Map(before.map((file) => [file.path, fileSpelling(file)]))
  const newFiles = new Map(after.map((file) => [file.path, fileSpelling(file)]))

  const added = [...newFiles.keys()].filter((path) => !oldFiles.has(path)).sort()
  const removed = [...oldFiles.keys()].filter((path) => !newFiles.has(path)).sort()
  const changed = [...newFiles.keys()]
    .filter((path) => oldFiles.has(path) && oldFiles.get(path) !== newFiles.get(path))
    .sort()

  return { added, removed, changed }
}

/**
 * One file as a value the diff can compare: its content, and the spelling it is held in.
 *
 * A binary file is base64 on both sides, so its bytes compare as its bytes — the one spelling
 * the import writes for a given sequence. The encoding is part of the key so a file whose
 * content happened to equal another spelling's is not read as unchanged. `utf8` is the default,
 * which is what every caller that predates the field holds.
 */
function fileSpelling(file: DiffableFile): string {
  return `${file.encoding ?? 'utf8'}\u0000${file.content}`
}

/**
 * The unified diff of a skill's `SKILL.md`, or `null` when the file is unchanged (K5).
 *
 * The answer is `git diff`'s shape — a `---`/`+++` header naming the file on both sides, then
 * one `@@ -<old> +<new> @@` hunk per group of changes, each carrying its context lines — with
 * the paths spelled `a/SKILL.md` and `b/SKILL.md` so the header means the same thing it means
 * anywhere else.
 *
 * A file that is only added or only removed gets a whole-file hunk over an empty side, which is
 * what a reader expects to see; `lines` is deliberately computed on the **split** text, so a
 * file with no trailing newline does not invent a line.
 */
export function skillMdDiff(before: string | null, after: string | null): string | null {
  const oldText = before ?? ''
  const newText = after ?? ''
  if (oldText === newText) {
    return null
  }
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const edits = lineEdits(oldLines, newLines)

  const hunks = groupEdits(edits)
  const header = `--- a/${SKILL_MD}\n+++ b/${SKILL_MD}\n`
  return (
    header +
    hunks
      .map((hunk) => {
        const oldCount = hunk.lines.filter((line) => line.kind !== 'added').length
        const newCount = hunk.lines.filter((line) => line.kind !== 'removed').length
        // A side with no lines in this hunk starts at line 0, which is how git prints a
        // whole-file addition (`@@ -0,0 +1,2 @@`) or removal.
        const oldStart = oldCount === 0 ? 0 : hunk.oldStart
        const newStart = newCount === 0 ? 0 : hunk.newStart
        const body = hunk.lines
          .map((line) =>
            line.kind === 'context'
              ? ` ${line.text}`
              : line.kind === 'added'
                ? `+${line.text}`
                : `-${line.text}`,
          )
          .join('\n')
        return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}\n`
      })
      .join('')
  )
}

/** One line of a diff, and which side of the change it is on. */
interface DiffLine {
  readonly kind: 'context' | 'added' | 'removed'
  readonly text: string
}

/** One hunk: where it starts on each side, and the lines it carries. */
interface Hunk {
  readonly oldStart: number
  readonly newStart: number
  readonly lines: readonly DiffLine[]
}

/** A file's lines, without inventing one for an empty file. */
function splitLines(text: string): string[] {
  if (text === '') {
    return []
  }
  const lines = text.split('\n')
  // A trailing newline is the end of the last line, not the start of an empty one.
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

/**
 * Every line of both files, in order, marked as context, added or removed.
 *
 * A longest-common-subsequence table over the two files, walked back from the end — the
 * textbook diff, and the right size for a `SKILL.md`: the file is capped at 20 KB (K4), so the
 * table is at most a few thousand cells per side even for a pathological one.
 */
function lineEdits(before: readonly string[], after: readonly string[]): DiffLine[] {
  const rows = before.length + 1
  const columns = after.length + 1
  // `lengths[i][j]` is the length of the LCS of `before[i..]` and `after[j..]`.
  const lengths: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0))
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        before[i] === after[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }

  const edits: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      edits.push({ kind: 'context', text: before[i]! })
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      edits.push({ kind: 'removed', text: before[i]! })
      i++
    } else {
      edits.push({ kind: 'added', text: after[j]! })
      j++
    }
  }
  while (i < before.length) {
    edits.push({ kind: 'removed', text: before[i]! })
    i++
  }
  while (j < after.length) {
    edits.push({ kind: 'added', text: after[j]! })
    j++
  }
  return edits
}

/**
 * Cut the edits into hunks: one per group of changes, with {@link CONTEXT_LINES} lines of
 * context on each side, and two groups that would overlap sharing a hunk rather than printing
 * the same context twice.
 */
function groupEdits(edits: readonly DiffLine[]): Hunk[] {
  const changedAt = edits
    .map((line, index) => (line.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0)
  if (changedAt.length === 0) {
    return []
  }

  const spans: { from: number; to: number }[] = []
  for (const index of changedAt) {
    const from = Math.max(0, index - CONTEXT_LINES)
    const to = Math.min(edits.length - 1, index + CONTEXT_LINES)
    const last = spans[spans.length - 1]
    if (last !== undefined && from <= last.to + 1) {
      last.to = Math.max(last.to, to)
      continue
    }
    spans.push({ from, to })
  }

  return spans.map((span) => ({
    ...startLines(edits, span.from),
    lines: edits.slice(span.from, span.to + 1),
  }))
}

/**
 * Where a hunk starts on each side: one past the lines the diff holds before it.
 *
 * The two sides part here and nowhere else — the old side counts every line that is not an
 * addition, the new side every line that is not a removal — which is exactly what git prints
 * in a hunk header.
 */
function startLines(
  edits: readonly DiffLine[],
  index: number,
): { oldStart: number; newStart: number } {
  let oldCount = 0
  let newCount = 0
  for (let at = 0; at < index; at++) {
    if (edits[at]!.kind !== 'added') {
      oldCount++
    }
    if (edits[at]!.kind !== 'removed') {
      newCount++
    }
  }
  return { oldStart: oldCount + 1, newStart: newCount + 1 }
}

import { candidateSelectable, skillFileList, skillFileSizeLabel } from '@openharness/client'
import type { SkillImportCandidate, PreviewSkillImportResponse } from '@openharness/protocol'
import { ChevronRight } from 'lucide-react'
import { useCallback, useState } from 'react'

import type { SkillFailureKind, SkillsView } from '../../hooks/use-skills'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

/**
 * Import, in the two steps the epic asks for (epic #349, K3; issue #353).
 *
 * One repository at a time, and nothing is stored until the reader says so:
 *
 * 1. **the URL** — with the optional `ref` and `path` behind **Advanced**, because a browse URL
 *    (`…/tree/<ref>/<path>`) fills both in, and most readers paste one;
 * 2. **the preview** — every candidate folder the clone found, each with its description, its
 *    `SKILL.md` and its file list behind a disclosure, and its problems drawn where it is. A
 *    candidate that cannot be imported — bad frontmatter, a name that is not the folder's, a
 *    reserved name, a limit of K4 — has its checkbox **off and disabled**, and so does one whose
 *    name the reader already has: the import would be refused, and a checkbox that can be ticked
 *    into a refusal is a lie. The others start ticked, because they are what the reader asked
 *    for; the Import button is the confirm, and it names the **commit the preview resolved**
 *    (K3), so a branch that moves between the two steps is refused rather than imported.
 *
 * A failed preview or import lands under the URL, as the server's own sentence: `unreachable`,
 * `not_a_repository`, `no_skills_found` and the rest are one message each, and they are all
 * about the thing the reader just typed.
 */
export function SkillImportPanel({
  skills,
  onImported,
  onCancel,
}: {
  /** The shell's skills hook: the two steps are its calls, and its `busy` is what disables the form. */
  skills: SkillsView
  /** A batch was stored: the card closes the panel and says so. */
  onImported: (count: number) => void
  /** Leave the panel without importing anything. */
  onCancel: () => void
}) {
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [path, setPath] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [preview, setPreview] = useState<PreviewSkillImportResponse | null>(null)
  const [picked, setPicked] = useState<readonly string[]>([])
  const [failure, setFailure] = useState<string | null>(null)

  const runPreview = useCallback(async (): Promise<void> => {
    setFailure(null)
    setPreview(null)
    const result = await skills.previewImport({
      url: url.trim(),
      ...(ref.trim() === '' ? {} : { ref: ref.trim() }),
      ...(path.trim() === '' ? {} : { path: path.trim() }),
    })
    if (!result.ok) {
      setFailure(failureLine(result.kind, result.message))
      return
    }
    setPreview(result.value)
    // Everything the preview can really store starts ticked; a problem or a taken name is not
    // selectable at all, so it can never be part of the batch.
    setPicked(result.value.candidates.filter(candidateSelectable).map((each) => each.name))
  }, [path, ref, skills, url])

  const runImport = useCallback(async (): Promise<void> => {
    if (preview === null) {
      return
    }
    setFailure(null)
    const result = await skills.importSkills({
      url: preview.url,
      ...(preview.ref === null ? {} : { ref: preview.ref }),
      ...(preview.path === null ? {} : { path: preview.path }),
      commit_sha: preview.commit_sha,
      names: [...picked],
    })
    if (!result.ok) {
      setFailure(failureLine(result.kind, result.message))
      return
    }
    onImported(result.value.data.length)
  }, [onImported, picked, preview, skills])

  const toggle = (candidate: SkillImportCandidate, next: boolean): void => {
    setPicked((current) =>
      next ? [...current, candidate.name] : current.filter((name) => name !== candidate.name),
    )
  }

  return (
    <div data-slot="skill-import" className="space-y-3 rounded-lg border px-3 py-3">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          void runPreview()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-import-url">Repository URL</Label>
          <Input
            id="skill-import-url"
            value={url}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/anthropics/skills"
            onChange={(event) => {
              setUrl(event.target.value)
              // The preview belongs to the URL it was taken from: changing the source makes it
              // stale, and importing it would be importing something else.
              setPreview(null)
              setFailure(null)
            }}
          />
          <p className="text-xs text-muted-foreground">
            A public git repository, or a link to a folder inside one. Nothing is stored until you
            pick the skills and press Import.
          </p>
        </div>

        <Collapsible open={advanced} onOpenChange={setAdvanced}>
          <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 transition-transform [[data-state=open]_&]:rotate-90"
            />
            Advanced: a branch, tag or folder
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="skill-import-ref">Ref</Label>
                <Input
                  id="skill-import-ref"
                  value={ref}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="the default branch"
                  onChange={(event) => setRef(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="skill-import-path">Folder</Label>
                <Input
                  id="skill-import-path"
                  value={path}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="the repository root"
                  onChange={(event) => setPath(event.target.value)}
                />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={url.trim() === '' || skills.busy}
          >
            {skills.busy && preview === null ? 'Reading…' : 'Preview'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={skills.busy}>
            Cancel
          </Button>
        </div>
      </form>

      {failure === null ? null : (
        <p role="status" data-slot="skill-import-failure" className="text-xs text-destructive">
          {failure}
        </p>
      )}

      {preview === null ? null : (
        <div data-slot="skill-import-preview" className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {preview.candidates.length === 1
              ? 'One skill found at'
              : `${preview.candidates.length} skills found at`}{' '}
            <code className="font-mono">{`${preview.url}${
              preview.path === null ? '' : ` · ${preview.path}`
            }${preview.ref === null ? '' : ` · ${preview.ref}`}`}</code>{' '}
            (<code className="font-mono">{preview.commit_sha.slice(0, 7)}</code>). Pick the ones to
            import.
          </p>

          <ul className="space-y-2">
            {preview.candidates.map((candidate) => (
              <SkillCandidateRow
                key={candidate.name}
                candidate={candidate}
                checked={picked.includes(candidate.name)}
                disabled={skills.busy}
                onChange={(next) => toggle(candidate, next)}
              />
            ))}
          </ul>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={picked.length === 0 || skills.busy}
              onClick={() => void runImport()}
            >
              {skills.busy
                ? 'Importing…'
                : picked.length === 1
                  ? 'Import 1 skill'
                  : `Import ${picked.length} skills`}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * One candidate: its name and description, its problems, and what it holds.
 *
 * The checkbox is the pick; it is **off and disabled** when the import would be refused
 * ({@link candidateSelectable}), and the reason is on the row — the candidate's own problems as
 * the server stated them, and `you already have one of these` for a name that is taken, which is
 * nothing wrong with the skill and everything to do with this account (K4).
 */
function SkillCandidateRow({
  candidate,
  checked,
  disabled,
  onChange,
}: {
  candidate: SkillImportCandidate
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  const selectable = candidateSelectable(candidate)
  const files = skillFileList(candidate.files)

  return (
    <li
      data-slot="skill-candidate"
      data-candidate={candidate.name}
      data-selectable={selectable}
      data-picked={checked}
      className="rounded-lg border px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          aria-label={`Import ${candidate.name}`}
          className="mt-0.5 size-4 shrink-0 accent-primary"
          checked={checked}
          disabled={disabled || !selectable}
          onChange={(event) => onChange(event.target.checked)}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-mono text-sm">{candidate.name}</p>
          {candidate.description === null ? null : (
            <p className="text-xs text-muted-foreground" data-slot="skill-candidate-description">
              {candidate.description}
            </p>
          )}
          {candidate.name_taken ? (
            <p className="text-xs text-coral-ink" data-slot="skill-candidate-taken">
              You already have a skill called {candidate.name}.
            </p>
          ) : null}
          {candidate.problems.map((problem) => (
            <p
              key={`${problem.code}:${problem.message}`}
              data-slot="skill-candidate-problem"
              data-code={problem.code}
              className="text-xs text-destructive"
            >
              {problem.message}
            </p>
          ))}

          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 shrink-0 transition-transform [[data-state=open]_&]:rotate-90"
              />
              {files.length === 1 ? '1 file' : `${files.length} files`}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 space-y-2">
                <pre
                  data-slot="skill-candidate-skill-md"
                  className="max-h-64 overflow-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono text-2xs break-words whitespace-pre-wrap"
                >
                  {candidate.skill_md}
                </pre>
                <ul data-slot="skill-candidate-files" className="space-y-0.5">
                  {files.map((file) => (
                    <li key={file.path} className="flex items-baseline gap-2 text-2xs">
                      <code className="min-w-0 truncate font-mono">{file.path}</code>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {skillFileSizeLabel(file.size)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </li>
  )
}

/**
 * What an import failure says, with the two it can be told apart by named.
 *
 * The server's sentence is the whole of it — the protocol owns one per failure code, and a
 * repository that holds no `SKILL.md` says so — but a **name the reader already has** is a
 * different kind of answer (nothing is wrong with the repository: delete the skill, or pick
 * another), and it gets its own lead so it does not read as a fetch that failed.
 */
function failureLine(kind: SkillFailureKind, message: string): string {
  return kind === 'conflict' ? `Could not import: ${message}` : message
}

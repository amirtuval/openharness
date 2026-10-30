import { refreshChangeSummary, refreshFileChanges, shortCommit } from '@openharness/client'
import type { RefreshSkillPreviewResponse } from '@openharness/protocol'

import { Button } from '../ui/button'

/**
 * What a refresh would change, and the confirm that does it (epic #349, K5; issue #353).
 *
 * A refresh is **by hand and always previewed**: the panel opens on what a re-clone of the
 * skill's stored source found — the commit it landed on, the files added, removed and changed,
 * and `SKILL.md`'s unified diff, which is the one file a skill is really read by — and nothing
 * is replaced until the reader presses the confirm, which names the commit the preview resolved
 * (so a source that moved in between is refused rather than half-applied).
 *
 * **A source with nothing new is a result, not an empty panel**: the summary reads `unchanged`,
 * the commit is named, and the confirm is offered anyway — it is a no-op on the snapshot and
 * moves `refreshed_at`, which is how a reader says "I looked, and this is current". The one
 * thing the preview refuses is a snapshot that has **problems** (K1/K4): replacing a working
 * skill with a broken one is not a refresh, so the problems are drawn and the confirm is off.
 */
export function SkillRefreshPanel({
  skillName,
  loading,
  preview,
  failure,
  busy,
  onConfirm,
  onCancel,
}: {
  /** The skill's name, so the panel says which one it is about. */
  skillName: string
  /** The preview is still in flight. */
  loading: boolean
  /** What the re-clone found, or `null` while it is loading or after a failure. */
  preview: RefreshSkillPreviewResponse | null
  /** Why there is no preview, as the server stated it. */
  failure: { readonly message: string } | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const changes = preview === null ? [] : refreshFileChanges(preview)
  const problems = preview?.problems ?? []

  return (
    <div
      data-slot="skill-refresh"
      data-skill={skillName}
      className="mt-2 space-y-2 rounded-lg border px-3 py-2"
    >
      {loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Checking {skillName} for changes…
        </p>
      ) : failure !== null ? (
        <p role="status" data-slot="skill-refresh-failure" className="text-xs text-destructive">
          {failure.message}
        </p>
      ) : preview === null ? null : (
        <>
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              data-slot="skill-refresh-summary"
              data-changed={preview.changed}
              className="text-xs font-medium"
            >
              {refreshChangeSummary(preview)}
            </span>
            <code className="font-mono text-2xs text-muted-foreground">
              {shortCommit(preview.commit_sha)}
            </code>
          </div>

          {changes.length === 0 ? null : (
            <ul data-slot="skill-refresh-files" className="space-y-0.5">
              {changes.map((change) => (
                <li
                  key={`${change.kind}:${change.path}`}
                  data-kind={change.kind}
                  className="flex items-baseline gap-2 text-2xs"
                >
                  <span
                    className={
                      change.kind === 'removed'
                        ? 'shrink-0 text-destructive'
                        : change.kind === 'added'
                          ? 'shrink-0 text-primary'
                          : 'shrink-0 text-muted-foreground'
                    }
                  >
                    {change.kind}
                  </span>
                  <code className="min-w-0 font-mono break-words">{change.path}</code>
                </li>
              ))}
            </ul>
          )}

          {preview.skill_md_diff === null ? null : (
            <div className="space-y-1">
              <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                SKILL.md
              </p>
              <pre
                data-slot="skill-refresh-diff"
                className="max-h-64 overflow-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono text-2xs break-words whitespace-pre-wrap"
              >
                {preview.skill_md_diff}
              </pre>
            </div>
          )}

          {problems.map((problem) => (
            <p
              key={`${problem.code}:${problem.message}`}
              data-slot="skill-refresh-problem"
              className="text-xs text-destructive"
            >
              {problem.message}
            </p>
          ))}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || problems.length > 0}
              onClick={onConfirm}
            >
              {problems.length > 0
                ? 'Cannot refresh'
                : preview.changed
                  ? 'Replace with this version'
                  : 'Confirm'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

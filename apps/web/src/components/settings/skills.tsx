import { skillBadgeLabel, skillSourceLabel } from '@openharness/client'
import { skillSettingsOf } from '@openharness/protocol'
import type { RefreshSkillPreviewResponse, Skill } from '@openharness/protocol'
import { RefreshCw } from 'lucide-react'
import { useCallback, useState } from 'react'

import type { SkillsView } from '../../hooks/use-skills'
import { showNotice } from '../../lib/notice'
import { ErrorBanner } from '../chat/error-banner'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { SkillImportPanel } from './skill-import'
import { SkillRefreshPanel } from './skill-refresh'

/**
 * Settings → Skills (epic #349, K3/K5/K8; issue #353).
 *
 * The reader's imported skills, and the three things they do with them:
 *
 * - **the list** — one row per skill: its name and description, where it came from (the URL, the
 *   ref and folder it was taken at, and the short commit), a badge when the frontmatter gives it
 *   to one side of the conversation (`command only` for `disable-model-invocation` — the model is
 *   never told it exists — and `model only` for `user-invocable: false`, which is the one the
 *   `/` menu leaves out), an on/off switch (K8) and **Refresh** and **Delete**;
 * - **Import** (K3) — {@link SkillImportPanel}: a URL, then a preview of what the repository
 *   holds, then the candidates the reader picks;
 * - **Refresh** (K5) — {@link SkillRefreshPanel}: what a re-clone found, and the confirm.
 *
 * The words are `@openharness/client`'s throughout — `skillBadgeLabel`, `skillSourceLabel`,
 * `refreshChangeSummary` — so `oh`'s skills screen says exactly the same things about the same
 * skill, and the frontmatter fields are read through `skillSettingsOf` rather than off the map,
 * so "what does `user-invocable` default to" has one answer.
 *
 * A switch writes one field (`{ enabled }`) and the server answers the row, so the list follows
 * immediately. A delete confirms **in the page**, like every other destructive action here; the
 * chat that had the skill keeps its history — a conversation that already ran a skill read the
 * instructions it loaded from its own log (K5) — and only the next `/name` is gone.
 */
export function SkillsCard({ skills }: { skills: SkillsView }) {
  const [importing, setImporting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  // One previewed refresh at a time — the panel opens on the row it belongs to — held with the
  // row it is about, so a card of skills cannot show one skill's diff under another's name.
  const [refresh, setRefresh] = useState<SkillRefreshState | null>(null)

  const run = useCallback(
    async (action: Promise<{ ok: boolean; message?: string }>): Promise<void> => {
      setFailure(null)
      const result = await action
      if (!result.ok) {
        setFailure(result.message ?? 'The request failed.')
      }
      setConfirming(null)
    },
    [],
  )

  /** Read what a re-clone would change, and show the panel on the row it belongs to. */
  const previewRefresh = useCallback(
    async (skill: Skill): Promise<void> => {
      setFailure(null)
      setRefresh({ state: 'loading', skillId: skill.id })
      const result = await skills.previewRefresh(skill.id)
      setRefresh(
        result.ok
          ? { state: 'preview', skillId: skill.id, preview: result.value }
          : { state: 'failed', skillId: skill.id, message: result.message },
      )
    },
    [skills],
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Skills</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setImporting(true)
              setFailure(null)
            }}
            disabled={importing}
          >
            Import
          </Button>
        </div>
        <CardDescription>
          Skills you imported from a git repository. A skill your chats may use is offered to the
          model; one you can run is a <code className="font-mono">/</code> command in the composer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {skills.error === null ? null : (
          <ErrorBanner
            title="Could not load your skills"
            message={skills.error}
            onDismiss={skills.dismissError}
          />
        )}
        {failure === null ? null : (
          <ErrorBanner
            title="The skill request failed"
            message={failure}
            onDismiss={() => setFailure(null)}
          />
        )}

        {importing ? (
          <SkillImportPanel
            skills={skills}
            onImported={(count) => {
              setImporting(false)
              showNotice(count === 1 ? 'Imported one skill.' : `Imported ${count} skills.`)
            }}
            onCancel={() => setImporting(false)}
          />
        ) : null}

        {skills.loading ? (
          <p className="text-sm text-muted-foreground">Loading your skills…</p>
        ) : skills.skills.length === 0 && !importing ? (
          <p className="text-sm text-muted-foreground">
            No skills yet. Import one from a public repository —{' '}
            <code className="font-mono">https://github.com/anthropics/skills</code> is a place to
            start.
          </p>
        ) : (
          <ul className="space-y-3" data-slot="skill-list">
            {skills.skills.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                busy={skills.busy}
                confirming={confirming === skill.id}
                refresh={refresh !== null && refresh.skillId === skill.id ? refresh : null}
                onConfirming={(next) => {
                  setFailure(null)
                  setConfirming(next ? skill.id : null)
                }}
                onToggle={(enabled) =>
                  void run(skills.setEnabled(skill.id, enabled).then(asRunnable))
                }
                onRemove={() => void run(skills.remove(skill.id).then(asRunnable))}
                onRefresh={() => void previewRefresh(skill)}
                onRefreshConfirm={(commitSha) =>
                  void run(
                    skills.refresh(skill.id, commitSha).then((result) => {
                      if (result.ok) {
                        setRefresh(null)
                      }
                      return asRunnable(result)
                    }),
                  )
                }
                onRefreshCancel={() => setRefresh(null)}
              />
            ))}
          </ul>
        )}

        {skills.busy ? (
          <p role="status" className="text-xs text-muted-foreground">
            Working…
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** One skill: what it is, where it came from, and what can be done with it. */
function SkillRow({
  skill,
  busy,
  confirming,
  refresh,
  onConfirming,
  onToggle,
  onRemove,
  onRefresh,
  onRefreshConfirm,
  onRefreshCancel,
}: {
  skill: Skill
  busy: boolean
  confirming: boolean
  /** This row's refresh, in whatever state it is in, or `null` while it has none. */
  refresh: SkillRefreshState | null
  onConfirming: (next: boolean) => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
  onRefresh: () => void
  /** Replace the snapshot with the previewed one, at the commit the preview resolved (K5). */
  onRefreshConfirm: (commitSha: string) => void
  onRefreshCancel: () => void
}) {
  const settings = skillSettingsOf(skill)
  const badge = skillBadgeLabel(skill)

  return (
    <li
      data-slot="skill-row"
      data-skill={skill.name}
      data-enabled={skill.enabled}
      className="space-y-2 rounded-lg border px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{skill.name}</span>
        {badge === null ? null : (
          <Badge variant="outline" className="text-2xs" data-slot="skill-badge">
            {badge}
          </Badge>
        )}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label={`Enable ${skill.name}`}
            className="size-4 accent-primary"
            checked={skill.enabled}
            disabled={busy}
            onChange={(event) => onToggle(event.target.checked)}
          />
          On
        </label>
      </div>

      <p className="break-words text-xs text-muted-foreground" data-slot="skill-description">
        {skill.description}
      </p>
      <p
        className="truncate font-mono text-2xs text-muted-foreground"
        data-slot="skill-source"
        title={skillSourceLabel(skill.source)}
      >
        {skillSourceLabel(skill.source)}
      </p>
      {!settings.userInvocable ? (
        <p className="text-2xs text-muted-foreground">
          Not a command: only your chats can read it.
        </p>
      ) : null}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Delete {skill.name}? Chats that already ran it keep their history.
          </span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            aria-label={`Delete ${skill.name}`}
            onClick={onRemove}
            disabled={busy}
          >
            Delete
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onConfirming(false)}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Refresh ${skill.name}`}
            onClick={onRefresh}
            disabled={busy}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Delete ${skill.name}`}
            onClick={() => onConfirming(true)}
            disabled={busy}
          >
            Delete
          </Button>
        </div>
      )}

      {refresh === null ? null : (
        <SkillRefreshPanel
          skillName={skill.name}
          loading={refresh.state === 'loading'}
          preview={refresh.state === 'preview' ? refresh.preview : null}
          failure={refresh.state === 'failed' ? { message: refresh.message } : null}
          busy={busy}
          onConfirm={() => {
            if (refresh.state === 'preview') {
              onRefreshConfirm(refresh.preview.commit_sha)
            }
          }}
          onCancel={onRefreshCancel}
        />
      )}
    </li>
  )
}

/**
 * One row's refresh, in the one state it is in (K5): reading, previewed, or refused.
 *
 * Held beside the `skillId` it belongs to rather than in a map, because the card shows one
 * panel at a time — and because a preview under the wrong name would be a diff of one skill
 * presented as another's.
 */
type SkillRefreshState =
  | { readonly state: 'loading'; readonly skillId: string }
  | {
      readonly state: 'preview'
      readonly skillId: string
      readonly preview: RefreshSkillPreviewResponse
    }
  | { readonly state: 'failed'; readonly skillId: string; readonly message: string }

/** Whether a write changed the list, for the one `run` that only needs `ok` and a message. */
function asRunnable<T>(result: { ok: true; value: T } | { ok: false; message: string }): {
  ok: boolean
  message?: string
} {
  return result.ok ? { ok: true } : { ok: false, message: result.message }
}

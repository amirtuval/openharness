import { skillBadgeLabel, skillSourceLabel, type Client } from '@openharness/client'
import type { PreviewSkillImportResponse, Skill } from '@openharness/protocol'
import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { describeError, type ErrorContext } from '../errors'
import { SkillImportPicker } from './skill-import'
import {
  listJump,
  ScrollingList,
  useTerminalRows,
  VIEWPORT_HINT,
  viewportRows,
} from './list-viewport'
import { TextEntry } from './text-entry'

/**
 * The skills screen (epic #349, K3/K7/K8; #354) — `/skills`, and what `oh skills` reads in a
 * terminal.
 *
 * One flat, keyboard-driven list, the shape `/mcp` and `/tools` use, because a terminal has no
 * pointer: ↑/↓ move (with PgUp/PgDn/Home/End for a list longer than the screen), **space** turns
 * the highlighted skill on or off (K8 — one `POST /v1/me/skills/{id}`, the only field a reader
 * changes without a refresh), **`i`** imports one from a public git URL (the preview, then the
 * pick — K3, the same two steps the CLI runs), **`d`** removes one after a `y/N`, and **Esc**
 * leaves.
 *
 * **A mode may override which skills are on, and this screen does not touch that** (K8): the
 * switch here is the reader's own stored `enabled`, and `oh modes` shows what each mode
 * overrides, read-only. Editing a mode is the web app's business.
 *
 * Every word comes from `@openharness/client` — the badge, the source line, the pick's own
 * labels — so the terminal and the web app say the same thing about a skill.
 */
export function SkillsScreen({
  client,
  context,
  onDone,
}: {
  readonly client: Client
  readonly context: ErrorContext
  /** Called when the reader leaves: Esc, or Ctrl+C. */
  readonly onDone: () => void
}) {
  const terminalRows = useTerminalRows()
  const [skills, setSkills] = useState<readonly Skill[] | null>(null)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The URL being typed for an import, or `null` when no import flow is up. */
  const [url, setUrl] = useState<string | null>(null)
  /** The preview a URL read, while the reader is picking from it — or `null`. */
  const [preview, setPreview] = useState<PreviewSkillImportResponse | null>(null)
  /** The skill a `d` is asking about, or `null`. */
  const [confirming, setConfirming] = useState<Skill | null>(null)

  // The rows and the busy flag the key handler reads: Ink hands `useInput` the latest committed
  // render, so two keystrokes inside one render would both read the state from before them.
  const rowsRef = useRef<readonly Skill[]>([])
  const busyRef = useRef(false)

  const read = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const options = signal === undefined ? undefined : { signal }
      try {
        const { data } = await client.skills.list(options)
        rowsRef.current = data
        setSkills(data)
        setError(null)
      } catch (failure) {
        if (signal?.aborted === true) return
        setError(describeError(failure, context).message)
        setSkills((current) => current ?? [])
      }
    },
    [client, context],
  )

  useEffect(() => {
    const controller = new AbortController()
    void read(controller.signal)
    return () => {
      controller.abort()
    }
  }, [read])

  const rows = skills ?? []
  const at = Math.min(index, Math.max(rows.length - 1, 0))
  const chrome = 5
  const capacity = viewportRows(terminalRows, chrome)

  const moveTo = (next: number): void => {
    const clamped = Math.min(Math.max(next, 0), Math.max(rows.length - 1, 0))
    setIndex(clamped)
  }

  /** One change, one write: the switch is the reader's own `enabled` (K8). */
  const setEnabled = useCallback(
    async (skill: Skill, enabled: boolean): Promise<void> => {
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNote(null)
      try {
        await client.skills.update(skill.id, { enabled })
        await read()
        setNote(`${skill.name} turned ${enabled ? 'on' : 'off'}.`)
      } catch (failure) {
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context, read],
  )

  const remove = useCallback(
    async (skill: Skill): Promise<void> => {
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNote(null)
      try {
        await client.skills.delete(skill.id)
        await read()
        setNote(`Removed ${skill.name}.`)
      } catch (failure) {
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context, read],
  )

  /** Read a URL's candidates, then hand the reader the pick (K3). */
  const startImport = useCallback(
    async (candidateUrl: string): Promise<void> => {
      const trimmed = candidateUrl.trim()
      if (trimmed === '') {
        setUrl(null)
        return
      }
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNote(null)
      try {
        const found = await client.skills.previewImport({ url: trimmed })
        setUrl(null)
        setPreview(found)
      } catch (failure) {
        setUrl(null)
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context],
  )

  const importChosen = useCallback(
    async (names: readonly string[]): Promise<void> => {
      const found = preview
      if (found === null) return
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNote(null)
      try {
        const stored = await client.skills.import({
          url: found.url,
          ...(found.ref === null ? {} : { ref: found.ref }),
          ...(found.path === null ? {} : { path: found.path }),
          commit_sha: found.commit_sha,
          names: [...names],
        })
        setPreview(null)
        await read()
        setNote(
          `Imported ${stored.data.length === 1 ? stored.data[0]?.name : `${stored.data.length} skills`}.`,
        )
      } catch (failure) {
        setPreview(null)
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context, preview, read],
  )

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onDone()
      return
    }
    // A flow owns the keyboard while it is up: the URL field and the pick read their own keys.
    if (url !== null || preview !== null) return

    if (confirming !== null) {
      if (key.escape) {
        setConfirming(null)
        return
      }
      if (input === 'y' || input === 'Y') {
        const skill = confirming
        setConfirming(null)
        void remove(skill)
        return
      }
      if (input === 'n' || input === 'N' || key.return) {
        setConfirming(null)
      }
      return
    }

    if (key.escape) {
      onDone()
      return
    }
    if (busyRef.current) return

    if (key.upArrow) {
      moveTo(index - 1)
      return
    }
    if (key.downArrow) {
      moveTo(index + 1)
      return
    }
    const jumped = listJump(index, rows.length, key, capacity)
    if (jumped !== null) {
      moveTo(jumped)
      return
    }

    const row = rowsRef.current[Math.min(index, Math.max(rowsRef.current.length - 1, 0))]
    if (input === 'i') {
      setUrl('')
      return
    }
    if (row === undefined) return
    if (input === ' ') {
      void setEnabled(row, !row.enabled)
      return
    }
    if (input === 'd') {
      setConfirming(row)
    }
  })

  return (
    <Box flexDirection="column">
      <Text>Skills</Text>
      {error !== null && <Text color="red">{error}</Text>}
      {note !== null && <Text dimColor>{note}</Text>}
      {busy && <Text dimColor>working…</Text>}
      {url !== null ? (
        <TextEntry
          label="Import a skill from a public git URL (or a GitHub/GitLab browse URL)"
          onSubmit={(value) => {
            void startImport(value)
          }}
          onCancel={() => {
            setUrl(null)
          }}
        />
      ) : preview !== null ? (
        <SkillImportPicker
          preview={preview}
          onConfirm={(names) => {
            void importChosen(names)
          }}
          onCancel={() => {
            setPreview(null)
          }}
        />
      ) : confirming !== null ? (
        <Text>{`Remove ${confirming.name}? This cannot be undone [y/N] `}</Text>
      ) : skills === null ? (
        <Text dimColor>reading your skills…</Text>
      ) : rows.length === 0 ? (
        <Text dimColor>No skills yet. Press i to import one from a public git repository.</Text>
      ) : (
        <ScrollingList
          items={rows}
          index={at}
          rows={terminalRows}
          chrome={chrome}
          rowLines={2}
          renderRow={(skill, position, marker) => (
            <>
              <Text color={position === at ? 'cyan' : undefined}>
                {`${marker} ${skillRowHead(skill)}`}
              </Text>
              <Text dimColor>{`  ${skillRowDetail(skill)}`}</Text>
            </>
          )}
        />
      )}
      <Text dimColor>{`space on/off · i import · d remove · ${VIEWPORT_HINT} · Esc done`}</Text>
    </Box>
  )
}

/** A skill's leading line: its name, whether it is on, and the badge its frontmatter earns. */
export function skillRowHead(skill: Skill): string {
  const badge = skillBadgeLabel(skill)
  return [skill.name, skill.enabled ? 'on' : 'off', ...(badge === null ? [] : [badge])].join('  ')
}

/**
 * A skill's second line: where its snapshot came from, and what it says it does.
 *
 * The source is `skillSourceLabel` — the URL, the ref and path, and the short commit — which is
 * the same line the web app's settings row shows (`oh`'s own `oh skills` listing prints it too),
 * so what a reader imported and what the snapshot really is are told apart.
 */
export function skillRowDetail(skill: Skill): string {
  const source = skillSourceLabel(skill.source)
  return skill.description === '' ? source : `${source} — ${skill.description}`
}

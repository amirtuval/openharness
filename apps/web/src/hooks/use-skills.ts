import { ApiError, type Client } from '@openharness/client'
import type {
  ImportSkillsResponse,
  PreviewSkillImportRequest,
  PreviewSkillImportResponse,
  RefreshSkillPreviewResponse,
  Skill,
  SkillImportRequest,
} from '@openharness/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'
import { describeError } from '../lib/errors'
import { useSettings } from './use-settings'

/**
 * Why a skill read or write did not happen.
 *
 * - `conflict` — the server refused it as a conflict (epic #349, K4): a name the reader already
 *   has, or the fifty-first skill. The message belongs beside the field or the row it is about,
 *   because renaming or deleting fixes it.
 * - `import` — a 422 `skill_import_error` (K3, K5): the repository could not be read, or a
 *   picked candidate cannot be stored. The server's sentence is the whole story, and it goes
 *   beside the URL the reader typed rather than in a banner.
 * - `session` — a 401: the reader has to sign in again.
 * - `error` — anything else, as one line.
 */
export type SkillFailureKind = 'conflict' | 'import' | 'session' | 'error'

/** A read or write that keeps the resource, or the reason there is none. */
export type SkillResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: SkillFailureKind; readonly message: string }

/** One skill's previewed refresh, as the screen holds it between the preview and the confirm. */
export interface SkillRefreshPreview {
  /** The `skl_` id it belongs to. */
  readonly skillId: string
  /** What the re-clone found (K5). */
  readonly preview: RefreshSkillPreviewResponse
}

/** The reader's skills, and everything Settings → Skills does with them (epic #349). */
export interface SkillsView {
  /** The reader's skills, oldest first, as the server sorted them. */
  readonly skills: readonly Skill[]
  /** The first read is still in flight. */
  readonly loading: boolean
  /** A failed read, as shown inline. */
  readonly error: string | null
  /** A write is in flight — one at a time, which is what the buttons are disabled for. */
  readonly busy: boolean
  /** Switch a skill on or off for this user's chats (K8). */
  readonly setEnabled: (skillId: string, enabled: boolean) => Promise<SkillResult<Skill>>
  /** Delete a skill and its snapshot. */
  readonly remove: (skillId: string) => Promise<SkillResult<void>>
  /** Read what a repository holds — the import's first step (K3). */
  readonly previewImport: (
    body: PreviewSkillImportRequest,
  ) => Promise<SkillResult<PreviewSkillImportResponse>>
  /** Store the candidates the reader picked, at the previewed commit (K3). */
  readonly importSkills: (body: SkillImportRequest) => Promise<SkillResult<ImportSkillsResponse>>
  /** Read what a re-clone of a skill's stored source changed (K5). */
  readonly previewRefresh: (skillId: string) => Promise<SkillResult<RefreshSkillPreviewResponse>>
  /** Replace a skill's snapshot with what its preview read (K5). */
  readonly refresh: (skillId: string, commitSha: string) => Promise<SkillResult<Skill>>
  /** Read the list again. */
  readonly reload: () => Promise<void>
  /** Clear the load error. */
  readonly dismissError: () => void
}

/**
 * The reader's imported skills (epic #349, K4/K5; the screens are #353 and #354).
 *
 * Loaded once for the whole shell, beside the catalog and the modes, because three surfaces
 * read the same list: the composer's `/` menu (K7 — only the enabled, user-invocable ones), the
 * mode editor's skills override (K8) and Settings → Skills. Every write replaces what it
 * touched, so a switch or a refresh is visible everywhere at once, and the two flows a skill
 * has — import and refresh — are previewed and then confirmed through the same hook, so the
 * screen never holds a request the server has not answered.
 *
 * A failed write is classified rather than thrown: an import's refusal belongs beside the URL
 * (`kind: 'import'`), a duplicate name beside the field (`kind: 'conflict'`), a 401 to the
 * sign-in page, and everything else is one line.
 */
export function useSkills(client: Client): SkillsView {
  const [skills, setSkills] = useState<readonly Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { serverUrl } = useSettings()
  // An answer that arrives after the hook unmounted — or after a settings save rebuilt the
  // client, which re-runs the effect below — must not be applied.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const { data } = await client.skills.list(signal === undefined ? undefined : { signal })
        if (!mounted.current) {
          return
        }
        setSkills(data)
        setError(null)
      } catch (caught) {
        if (signal?.aborted === true) {
          return
        }
        if (!noteAuthenticationError(client, caught)) {
          setError(describeError(caught, { serverUrl }))
        }
      }
    },
    [client, serverUrl],
  )

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted && mounted.current) {
        setLoading(false)
      }
    })
    return () => controller.abort()
  }, [load])

  /** Replace one row in place from a write's answer, or append it when it is new. */
  const keep = useCallback((skill: Skill): void => {
    setSkills((current) => {
      const index = current.findIndex((each) => each.id === skill.id)
      if (index === -1) {
        return [...current, skill]
      }
      return current.map((each) => (each.id === skill.id ? skill : each))
    })
  }, [])

  /**
   * The failure a write leaves, in the four classes the routes have.
   *
   * A 409 (`conflict_error`) is a name the reader already has or the fifty-first skill; a 422
   * `skill_import_error` is the repository or the candidate (K3, K5) and its sentence is the
   * protocol's own; a 401 signs the app out through the auth store; everything else is one line.
   */
  const classify = useCallback(
    (caught: unknown): { kind: SkillFailureKind; message: string } => {
      if (noteAuthenticationError(client, caught)) {
        return { kind: 'session', message: describeError(caught, { serverUrl }) }
      }
      const kind: SkillFailureKind =
        caught instanceof ApiError && caught.type === 'conflict_error'
          ? 'conflict'
          : caught instanceof ApiError && caught.type === 'skill_import_error'
            ? 'import'
            : 'error'
      return { kind, message: describeError(caught, { serverUrl }) }
    },
    [client, serverUrl],
  )

  /**
   * Run one write: one at a time, with the load error cleared, and a failure classified.
   *
   * `absorb` says what the write's answer does to the list — the one skill it replaced or
   * created, the batch an import stored, or nothing at all — so every call states what its
   * answer means rather than the hook guessing it from a shape. A write that changes which rows
   * exist (a delete) leaves the list to its caller.
   */
  const run = useCallback(
    async <T>(
      work: () => Promise<T>,
      absorb: (value: T) => readonly Skill[],
    ): Promise<SkillResult<T>> => {
      setBusy(true)
      setError(null)
      try {
        const value = await work()
        if (mounted.current) {
          for (const skill of absorb(value)) {
            keep(skill)
          }
        }
        return { ok: true, value }
      } catch (caught) {
        return { ok: false, ...classify(caught) }
      } finally {
        if (mounted.current) {
          setBusy(false)
        }
      }
    },
    [classify, keep],
  )

  const setEnabled = useCallback(
    (skillId: string, enabled: boolean): Promise<SkillResult<Skill>> =>
      run(() => client.skills.update(skillId, { enabled }), one),
    [client, run],
  )

  const remove = useCallback(
    async (skillId: string): Promise<SkillResult<void>> => {
      const result = await run(async () => {
        await client.skills.delete(skillId)
        return undefined
      }, none)
      if (result.ok) {
        setSkills((current) => current.filter((skill) => skill.id !== skillId))
      }
      return result
    },
    [client, run],
  )

  const previewImport = useCallback(
    (body: PreviewSkillImportRequest): Promise<SkillResult<PreviewSkillImportResponse>> =>
      run(() => client.skills.previewImport(body), none),
    [client, run],
  )

  const importSkills = useCallback(
    (body: SkillImportRequest): Promise<SkillResult<ImportSkillsResponse>> =>
      run(() => client.skills.import(body), imported),
    [client, run],
  )

  const previewRefresh = useCallback(
    (skillId: string): Promise<SkillResult<RefreshSkillPreviewResponse>> =>
      run(() => client.skills.previewRefresh(skillId), none),
    [client, run],
  )

  const refresh = useCallback(
    (skillId: string, commitSha: string): Promise<SkillResult<Skill>> =>
      run(() => client.skills.refresh(skillId, { commit_sha: commitSha }), one),
    [client, run],
  )

  const reload = useCallback(async (): Promise<void> => {
    await load()
  }, [load])

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return {
    skills,
    loading,
    error,
    busy,
    setEnabled,
    remove,
    previewImport,
    importSkills,
    previewRefresh,
    refresh,
    reload,
    dismissError,
  }
}

/**
 * What each write's answer does to the list.
 *
 * `one` is a write that answers the skill it touched (a switch, a refresh); `imported` is the
 * batch an import stored, which arrives under `data`; `none` is a write that changes no row —
 * a delete, whose row the caller drops, and the two previews, which answer a plan rather than a
 * skill.
 */
const one = (skill: Skill): readonly Skill[] => [skill]
const imported = (result: ImportSkillsResponse): readonly Skill[] => result.data
const none = (): readonly Skill[] => []

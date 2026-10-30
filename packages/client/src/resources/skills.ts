import {
  API_VERSION_PREFIX,
  GetSkillResponseSchema,
  ImportSkillsResponseSchema,
  ListSkillsResponseSchema,
  PreviewSkillImportResponseSchema,
  RefreshSkillPreviewResponseSchema,
  SkillFileContentSchema,
  SkillSchema,
} from '@openharness/protocol'
import type {
  ImportSkillsResponse,
  ListSkillsResponse,
  PreviewSkillImportRequest,
  PreviewSkillImportResponse,
  RefreshSkillPreviewResponse,
  RefreshSkillRequest,
  Skill,
  SkillFileContent,
  SkillImportRequest,
  UpdateSkillRequest,
} from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'

/**
 * The caller's own imported skills (epic #349, K4/K5; the screens are #353 and #354).
 *
 * ```
 * GET    /v1/me/skills/{id}                       get     -> skill + SKILL.md's content
 * GET    /v1/me/skills/{id}/files/{path}          file    -> that file's content
 * GET    /v1/me/skills                            list    -> { data: skill[] }
 * POST   /v1/me/skills/{id}                       update  -> skill    (enabled)
 * DELETE /v1/me/skills/{id}                       delete  -> 204
 * POST   /v1/me/skills/import/preview             preview -> the commit and its candidates
 * POST   /v1/me/skills/import                     import  -> { data: skill[] }
 * POST   /v1/me/skills/{id}/refresh/preview       preview -> what changed
 * POST   /v1/me/skills/{id}/refresh               refresh -> skill
 * ```
 *
 * A skill is per user — its routes live under `/v1/me`, its owner is the authenticated caller,
 * and another user's skill is a 404 — and it is a **snapshot** of a folder of files taken from
 * a public git repository (K1, K3, K4). The list has no pagination: a user holds at most
 * `MAX_SKILLS_PER_USER` skills, so a settings screen shows them all at once.
 *
 * Two things make this resource different from the other per-user ones, and both are the
 * import's shape rather than the resource's:
 *
 * - **Import is two steps** (K3). `previewImport` clones the repository and answers what it
 *   holds — every candidate folder, with its whole `SKILL.md`, its files and its problems —
 *   and nothing is stored; `import` names the candidates the reader picked **and the commit the
 *   preview resolved**, so what is stored is what was reviewed. A ref that has moved in between
 *   is refused rather than imported.
 * - **Refresh is by hand and previewed the same way** (K5). `previewRefresh` re-clones the
 *   skill's own stored source and answers the diff against the stored snapshot — files added,
 *   removed and changed, and `SKILL.md`'s unified diff — and `refresh` confirms it at that
 *   commit. A preview of an unchanged skill is still a commit, so it can be confirmed (a no-op
 *   on the snapshot that moves `refreshed_at`).
 *
 * A file's content is never in a listing: `get` carries `SKILL.md` (the one file a skill is
 * read by) and `file` reads any other one by path.
 */
export interface SkillsResource {
  /**
   * List the caller's skills, oldest first.
   *
   * @param options request options (cancellation)
   */
  list(options?: RequestOptions): Promise<ListSkillsResponse>

  /**
   * Read one skill, with `SKILL.md`'s content: the whole file, frontmatter and body.
   *
   * @param skillId the `skl_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such skill, or it is another
   * user's
   */
  get(skillId: string, options?: RequestOptions): Promise<GetSkillContent>

  /**
   * Read one file of a skill's snapshot, by its path inside the skill folder.
   *
   * @param skillId the `skl_` id
   * @param path the file's path, relative to the skill folder and forward-slashed
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when the skill or the file is not there
   */
  file(skillId: string, path: string, options?: RequestOptions): Promise<SkillFileContent>

  /**
   * Switch a skill on or off for this user's chats (K8).
   *
   * The only field of a skill a reader changes without a refresh: what a skill *is* comes from
   * its snapshot.
   *
   * @param skillId the `skl_` id
   * @param body the new `enabled`
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such skill
   */
  update(skillId: string, body: UpdateSkillRequest, options?: RequestOptions): Promise<Skill>

  /**
   * Delete a skill and its snapshot.
   *
   * @param skillId the `skl_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such skill
   */
  delete(skillId: string, options?: RequestOptions): Promise<void>

  /**
   * Read what a repository holds, without storing anything — the import's first step (K3).
   *
   * @param body the URL, and the optional `ref` and `path` inside it
   * @param options request options (cancellation)
   * @throws ApiError with `skill_import_error` (422) when the repository could not be read;
   * the message is the protocol's own sentence for what went wrong
   */
  previewImport(
    body: PreviewSkillImportRequest,
    options?: RequestOptions,
  ): Promise<PreviewSkillImportResponse>

  /**
   * Store the candidates the reader picked, at the commit the preview resolved — the second
   * step (K3).
   *
   * @param body the same source, the previewed `commit_sha`, and the candidates' names
   * @param options request options (cancellation)
   * @throws ApiError with `skill_import_error` (422), `conflict_error` (409) for a name the
   * caller already has, or `invalid_request_error` (400) for a name the preview did not offer
   */
  import(body: SkillImportRequest, options?: RequestOptions): Promise<ImportSkillsResponse>

  /**
   * Read what a re-clone of a skill's stored source changed — the refresh's first step (K5).
   *
   * @param skillId the `skl_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` for an unknown skill, or `skill_import_error` (422)
   * when the source could not be read again
   */
  previewRefresh(skillId: string, options?: RequestOptions): Promise<RefreshSkillPreviewResponse>

  /**
   * Replace a skill's snapshot with what the preview read (K5).
   *
   * @param skillId the `skl_` id
   * @param body the commit the refresh preview resolved
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error`, or `skill_import_error` (422) for a snapshot whose
   * preview had problems — replacing a working skill with a broken one is not a refresh
   */
  refresh(skillId: string, body: RefreshSkillRequest, options?: RequestOptions): Promise<Skill>
}

/**
 * The single-skill read: the resource, plus `SKILL.md` as stored.
 *
 * Spelled from the protocol's own `GetSkillResponse` rather than restated, so a field the
 * resource grows reaches this type too.
 */
export type GetSkillContent = Skill & { readonly content: string }

/** Build the skills resource over a transport. */
export function createSkillsResource(transport: Transport): SkillsResource {
  const path = `${API_VERSION_PREFIX}/me/skills`

  return {
    list(options) {
      return transport.json(ListSkillsResponseSchema, {
        method: 'GET',
        path,
        signal: options?.signal,
      })
    },

    get(skillId, options) {
      return transport.json(GetSkillResponseSchema, {
        method: 'GET',
        path: `${path}/${skillId}`,
        signal: options?.signal,
      })
    },

    file(skillId, filePath, options) {
      return transport.json(SkillFileContentSchema, {
        method: 'GET',
        path: `${path}/${skillId}/files/${encodeFilePath(filePath)}`,
        signal: options?.signal,
      })
    },

    update(skillId, body, options) {
      return transport.json(SkillSchema, {
        method: 'POST',
        path: `${path}/${skillId}`,
        body,
        signal: options?.signal,
      })
    },

    delete(skillId, options) {
      return transport.noContent({
        method: 'DELETE',
        path: `${path}/${skillId}`,
        signal: options?.signal,
      })
    },

    previewImport(body, options) {
      return transport.json(PreviewSkillImportResponseSchema, {
        method: 'POST',
        path: `${path}/import/preview`,
        body,
        signal: options?.signal,
      })
    },

    import(body, options) {
      return transport.json(ImportSkillsResponseSchema, {
        method: 'POST',
        path: `${path}/import`,
        body,
        signal: options?.signal,
      })
    },

    previewRefresh(skillId, options) {
      return transport.json(RefreshSkillPreviewResponseSchema, {
        method: 'POST',
        path: `${path}/${skillId}/refresh/preview`,
        signal: options?.signal,
      })
    },

    refresh(skillId, body, options) {
      return transport.json(SkillSchema, {
        method: 'POST',
        path: `${path}/${skillId}/refresh`,
        body,
        signal: options?.signal,
      })
    },
  }
}

/**
 * A file's path as a URL path: each segment percent-encoded, the slashes kept.
 *
 * The route takes the whole path in one parameter (`files/:path{.+}`), so a `reference/tone.md`
 * has to arrive as two encoded segments rather than one encoded string — and a file whose name
 * holds a `#`, a space or a `?` has to arrive as itself.
 */
function encodeFilePath(filePath: string): string {
  return filePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

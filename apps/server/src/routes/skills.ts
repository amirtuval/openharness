import type { Context, Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  PreviewSkillImportRequestSchema,
  RefreshSkillRequestSchema,
  SKILL_MD_FILENAME,
  SkillImportRequestSchema,
  UpdateSkillRequestSchema,
  type SkillId,
} from '@openharness/protocol'

import { notFoundError } from '../http/errors'
import { parseBody, skillIdParam } from '../http/request'
import type { AppEnv } from '../types'
import type { RouteDeps } from './deps'

/** Where the skill resource lives under the version prefix. */
const SKILLS_PATH = `${API_VERSION_PREFIX}/me/skills`

/**
 * The skill endpoints (epic #349, K4; the resource itself: `@openharness/protocol`):
 *
 * ```
 * GET    /v1/me/skills                                the caller's own, oldest first
 * GET    /v1/me/skills/{skill_id}                     one, with SKILL.md's content, or 404
 * GET    /v1/me/skills/{skill_id}/files/{path}        one file's content, or 404
 * POST   /v1/me/skills/{skill_id}                     update `enabled`, or 404
 * DELETE /v1/me/skills/{skill_id}                     204, or 404
 * POST   /v1/me/skills/import/preview                 what a repository holds, or 422
 * POST   /v1/me/skills/import                         store the picked candidates, or 422
 * POST   /v1/me/skills/{skill_id}/refresh/preview     what changed, or 404
 * POST   /v1/me/skills/{skill_id}/refresh             replace the snapshot, or 404
 * ```
 *
 * The four that read a repository (#351, epic #349 K3/K5) are thin: the URL reading, the
 * clone, the candidate discovery and the diff are `skills-import.ts`, and what is here is the
 * body, the owner and the one 404 a route can answer. The import routes are registered
 * **before** the `{skill_id}` ones so `…/skills/import` can never be read as a skill id —
 * Hono prefers a static segment anyway, and spelling it out is cheaper than relying on that.
 *
 * Every skill belongs to the caller like any other resource (A4): the owner is always
 * `c.get('user').id`, no request carries one, and another user's skill answers 404 rather than
 * 403 — including its files, where an unknown path and somebody else's skill are the same
 * absent row and so the same 404.
 *
 * The two store refusals an import will meet — a name the caller already has, and the
 * fifty-first skill — are the protocol's `conflict_error` (409), mapped in `app.ts` beside the
 * mode and MCP-server ones.
 */
export function registerSkillRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const skills = SKILLS_PATH
  const skill = (c: Context<AppEnv>): SkillId => skillIdParam(c, 'skill_id')

  // Import is two steps and the server holds nothing between them (K3): the preview reads the
  // repository and answers, and the import reads it again and refuses a ref that has moved. Both
  // are the caller's own skills, like every other route here — the owner is `c.get('user').id`
  // and no request carries one.
  app.post(`${skills}/import/preview`, async (c) => {
    const body = await parseBody(c, PreviewSkillImportRequestSchema)
    return c.json(await deps.skillImport.preview(c.get('user').id, body))
  })

  app.post(`${skills}/import`, async (c) => {
    const body = await parseBody(c, SkillImportRequestSchema)
    const stored = await deps.skillImport.importSkills(c.get('user').id, body)
    return c.json({ data: stored }, 201)
  })

  // A refresh is by hand (K5): the preview re-clones the skill's stored source and shows the
  // diff, and the confirm names the commit it resolved — so what is stored is what was read.
  app.post(`${skills}/:skill_id/refresh/preview`, async (c) => {
    const skillId = skill(c)
    const answer = await deps.skillImport.previewRefresh(c.get('user').id, skillId)
    if (answer === null) {
      throw notFoundError(`no skill with id ${skillId}`)
    }
    return c.json(answer)
  })

  app.post(`${skills}/:skill_id/refresh`, async (c) => {
    const body = await parseBody(c, RefreshSkillRequestSchema)
    const skillId = skill(c)
    const updated = await deps.skillImport.refresh(c.get('user').id, skillId, body.commit_sha)
    if (updated === null) {
      throw notFoundError(`no skill with id ${skillId}`)
    }
    return c.json(updated)
  })

  app.get(skills, async (c) => {
    const data = await deps.skills.list({ ownerId: c.get('user').id })
    return c.json({ data })
  })

  app.get(`${skills}/:skill_id`, async (c) => {
    const skillId = skill(c)
    const scope = { ownerId: c.get('user').id }
    const found = await deps.skills.get(skillId, scope)
    if (found === null) {
      throw notFoundError(`no skill with id ${skillId}`)
    }
    // The one read that carries a file's content without a second request: a skill is read by
    // its `SKILL.md`, and a settings screen that had to fetch it separately would make two
    // requests to draw one row.
    const skillMd = await deps.skills.getFile(skillId, scope, SKILL_MD_FILENAME)
    if (skillMd === null) {
      // A skill always carries a `SKILL.md` — the store refuses a snapshot without one (K1) —
      // so this is a broken invariant and not a client's mistake. It is thrown rather than
      // answered as a 404, which would say the skill is missing when it is here, and `app.ts`
      // logs it and answers the generic 500.
      throw new Error(`skill ${skillId} has no ${SKILL_MD_FILENAME}`)
    }
    return c.json({ ...found, content: skillMd.content })
  })

  // A skill's file paths are relative and may hold slashes (`reference/tone.md`), so the path
  // is the rest of the URL rather than one segment — and Hono decodes it, which is what makes
  // `%20` in a path mean a space. A path no file has, and a traversal no snapshot could hold,
  // are both simply not found.
  app.get(`${skills}/:skill_id/files/:path{.+}`, async (c) => {
    const skillId = skill(c)
    const path = c.req.param('path')
    const found = await deps.skills.getFile(skillId, { ownerId: c.get('user').id }, path)
    if (found === null) {
      throw notFoundError(`no file ${path} in skill ${skillId}`)
    }
    return c.json(found)
  })

  app.post(`${skills}/:skill_id`, async (c) => {
    const body = await parseBody(c, UpdateSkillRequestSchema)
    const skillId = skill(c)
    const updated = await deps.skills.setEnabled(
      skillId,
      { ownerId: c.get('user').id },
      body.enabled,
    )
    if (updated === null) {
      throw notFoundError(`no skill with id ${skillId}`)
    }
    return c.json(updated)
  })

  app.delete(`${skills}/:skill_id`, async (c) => {
    const skillId = skill(c)
    if (!(await deps.skills.delete(skillId, { ownerId: c.get('user').id }))) {
      throw notFoundError(`no skill with id ${skillId}`)
    }
    return c.body(null, 204)
  })
}

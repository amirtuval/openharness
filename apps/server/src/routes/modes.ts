import type { Context, Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  CreateModeRequestSchema,
  UpdateModeRequestSchema,
} from '@openharness/protocol'
import type { Mode } from '@openharness/protocol'

import type { AppEnv } from '../types'
import { notFoundError } from '../http/errors'
import { modeIdParam, parseBody } from '../http/request'
import { requireOwnedMode } from '../modes'
import type { RouteDeps } from './deps'

/**
 * The mode endpoints (epic #245, M6): a user's own named presets, under `/v1/me/modes`.
 *
 * A mode belongs to the caller like every other resource (A4): the owner is always
 * `c.get('user').id`, no request carries one, and another user's mode answers 404 rather than
 * 403. The routes only read and write; what a mode *resolves to* — its model, its "my default
 * model", and whether that model can be used — is `modes.ts`, and a chat is refused an
 * unusable mode in the session and event routes.
 *
 * Two store refusals reach the client as the protocol's `conflict_error` (409), mapped in
 * `app.ts`: a name the caller already has, and the twentieth-plus-one mode.
 *
 * A mode's **tool override** (`tools`, #307/#311) is stored exactly as the body spells it and
 * is not checked against anything: the built-in names are free text a settings screen writes,
 * and the `mcp_servers` map is keyed by `mcps_` id — validated as an id by the protocol's
 * schema, never against the servers the caller happens to have. That is deliberate: a mode
 * naming a server that is later deleted must keep working, because deleting the server is a
 * separate act and rewriting every mode that mentioned it would make the delete fail or
 * silently edit a user's presets. The override is resolved at request time instead, where a
 * name nothing matches is simply no instruction (`mcp/in-force.ts`, `tool-settings.ts`).
 */
export function registerModeRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const modes = `${API_VERSION_PREFIX}/me/modes`
  const mode = (c: Context<AppEnv>): ReturnType<typeof modeIdParam> => modeIdParam(c, 'mode_id')

  app.post(modes, async (c) => {
    const body = await parseBody(c, CreateModeRequestSchema)
    const created = await deps.store.createMode(body, c.get('user').id)
    return c.json(created, 201)
  })

  app.get(modes, async (c) => {
    const data: Mode[] = await deps.store.listModes({ ownerId: c.get('user').id })
    return c.json({ data })
  })

  app.get(`${modes}/:mode_id`, async (c) => {
    return c.json(await requireOwnedMode(deps, c.get('user').id, mode(c)))
  })

  app.post(`${modes}/:mode_id`, async (c) => {
    const modeId = mode(c)
    const body = await parseBody(c, UpdateModeRequestSchema)
    // `updateMode` is owner-scoped, so a mode that is not the caller's answers `null` — the
    // same 404 an unknown id gets, in the same call that would have edited it (A4).
    const updated = await deps.store.updateMode(modeId, body, { ownerId: c.get('user').id })
    if (updated === null) {
      throw notFoundError(`no mode with id ${modeId}`)
    }
    return c.json(updated)
  })

  app.delete(`${modes}/:mode_id`, async (c) => {
    const modeId = mode(c)
    // The delete is owner-scoped and answers `false` either way — an unknown id and somebody
    // else's mode look the same, so nothing leaks. It also lands the chats that followed the
    // mode on the model they last ran, in the same transaction (see `@openharness/session`).
    if (!(await deps.store.deleteMode(modeId, { ownerId: c.get('user').id }))) {
      throw notFoundError(`no mode with id ${modeId}`)
    }
    return c.body(null, 204)
  })
}

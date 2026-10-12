import type { Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  ListToolSettingsQuerySchema,
  ListToolSettingsResponseSchema,
  PutToolSettingsRequestSchema,
} from '@openharness/protocol'
import type { UserToolSettings } from '@openharness/protocol'

import type { AppEnv } from '../types'
import { parseBody, parseQuery } from '../http/request'
import { listToolSettings, toolSettingEntries } from '../tool-settings'
import type { RouteDeps } from './deps'

/**
 * The caller's tool settings (epic #303, X4; issue #307): `GET`/`PUT /v1/me/tools`.
 *
 * A resource of its own rather than more fields on `PUT /v1/me/preferences`, and the reason is
 * the shape: preferences are one value of scalars — a default model, a theme, three compaction
 * controls — while tool settings are a **map** keyed by tool name that grows with the build,
 * whose entries a settings screen flips one at a time, and whose MCP half (#311/#312) will be
 * siblings of that map — a permission per MCP tool — rather than more scalars. What this route
 * does not carry is which MCP **servers** are in play: that is the resource's own `enabled`
 * (`/v1/me/mcp_servers`), which a mode may override (`tools.mcp_servers`, #311). A `PUT` here
 * merges per tool, the same "a write changes what it names" rule the preferences route follows
 * at the one granularity the caller has.
 *
 * Both verbs are owner-only, like every `/v1/me` route: the resource is the caller, and there
 * is no id in the path to get wrong. The `GET` takes an optional `mode_id` and answers as a
 * chat on that mode would see things — the mode's override applied over the user's choices —
 * which is how a composer shows "the tools this chat would get" without merging the two
 * itself. A mode the caller does not own is the 404 every other mode read gives (A4).
 *
 * The listing is the **effective** answer: the tools this deployment registers, with their
 * declared defaults filled in, plus any stored setting for a tool that is not registered —
 * listed as `available: false` rather than hidden, so a user can see why a tool they switched
 * on is not working here.
 */
export function registerToolSettingsRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const settings = { store: deps.store, tools: deps.tools }

  app.get(`${API_VERSION_PREFIX}/me/tools`, async (c) => {
    const { mode_id: modeId } = parseQuery(c, ListToolSettingsQuerySchema)
    const data = await listToolSettings(settings, c.get('user').id, modeId)
    return c.json(ListToolSettingsResponseSchema.parse({ data }))
  })

  app.put(`${API_VERSION_PREFIX}/me/tools`, async (c) => {
    const body = await parseBody(c, PutToolSettingsRequestSchema)
    const userId = c.get('user').id
    // A write merges per tool: a tool the body names replaces that tool's whole setting, and
    // every other tool keeps what is stored, so flipping one switch never clears another. The
    // stored value is still written whole, which is the store's contract.
    const current = await deps.store.getToolSettings(userId)
    const merged: UserToolSettings = { builtin: { ...current.builtin, ...body.builtin } }
    const stored = await deps.store.putToolSettings(userId, merged)
    // No mode was named, so the answer is the caller's own settings — the same computation the
    // `GET` makes, which is what keeps the two verbs answering one shape.
    return c.json(
      ListToolSettingsResponseSchema.parse({
        data: toolSettingEntries(settings.tools, stored, null),
      }),
    )
  })
}

import type { McpServer, ModeToolOverride, UserId } from '@openharness/protocol'

import type { McpServerService } from './service'

/**
 * Which of a user's remote MCP servers are in force for one request (epic #303, X10; #311).
 *
 * A user's servers are on or off **per server**: `McpServer.enabled` is the user's own default
 * — the choice the settings screen writes — and a **mode** may override it, exactly as a mode
 * overrides which built-in tools are on (`@openharness/protocol`'s `ModeToolOverrideSchema`,
 * `mcp_servers`). The two levels are the epic's decision X6: per-user settings are the
 * defaults, a mode patches them, and a chat that follows a mode follows it live — the next
 * request resolves the mode as it is now.
 *
 * The resolution, in one line: **a mode that names a server wins; a server it does not name
 * follows the user's `enabled`.**
 *
 * Three properties are deliberate, and each is what a caller may rely on:
 *
 * - **Server granularity, never per MCP tool, never a permission.** A mode says whether a whole
 *   server is in play. Which of its tools a request offers, and under which permission, is the
 *   server's own listing and the user's settings (#312) — a mode has no say in either.
 * - **A mode naming a server the user no longer has is ignored**, not an error: the mode routes
 *   store the map by id without checking it, so deleting a server leaves the modes that named
 *   it untroubled — they simply stop matching anything. The same is true of an id that never
 *   named a server at all.
 * - **A server that is `enabled` is in force whatever its `status`** is. A connection that is
 *   down is a failure to report when the loop tries it (#312), not a reason to drop the server
 *   here — the user said the server is on, and the mode said nothing.
 *
 * This module deliberately does **not** list an MCP server's tools or call one: that is #312.
 * It answers the servers, and a caller that wants one's URL and auth headers resolves it with
 * `McpServerService.resolve`, the seam this one is built beside.
 */

/**
 * The servers in force, given the user's own list and the mode's override.
 *
 * Pure, so the rule can be read and tested without a store: the order is the input's (the
 * store lists a user's servers oldest first), and a server the mode names is on or off exactly
 * as the mode says.
 */
export function mcpServersInForce(
  servers: readonly McpServer[],
  override: ModeToolOverride | null,
): McpServer[] {
  return servers.filter((server) => override?.mcp_servers?.[server.id] ?? server.enabled)
}

/**
 * What the resolution needs: the MCP servers a user has.
 *
 * A one-method seam rather than the whole service, so a caller — and a test — supplies exactly
 * what the read uses, the way `ToolSettingsDeps` narrows the store to three methods.
 */
export interface McpServerSettingsDeps {
  /** The user's own MCP servers, oldest first. */
  readonly mcpServers: Pick<McpServerService, 'list'>
}

/**
 * The MCP servers in force for a request: the owner's servers with the mode's override applied
 * (epic #303, X10; #311). The function the tool loop (#312) is handed.
 *
 * `override` is the tool override of the mode the request resolved to — `Mode.tools`, which is
 * also what carries the built-in half — or `null` for a chat that follows no mode, or one whose
 * mode says nothing about tools. It is an argument rather than something this module looks up,
 * because the mode a chat follows is resolved by the host once per request (`modes.ts`), and
 * the built-in and MCP halves must come from that one answer rather than from two lookups that
 * could disagree.
 *
 * The read is one `list` per request — the same price the tool-settings resolver pays — which
 * is what makes a server switched off, or a mode edited, apply from the next request on.
 */
export async function listMcpServersInForce(
  deps: McpServerSettingsDeps,
  ownerId: UserId,
  override: ModeToolOverride | null,
): Promise<McpServer[]> {
  return mcpServersInForce(await deps.mcpServers.list(ownerId), override)
}

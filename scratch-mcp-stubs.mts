/**
 * Scratch: the loopback MCP and OAuth stubs the hands-on pass needs (deleted before committing).
 *
 * Three MCP servers, so the settings screen has something real to show in each state:
 *
 * - `notes` — open (`auth: none`), listing two tools with descriptions, so a check succeeds and
 *   the screen has tools to price;
 * - `wiki` — requires a bearer token, so a `headers` server with the right one connects and a
 *   wrong one lands in `error` with the server's own refusal;
 * - `flaky` — every `initialize` fails, so the save-time check stores it in `error`;
 *
 * plus an OAuth pair (`oauth` — a server advertising a stub authorization server), so Connect,
 * the authorization page and the callback can be driven by hand.
 */
import {
  startStubAuthorizationServer,
  startStubMcpServer,
} from './apps/server/src/test-support/mcp.ts'

const open = await startStubMcpServer()
const secured = await startStubMcpServer({ requiredToken: 'stub-token' })
const broken = await startStubMcpServer({ failing: true })
const authorization = await startStubAuthorizationServer()
const oauth = await startStubMcpServer({ authorizationServer: authorization.issuer })

console.log(
  JSON.stringify(
    {
      open: open.url,
      secured: secured.url,
      broken: broken.url,
      oauth: oauth.url,
      authorization: authorization.issuer,
    },
    null,
    2,
  ),
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all([open.close(), secured.close(), broken.close(), oauth.close(), authorization.close()]).then(
      () => process.exit(0),
    )
  })
}

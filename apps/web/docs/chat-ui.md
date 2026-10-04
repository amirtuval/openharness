# The web chat UI

Why the app is shaped the way it is. `AGENTS.md` has the tour and the commands; this is the
reasoning behind the parts that were choices rather than facts.

## The client is the only state

Everything the chat shows comes from `@openharness/client`:

- `createTranscript()` folds events into the messages, the status, the last error and the
  `seq` to resume from;
- `sessions.events.iterate` loads the log, `sessions.events.stream` follows it live;
- `sendMessage` and `interrupt` are the only two writes.

There is deliberately no second store: no message cache, no "optimistic" layer, no
per-session state in a context. The app is a renderer for one transcript plus two questions —
"which session?" (the route) and "which models can these keys use?" (the catalog, loaded once
in the shell — #91, below).

`useSession(client, sessionId)` is the whole of that. It is also why a reload works: the log
is the state, so opening a session after a reload is the same code path as opening it the
first time.

Two details worth knowing when reading it:

- **The stream starts from `lastSeq`.** History is folded first, then the stream is opened
  with `afterSeq: transcript.getState().lastSeq`. That is the difference between "no gaps and
  no duplicates" and "usually fine": a stream opened without `afterSeq` is live-only, and one
  opened with `0` replays everything and relies on the reducer to drop it again.
- **A sent message is folded in twice, on purpose.** `sendMessage` returns the stored event,
  which the hook applies immediately, so the message appears as soon as the request answers;
  the stream delivers the same event a moment later and the transcript's `seq` rule drops it.
  Waiting for the stream would leave a visible gap between pressing Enter and seeing your own
  message.

## The title that arrives without a reload (#35)

A session has no title at creation, and the server derives one from the first `user.message`
inside the request that stores it (`apps/server/src/titles.ts`, PR #32). That request answers
with the stored events, the stream carries log events, and there is no `session.updated` — so
nothing tells a client which already loaded the session that it has just been named. The chat
header and the sidebar row kept showing the agent's name until something reloaded the page.

`src/lib/session-refresh.ts` is the fix, and it is deliberately one mechanism rather than two
refetches:

- the store is keyed by client and shared (`sessionRefresh(client)`), so `useSessions` (the
  shell's list) and `useSession` (the open chat) read the same copy of the same session;
- **`useSession` decides when**: once the transcript holds a `user.message` and the session it
  has still shows no title, it asks for one re-read. That covers both the local case — the
  message this tab just sent, whose title the POST had already written — and a first message
  that arrived from another writer over the stream;
- **the store decides whether**: one read in flight at a time, an answered read marks the
  session done (so nothing polls, and a session the server declined to name is not read
  again), and a failed read is not a banner — the row simply keeps the name it had;
- **both surfaces merge the result**: the sidebar maps its list through the fresh copies
  (`withFreshSessions`, which returns the same array when there is nothing new), and the
  header prefers the fresh session over the one its mount fetch found.

This is not a second store in the sense the section above warns about: nothing about the
conversation lives here — no messages, no status, no optimistic layer — just the freshest copy
of a resource the server owns, read once for everyone who needs it. A `session.updated` stream
event would do the same job from the server's side and was considered and rejected for v1 (it
means a protocol addition); the day that lands, this module is what goes.

## Chat components: written here, on shadcn/ui

The issue suggested AI Elements or assistant-ui. Both were looked at, and neither fits as
well as a small set of components over this state:

| option                     | what it would cost                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI Elements `message`      | `ai` (the AI SDK) for `UIMessage`/`FileUIPart` types, `streamdown` (+ `marked`, `rehype-raw`, `rehype-harden`, `unified`, ...) for rendering, `button-group`, `tooltip`  |
| AI Elements `prompt-input` | `ai`, `nanoid`, and `command`, `dropdown-menu`, `hover-card`, `input-group`, `select` — for a composer whose state (attachments, model selectors) this app does not have |
| assistant-ui               | its own message model (`ThreadMessageLike` with parts) and its own streaming flags, i.e. a second copy of what the transcript reducer already does                       |

So the chat is `src/components/chat/`: `MessageList`, `MessageItem`, `Markdown`, `Composer`,
`StatusIndicator`, `ErrorBanner` — presentational, driven by `useSession`. What they use from
the registry is the boring, well-tested part: Button, Textarea, Input, Label, Card, Badge.

The things the app _did_ take from that world: Tailwind v4 with shadcn's design tokens, the
shadcn component sources, and the interaction model (a stick-to-bottom list, deltas rendered
as they arrive, Stop next to Send).

### Markdown

`react-markdown` + `remark-gfm`, with the elements styled by hand in `markdown.tsx` instead
of pulling in a typography plugin. No `rehype-raw`: a message cannot inject HTML, so no
sanitizer is needed.

## Model-first New chat, and why agents are hidden (#91)

The maintainer decision behind epic #92: **chatting must not require an agent**. New chat is
one screen with one question — which model? — and the answer comes from the account's own
keys, not from a hardcoded list. The old `MODEL_SUGGESTIONS` (five ids, blind to which
providers the user had keys for) is deleted; the only model list the app offers is the one
`GET /v1/models` answers, plus the picker's free-text escape hatch, because the router accepts
`provider/model` ids the catalog may not know.

**One catalog for the shell.** `useModels(client)` lives in `AppFrame`, not in the screen, and
that is the whole sharing story: the picker offers the entries, and the sidebar rows and the
chat header label untitled sessions with the same entries' display names. One `GET /v1/models`
per app load — the server caches it for an hour per user and provider — and a `refresh: true`
call when the reader asks, which replaces the list in place so every surface updates at once.

**The picker is the app's own listbox, not a `<select>`.** #87 was exactly this: a native
popup ignores the theme and came up unreadable in dark mode. `ModelPicker` renders with the
shadcn popover tokens (`bg-popover`, themed in both schemes) and follows the combobox pattern:
the search field keeps focus; `aria-activedescendant` names the active option; ArrowUp/Down,
Home/End, Enter and Escape do what they should, with Escape returning focus to the trigger.
Every row carries the display name, the `provider/model` id, and the context window when the
catalog has one (`formatContextWindow`: `200000` → "200K context"). Rows are grouped by
provider in the server's order, and "Other model ID…" is always the last one: it swaps the
panel for a `provider/model` text field instead of closing over a selection.

**The states the issue names are states, not afterthoughts:**

- only providers with keys — structural: the server lists models for exactly the providers
  the caller has credentials for (C5), so the picker's groups _are_ those providers; there is
  no client-side provider table left to disagree with it;
- a `fallback` provider (the provider call failed or timed out and the registry stood in, C3)
  shows "from the built-in list; the provider couldn't be reached" under its group header,
  with the server's `message` as the `title`;
- refresh's 429 (once a minute per user, C4) is not an error state: `refresh()` answers with
  `{ ok: false, kind: 'rate_limit' }`, the screen shows the server's sentence inline
  (`role="status"`) and the list that is already on screen stays exactly as it was;
- no keys at all → an empty state that links to Settings → Model providers, and no Create
  button to press;
- the last model a chat was created with is the next New chat's default
  (`lib/last-model.ts`, `localStorage`, `try`/`catch`-guarded like the settings store); with
  nothing remembered, the catalog's first entry stands in.

**Labels.** `sessionLabel(session, nameOf)` is the title, else the catalog's display name for
`session.model.id`, else the id itself. It used to fall back to the agent's name — for
agent-created sessions it still doesn't, on purpose (the issue says the label is the model);
the header shows the model's id under the label so the model is always visible on a chat.

**Agents: deleted from the UI, kept in the API.** The screen, the form, `useAgents`, the
`#/agents` route and their tests are gone rather than hidden behind a flag — unreachable code
rots, and the API still has agents as optional presets. The compatibility requirement is about
_sessions_: one created from an agent still opens and works, because `Session.agent` is
nullable (#93) and nothing in the chat renders it.

## Auto-scroll

`use-stick-to-bottom.ts` is ~40 lines and does exactly one thing: while the reader is at (or
within 48px of) the bottom, new content scrolls into view; the moment they scroll up, nothing
moves, and a "Jump to latest" button appears. It watches `messages.length` and the length of
the streaming reply, and scrolls in a layout effect so a delta never paints at the old
position.

A library (`use-stick-to-bottom`, which AI Elements uses) would also work; the rule is small
enough to own, and owning it keeps the dependency list short.

## Settings and the server URL

`localStorage`, key `openharness:settings`, two fields. The store in `src/lib/settings.ts` is
framework-free and hands React a stable snapshot (`useSyncExternalStore` compares by
identity) — it re-reads only when the stored string changes, which is also how another tab's
save is noticed.

- **Empty URL means same origin.** The client is built with `baseUrl: ''`, so requests go to
  `/v1/...` on the page's own origin. That is what the dev proxy answers and what a static
  build served next to the API needs.
- **Saving takes effect at once.** The app root builds the client from the settings in a
  `useMemo` keyed by them, so a save rebuilds the client — no reload, and the next request
  goes to the new server.
- A storage that throws (private mode, a sandboxed frame) is tolerated: the app runs with the
  defaults, and a value saved in memory still applies for the tab.

## Fake mode

The server does not exist yet, so the app can run entirely on
`@openharness/client/testing`:

```bash
VITE_OPENHARNESS_FAKE=1 yarn dev
```

`createDevFakeClient()` (`src/lib/dev-fake-client.ts`) checks
`import.meta.env.DEV && import.meta.env.VITE_OPENHARNESS_FAKE === '1'`, dynamically imports
the fake, and seeds a scenario: a second agent, a session with a finished turn in its log, and
two scripted replies. After the scripts run out the fake answers `Fake reply: <your message>`.

Keeping it out of a production build is structural, not hopeful:

- `import.meta.env.DEV` is replaced with `false`, so the branch is statically dead and its
  dynamic import is dropped — `dist/` has no `testing` chunk (check `ls dist/assets`);
- the condition is written inline in `createDevFakeClient`, not behind a helper, because a
  call boundary would stop the bundler from proving the branch dead.

The fake is exposed as `window.__openharnessFake` in fake mode, which is the quickest way to
poke at a scenario while clicking through the UI (`__openharnessFake.history()`).

## The dev proxy

`vite.config.ts` proxies `/v1` to `http://localhost:3000`, overridable with
`OPENHARNESS_PROXY_TARGET`. Same-origin requests mean no CORS, and no server URL in the
settings during development.

`vite.config.ts` is a plain object config, not a function, because `vitest.config.ts` merges
it (`mergeConfig(viteConfig, ...)`) and that only accepts an object. The one Node global it
needs — `process.env` — is declared locally, because this app's `tsconfig.json` is the
browser program (`types: []`, no `@types/node`) and `vite.config.ts` is checked by it.

## Testing

Vitest (jsdom) + Testing Library, against `createFakeClient()`. No server, no HTTP mocking,
no `useChat`-style plumbing to emulate: the fake _is_ the server, and the tests click and type
the way a person does.

Practical notes for whoever adds the next test:

- **The fake is fast.** With the default pace a reply can finish before the first assertion
  runs, so a test that wants to see a reply _while it streams_ creates the fake with
  `delayMs` and scripts enough `chunks` to have a window.
- **Query the way a user does.** `getByRole`/`getByLabelText`; where the sidebar and the
  content both show a name, scope with `within(...)`.
- **A message's `textContent` is not the message.** A streaming reply carries a screen-reader
  note; `visibleText()` in `src/test-support/render-app.tsx` strips it.
- **`data-role`, `data-streaming`, `data-pending`** on each message article are the
  transcript's state made visible — that is how a test asks "is this reply still arriving?"
  without reaching into React.
- **The fake does not name sessions.** The server derives a title from the first message
  (PR #32) and the fake predates that, so a test about titles calls
  `deriveSessionTitles(fake)` (`src/test-support/render-app.tsx`), which plays the server's
  half: after a message is stored, `sessions.get` answers with the session named by it.

## Bundle

`yarn build` emits one JS chunk (~187 kB gzip at the time of writing) plus ~6 kB of CSS.
Nothing unexpected is in it: React and React DOM (about a third), the markdown stack, `zod`
(via the client's response parsing), the Better Auth browser client, `tailwind-merge`, and the
app. The fake client and the AI SDK are not: the first is dev-only by construction, the second
was never added.

There is no size budget to check against — the numbers above are a note, so a jump is noticed
in review, not a gate. Better Auth is the one dependency that was added for something other
than rendering (epic #65, A1): its client is what signs a browser in, and it costs about
20 kB gzip. The fake stays out of the build the same way it always did (a dev-only dynamic
import); nothing about the auth work changed that.

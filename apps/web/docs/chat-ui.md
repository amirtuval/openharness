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
"which session?" (the route) and "which agents exist?" (a list).

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

## Bundle

`yarn build` emits one JS chunk (~167 kB gzip at the time of writing) plus ~6 kB of CSS.
Nothing unexpected is in it: React and React DOM (about a third), the markdown stack, `zod`
(via the client's response parsing), `tailwind-merge`, and the app. The fake client and the
AI SDK are not: the first is dev-only by construction, the second was never added.

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
header and the sidebar row kept showing the session's model name until something reloaded the
page.

`src/lib/session-refresh.ts` is the fix, and it is deliberately one mechanism rather than two
refetches:

- the store is keyed by client and shared (`sessionRefresh(client)`), so `useSessions` (the
  shell's list) and `useSession` (the open chat) read the same copy of the same session;
- **`useSession` decides when**: once the transcript holds a `user.message` and the session it
  has still shows no title, it asks for one re-read. That covers both the local case — the
  message this tab just sent, whose title the POST had already written — and a first message
  that arrived from another writer over the stream. One case is not the chat's to notice at
  all: a message sent from **New chat** (#113) names the session before the chat opens, so its
  header's mount read already has the title and the sidebar row does not; the New-chat screen
  asks the store for that one re-read itself, on the send that stored the message;
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
sanitizer is needed. Links open in a new tab with `rel="noreferrer"`; a table is a grid inside
its own `overflow-x-auto` box, so a wide one scrolls instead of squashing the message it is in.

## Streaming markdown, and the code blocks (#204, epic #201)

`streamdown` was evaluated for this and **not** taken, and the two reasons are worth writing
down because they will come up again.

The first is the rule above: `streamdown` is built on `rehype-raw` — its whole approach is to
parse the document, find the incomplete node at the end and render it specially — and this app
deliberately does not let a message's bytes become HTML. Taking it would mean either dropping
that rule or sanitizing (`rehype-harden`) what it produces, i.e. adding a second parser and a
sanitizer to keep a property we already have for free.

The second is that it brings a second markdown stack: `marked` and its own rendering path
beside `react-markdown`'s, plus `unified` and its plugins, for a job that turns out to be
CommonMark's already.

**A half-written document is not a special case.** An unterminated fence is closed by the end
of its input, so a fence being streamed is a code block from its first line on — the reader
watches the block form rather than watching a stray ``` and a paragraph of code that turns
into a block later. A half-written `**bold` or `[link](dest` is the characters that have
arrived, which is what the next delta is about to complete. Nothing is hidden, nothing is
mangled, and no second pass over the text is needed to find "the incomplete part". The one
place GFM has an opinion is a half-written link with a URL in it: `[the docs](https://exa`
leaves the marker as text and autolinks the address, because that is what the text says.
`src/components/chat/markdown.test.tsx` pins all of it, directly and through a real stream.

**Code blocks** are `components/chat/code-block.tsx`: the language in a header, a **Copy**
button (`navigator.clipboard`, and "Copied" for 1.5s), and Shiki's tokens. To `react-markdown`
a fence and an indented block are the same two elements — a `code` inside a `pre` — and only
the `language-…` class tells them apart, so both go through the same component. A fence with
no language is a block with a header and a Copy button, labelled `text`, just uncoloured; an
indented block is exactly the same, which is the first time it has looked like a code block
rather than like a `<pre>` with an inline-code pill in it.

**Highlighting is lazy, on demand, and per grammar.** `src/lib/highlight.ts` is imported with a
dynamic `import()` by the component; inside it, Shiki's core, the three themes and the wasm
engine are separate chunks, and each grammar is a chunk of its own, fetched the first time a
fence asks for it. The main bundle grows by the code block component alone (1.3 kB gzip), and a
chat with no code in it never fetches any of the rest. A language nothing claims — or a grammar
that refuses the text — answers `null`, and the block is plain text: still labelled, still
copyable, never an error state.

**The table is Shiki's, not ours (#227).** The list was fourteen hand-picked grammars, so a
`rust` fence — or `cpp`, `swift`, `dockerfile`, `protobuf` — rendered plain. It is now
`bundledLanguages` from `shiki/langs`: every grammar Shiki ships, _keyed by its aliases too_
(`rs`, `c++`, `cs`, `kt`, `rb`, `py`, `sh`, `zsh`, `yml`, `tf`, `dockerfile`, …), plus the two
the app adds because Shiki has no answer for them (`golang`, `patch`). What makes that
affordable is what the module actually is: a map of `() => import('…')` thunks, about 30 kB
gzip of _metadata_, whose every value is still a separate chunk. Reading the table costs a
look-up; loading from it is what it always was. So the property the fourteen existed for is
intact — a chat fetches exactly the grammars it draws — while the main bundle does not move
at all, because `highlight.ts` was already behind a dynamic import.

`createOnigurumaEngine` is the engine, and the wasm behind it is the largest thing here
(232 kB gzip, cached, only for the first code block). It is the engine TextMate grammars are
written for; Shiki's JavaScript engine supports only a subset of them, which is a correctness
trade this app does not need to make. The wasm is inlined by `shiki/wasm`; fetching it as a
file instead would save the base64 overhead if it ever needs saving.

**Themes without re-highlighting.** `defaultColor: false` makes Shiki write all three palettes
as CSS variables (`--shiki-light`, `--shiki-dim`, `--shiki-dark` and the `-bg` pair) instead
of painting the first theme into the element's `style`. Three rules in `index.css` then pick
the one `[data-theme]` names — Light uses `github-light`, Dim `github-dark-dimmed` and Dark
`github-dark` — so a theme switch repaints code with the rest of the page and no token is
recomputed. Nothing is inline, so no rule needs `!important`; a block with no variables (not
highlighted yet, or not highlighted at all) falls back to the design tokens through `var()`
defaults, and looks like an ordinary muted panel.

Using each theme's own background rather than the app's is deliberate: Dim's background is a
soft gray, and `github-dark-dimmed`'s token colours are chosen for its own darker one — the
body text of a Dim code block measures 7:1 there against 3.9:1 on Dim's own gray, below AA.
Where the app's own surface is wanted instead, the fallback is what it gets.

**Streaming does not re-highlight what is finished.** `react-markdown` re-renders the whole
document on every delta, so the `components` object is a module-level constant (a new one per
render would be a new element type, and React would remount the message's subtree instead of
patching it) and `CodeBlock` is `memo`'d on `(code, language)`. A finished block gets the same
two strings back on the next delta and is not re-rendered, so only the block the reply is
still writing is ever re-tokenized. The highlight of the text on screen a moment ago is
dropped the instant it stops being the text on screen: a block renders plain until its own
tokens arrive, rather than under a delta's worth of stale colours.

## Model-first chat, and why agents are hidden (#91, #113)

The maintainer decision behind epic #92: **chatting must not require an agent**. The model
comes from the account's own keys, not from a hardcoded list that can go stale against them.
The only model list the app offers is the one `GET /v1/models` answers, plus the picker's
free-text escape hatch, because the router accepts `provider/model` ids the catalog may not
know yet (C5). Since epic #116 the list is offered where a model is actually chosen — in the
composer, mid-chat, and in Settings as the default — rather than on a picker screen in front
of New chat; that change and its rules are below.

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
  `{ ok: false, kind: 'rate_limit' }`, the picker shows the server's sentence inline
  (`role="status"`) and the list that is already on screen stays exactly as it was;
- no credentials at all → the root route is the **first-run screen** (epic #201, X5): tiles,
  a key form, the default model the server picked, "Let's go". Once a key exists but the
  catalog is still empty, New chat shows the "Add a provider key to start" state that links to
  Settings → Providers, and there is nothing to type into;
- keys but no default (#146) → the composer is there with the picker, nothing selected, and
  the send is refused until a pick ("Pick a model to start", with a link to Settings); a
  one-model catalog is preselected, because there is no choice in it. A catalog that is
  still loading, or that failed, is shown as that — never as a claim about keys.

## New chat is immediate, the model is switched from the composer (#113)

The maintainer decision behind epic #116: chatting should be immediate — **New chat opens an
empty chat on your default model, with no dialog in the way**. The picker screen of #91 is
gone; the picker itself became the app's one model control, in two sizes.

**The default is server state** (`GET /v1/me/preferences` → `{ default_model }`), shared with
`oh` (U1). New chat shows it in the composer's selector, and the session is created with the
**first message** (`sessions.create({ model })`, then `sendMessage`) instead of by a Create
button (U2); after that the app moves to the chat, where the reply streams like any other. The
server picks the default itself when the first provider key is saved (U4) — Settings → Default
model shows that value because it is a read of the same stored field the picker writes, not a
local choice. A failed create keeps the reader's text in the box; a failure _after_ a create
keeps the session and retries into it.

**Keys without a default are the clients' to handle** (#146). The server picks a default only
at the moment a key is saved: it never backfills one on read, and deleting the provider behind
a default the reader chose **clears** it on purpose even when other keys remain. So `#/new`
with no default asks the catalog what can still run — models mean the composer with the picker
(nothing selected, the send refused until a pick, a sole model preselected), still loading
means a loading line, failed means its error banner, and only no providers and no models means
"Add a provider key to start". `oh` already opened its picker over the same catalog in this
state; now the web app does too.

**The session is named by the first message** (#35), which this flow stores before the chat
opens — so the header's mount read already sees the title, while the sidebar row (added by the
create, before the name existed) does not. That is why `NewChatScreen` asks
`lib/session-refresh` for the session's one re-read itself on a successful send: the store is
keyed by client, so the row the list holds and the header update together, still without a
second walk of the list.

**Switching mid-chat applies from the next message** (U3). The composer's selector shows the
session's current model — the transcript's `model`, the id the log last said, else the model
the session was created with — and a pick is held locally until a send carries it
(`sendMessage(text, { model })`). The server moves `sessions.model` in the same transaction as
the append, the transcript marks that message with `modelChangedTo`, and the UI draws the
subtle "Switched to <name>" marker above it. After the message is stored, the selector drops
the local pick and reads the log again: what is shown is always the log's answer. Switching
the provider works the same way, because the history is rebuilt per request server-side. A
message naming the model already in effect is not a change (no marker); neither is the first
model a message carries — the state starts at `null`, so there is nothing it changed from.

**Deleting a chat is irreversible, so the UI asks first, in the page** (U5). The sidebar row's
kebab menu (shown on hover or focus, always in the tab order) and the chat header both offer
Delete chat; both swap to an inline "Delete this chat?" with Delete/Cancel — no
`window.confirm`, which would block the page and cannot be themed or tested like the rest.
Deleting the open chat lands on New chat. A chat deleted **elsewhere** tells this tab through
the stream's final `session.deleted`: the chat raises the shell's one-line notice
(`lib/notice.ts` — it has to outlive the screen it was raised on), the sidebar forgets the row
without a call of its own, and the app leaves for New chat.

**Labels.** `sessionLabel(session, nameOf)` is the title, else the catalog's display name for
`session.model.id`, else the id itself. The agent's name is never used — not even for a
session created from an agent, on purpose (the issue says the label is the model); the header
shows the model's id under the label so the model is always visible on a chat.

**Agents: deleted from the UI, kept in the API.** The screen, the form, `useAgents`, the
`#/agents` route and their tests are gone rather than hidden behind a flag — unreachable code
rots, and the API still has agents as optional presets. The compatibility requirement is about
_sessions_: one created from an agent still opens and works, because `Session.agent` is
nullable (#93) and nothing in the chat renders it.

## The visual pass, and the working state (#211, epic #201 U10)

Everything above was built to work. This is the pass that made it look finished, and the
reasoning behind the choices that were choices.

### Tokens, not classes

The app had a scale in practice — `gap-2` here, `px-3.5 py-2.5` there, `text-[0.65rem]` in
three components — and no scale in writing. `src/index.css` now names one, and the two halves
of it are deliberately different:

- **Type, spacing and radii are one set for the whole app.** They are `@theme inline` entries
  (`--text-2xs`, `--spacing-inline`/`-control`/`-block`/`-section`, `--radius-2xl`), which
  Tailwind turns into utilities — `text-2xs`, `gap-block`, `rounded-2xl`. The spacing ones are
  **aliases of Tailwind's own numbers** rather than new sizes: 6px is still 6px, and
  `gap-inline` exists so a component can say what the distance is _for_. A scale nobody reads
  is a scale nobody keeps.
- **Elevation is not**, and that is the point. `--elevation-raised`, `-popover` and `-panel`
  are defined **in each of the four theme blocks**, because a shadow is a relationship between
  a surface and what is behind it: on Light a soft 6% black reads, on Dark it is invisible, and
  Dim is somewhere between. One shadow for all four would have been a shadow that works in one
  of them. `--shadow-*` maps the three names for utilities (`shadow-popover` on every menu).

The type scale keeps Tailwind's steps for `text-sm` and up: re-declaring them would have
changed every line height in the app for a naming exercise. `text-2xs` (11px) is the one step
Tailwind does not ship, and it is what the metadata lines — a model id, a timestamp, a badge —
are drawn in. `text-[0.65rem]` is gone.

### Motion

`prefers-reduced-motion: reduce` collapses every animation to a single frame with one global
rule in `@layer base`. It has to be global: an `animate-pulse` on the header's status dot or a
spinner three levels inside the composer cannot be reached by a variant on the component that
happens to use it, and the list of things that pulse will keep growing. Nothing here is
_revealed_ by an animation (no `animate-in` enters from nowhere), so collapsing them loses no
information — which is also why the dialog and menu sources dropped the registry's
`animate-in`/`animate-out` classes back in #209.

### The sidebar

Four changes, each with a reason:

- **Date headings** (`lib/session-groups.ts`). One flat column of chats with "3d ago" under
  each is readable at six and useless at sixty. Today / Yesterday / Previous 7 days / Older is
  the shape people already know, and it needs no state: the server pages the list newest-first
  by `created_at`, which is the field its cursor is built from, so the buckets are contiguous
  slices of what arrived — nothing is sorted here. The buckets are **local calendar days**
  (the date parts, compared through `Date.UTC` of the local y/m/d, so a 23- or 25-hour
  daylight-saving day is still one day): something said at 23:50 is under Yesterday at 00:10,
  where "20m ago" would have been a worse answer. A timestamp the app cannot read is **Older**
  rather than dropped — the sidebar is the only way to an older chat — and one in the future is
  Today rather than a fifth bucket nobody named. Empty buckets are omitted: a heading over
  nothing reads as a bug.
- **A marked open chat.** `aria-current="page"` is the accessible half and a bar at the row's
  leading edge is the visible one. The tint alone was neither: it is a background shift between
  two similar grays, and it says nothing at all to a reader who cannot see it.
- **A real menu** (`components/ui/dropdown-menu.tsx`, Radix). The row's kebab was a local
  `role="menu"` with a document-level pointerdown listener; Radix brings the arrow keys, the
  roving tabindex, type-ahead, Escape, focus returned to the trigger, and a **portal** — the
  list scrolls, and a menu drawn inside it would be clipped by it. The one visible consequence
  in the tests: menu content is in `document.body`, so a test queries it with `screen`, not
  `within(row)`.
- **One account menu.** The foot used to hold three controls that were all "things I can do as
  me": a Settings link, the theme button, and a Sign out button, next to an email. They are one
  menu now, behind a trigger labelled **"Account menu"** — labelled for the account rather than
  the email, because the email changes with the account and a test (or a QA pass) should not
  have to know it to open the menu. The theme is a **submenu** (a radio group, `theme-menu.tsx`
  is the items now), which keeps one menu in that corner instead of five rows of a different
  subject.

**Rename** is deliberately not there. The epic asks for it later, and the sessions API has no
rename: a disabled row would be a promise the backend cannot keep, and dead UI rots.

### Collapsible on the desktop

The drawer is how a phone reaches the list; the collapse is how a wide screen gives the chat
the whole width. They are separate, and they do not interact: the collapse is `md:hidden` and
nothing else, so a window that had the column put away and then narrowed to a phone still gets
its drawer. The state is the shell's (`AppFrame`) rather than a stored preference — it is a
thing about this window more than about the reader, and the drawer has always been state too.
The way back is a "Show sidebar" bar at the top of the content column, `hidden md:flex`, so it
exists exactly where the collapse does; on a phone it is the existing top bar's button.

### Loading, empty and error

`components/ui/skeleton.tsx` is the one placeholder, used three times: the sidebar's rows
(four of them, each a title line and a metadata line), the transcript's history (three bubbles,
alternating alignment, because a conversation is what is arriving), and the two reads New chat
waits on (preferences, then the catalog). A skeleton may carry a `label`, which becomes
`role="status"` plus screen-reader text — **one label per group**, so a reader hears
"Loading your chats" once rather than once per bar. That label is also what the tests read,
which is how "still loading" stopped being prose in four different places.

**The empty state on New chat** is a greeting (`NEW_CHAT_GREETING`, "Hey! What are we building
today?" since #227), the model the chat would run on, and four openers from
`lib/suggestions.ts`. Two decisions in it:

- **An opener fills the composer and stops.** Nothing is created, nothing is sent, the text is
  editable. A first visit is not a commitment, and a suggestion that auto-sent would be the
  app deciding what the reader meant.
- **They are about kinds of work, not about this app.** The catalog is whatever the reader's
  own keys list: a prompt naming a model, a provider or a file would be wrong for most
  accounts. (The four are generic on purpose, and the first is the one worth showing alone if
  only one fits.)

The composer's text became a **prop** (`value`/`onValueChange`, both optional) for exactly
this: the screen that wants to put words in the box owns the box's text. The alternative —
reaching into the `<textarea>` and dispatching an input event — fights React for control of a
controlled input. Omitted, the composer is unchanged, which is why `composer.test.tsx` did not
move.

### The working row, and where "the reader stopped it" comes from

While a turn is running and **nothing has arrived yet**, a row at the foot of the transcript
says so, with a clock. The header's `StatusIndicator` stays exactly as it was: the row is the
same fact placed where the answer is going to appear, and the dot is still the thing that is
visible when the reader has scrolled up.

Three states, and one of them is not in the log:

    working      the turn is running and the newest message is either the user's or an empty
                 agent one — "no text has arrived" is a question about the transcript, not
                 about the clock, so a reply visibly being written gets no row
    retrying     the same, but the last error says `retrying` — "Retrying… (the server's
                 reason)", the reason clipped rather than allowed to push the clock off the row
    interrupted  STOP. Nothing in the event log distinguishes "the reader stopped this" from
                 "the turn ended on its own" — the log says the turn ended — so `ChatView`
                 remembers the one action that could only have come from here, and drops it on
                 the next send. It belongs to the turn it stopped.

The clock starts when the row appears and is dropped when it goes, so a turn that moves from
working to retrying **keeps counting**: the reader waited through both. It is a live region so
"Working…" is announced once, and the ticking number is `aria-hidden` — a clock that announced
itself every second would be unusable, and the words are what matter.

The rule is a pure function, `workingState(input)`, tested as one (`working-row.test.tsx`); the
component's half is the clock, under fake timers. Splitting them is what makes "which row, for
which session state" an assertion instead of a render.

### The composer

- **It grows, up to 200px, then scrolls.** The height is measured and set by hand rather than
  left to `field-sizing-content`, which only recent Chromium implements — and the cap is what
  keeps a pasted stack trace from pushing the conversation off the screen.
- **It is one surface.** The border, the focus ring and the shadow belong to the whole form
  (`focus-within:`), so the model control reads as part of the composer rather than as a
  control that happens to be near it, and the ring appears when focus is anywhere inside —
  textarea, model button, Stop or Send. The `Textarea`'s own border and ring are switched off
  inside it, so there is one focus indicator on screen and not two.
- **Stop carries the word.** Stop-and-Send used to be two unlabelled icons whose difference
  was a colour. It is still Send _and_ Stop while running — a message sent mid-turn is a
  steering message — but the destructive one now says "Stop".

### Accessibility

- **Landmarks**: `<aside aria-label="Navigation">` (the sidebar), `<nav aria-label="Chats">`
  (the list), `role="log"` (the transcript, which scrolls), `<main>` (the content column).
- **Names**: every icon-only control has an `aria-label`; the two the sidebar gained (collapse,
  row actions) also carry a `Tooltip`, as a _description_ — never as the name, because a name
  that only exists on hover is a name a keyboard user does not have.
- **Focus**: visible on everything (the shadcn primitives' rings, the composer's
  `focus-within` ring). Radix hands focus back to the trigger when a menu closes, which is the
  bug the hand-rolled menu had to be careful about and this one cannot have.
- **Contrast**: the colours are #203's palettes unchanged. Everything new is built from token
  pairs those palettes already carried (`bg-muted` skeletons, `text-muted-foreground` metadata,
  `bg-foreground`/`text-background` tooltips), so no new pair was introduced and none of the
  measured ratios moved. The one pre-existing exception is still Dark's
  `--destructive-foreground` on `--destructive` at 2.8:1, unchanged by #203 and by this.

## Auto-scroll

`use-stick-to-bottom.ts` is ~40 lines and does exactly one thing: while the reader is at (or
within 48px of) the bottom, new content scrolls into view; the moment they scroll up, nothing
moves, and a "Jump to latest" button appears. It watches `messages.length` and the length of
the streaming reply, and scrolls in a layout effect so a delta never paints at the old
position.

A library (`use-stick-to-bottom`, which AI Elements uses) would also work; the rule is small
enough to own, and owning it keeps the dependency list short.

## Themes (epic #201 X3, #203)

Four choices — **System** (the default), **Light**, **Dim**, **Dark** — and one attribute:
`data-theme` on `<html>`. `src/index.css` holds one block of CSS variables per theme, and
`@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *, [data-theme='dim'],
[data-theme='dim'] *))` is what keeps the shadcn components' handful of `dark:` utilities
meaning "dark chrome" — true in Dim as much as in Dark.

**`system` is resolved in JavaScript, not in a media query.** The store
(`src/lib/theme.ts`) reads `matchMedia('(prefers-color-scheme: dark)')`, writes the concrete
`light`/`dark` it implies, and re-writes it when the operating system fires `change`. That
keeps one source of truth — the attribute — instead of two that can disagree, and it is why
there is no `@media (prefers-color-scheme: dark)` block in the stylesheet any more. Where
`matchMedia` does not exist (jsdom, and anything that is not a browser) the answer is "not
dark", which is what `:root` renders anyway.

**No flash.** The account's theme lives on the server, and a request is far too late to paint
the first frame with. So the app also caches the _choice_ in `localStorage`
(`openharness:theme`), and a small inline script in `index.html` reads it and sets the
attribute in the head, before anything renders. The script is the one place that repeats the
store's resolution rule — it is deliberately five lines, with no imports, and a comment
pointing at `resolveTheme()`.

**The server value wins, once it answers.** `src/components/theme-preference.tsx` is the only
thing that talks to the API about the theme: one `GET /v1/me/preferences` on mount, and a
`PUT` for every choice after it. It is mounted with the shell and renders nothing, which is
what lets the two pickers — Settings → Appearance (`components/settings/appearance.tsx`, a
native radio group) and the sidebar's quick switch (`components/theme-menu.tsx`, a menu beside
the user's email) — call the same `chooseTheme()` and be saved by the same code. A preference
write merges, so the theme and the default model never clear each other.

The stored value is adopted unless the choice moved after the read left: a click that has not
been saved yet is the reader's last word, and only the component that made the request knows
whether it has been overtaken. If the `PUT` is refused, the previous choice is put back and
the shell's notice says so.

**Dim** is the soft palette: a violet-leaning dark background (`#1E1B2E`) against Dark's deep
one (`#12101B`), with lower-contrast text that is still above the WCAG AA floor — the numbers
are in the stylesheet's comment, and every pair is measured against the block it lives in. In
Dark, `--destructive-foreground` on `--destructive` measures 2.8:1, below AA: it is
pre-existing, and #203 does not change it.

All three palettes were retuned to violet + coral in #227 — see below.

## The palette: violet + coral (#227)

The maintainer's hands-on test said the onboarding and the themes worked and the app had no
personality. #227 is the pass that gave it one. Three things about how it is built are
decisions rather than colours:

**Everything is a token in the three theme blocks.** No component carries a hex. There are two
brand colours and each needs more than one value, which is the whole subtlety:

| token                       | Light       | Dim / Dark   | what it is for                                       |
| --------------------------- | ----------- | ------------ | ---------------------------------------------------- |
| `--primary`                 | `#7C3AED`   | `#7C3AED`    | the violet _fill_: Send, the active row, a selection |
| `--primary-foreground`      | white       | white        | text on that fill — 5.7:1 in all three themes        |
| `--link`, `--ring`          | `#7C3AED`   | `#A78BFA`    | the violet as _type_ and as a focus ring             |
| `--coral`                   | `#FB7185`   | `#FB7185`    | the hello-colour _mark_: caret, spinner, dot, tint   |
| `--coral-ink`               | `#BE123C`   | `#FB7185`    | the coral as _type_                                  |
| `--hero-from` / `--hero-to` | violet/rose | violet/coral | the two ends of the heading gradient                 |

A fill and a piece of type are not the same problem, and that is why `--link` exists: white on
`#7C3AED` is 5.7:1 and violet _text_ on Light's page is 5.3:1 — but on a violet-black page the
same violet is 2.9:1, under AA for anything but large type. So the primary stays the vivid
violet where it is a surface and lifts to `#A78BFA` where it is a word. Light happens to need
no separation, so `--link` is the primary there; the dark themes are where the token earns its
keep. The coral has the same split for the same reason, the other way round: `#FB7185` is
legible on both dark pages and not on a light one, so Light's `--coral-ink` is the deep rose.

**The gradient is a rule, not a utility.** `[data-slot='hero-title']` in `index.css` carries
`background-image: linear-gradient(… var(--hero-from), var(--hero-to))` with
`background-clip: text`. Two reasons it is not `bg-gradient-to-r` on the element: each end has
to be a _per-theme_ token to stay legible as type, and Tailwind's `bg-clip-text` on a heading
whose text fails to resolve would be an invisible heading rather than an unstyled one. The ✨ on
the first-run heading is deliberately outside the clipped span — `background-clip: text` paints
the gradient where a colour-emoji glyph's own colours would have been.

**The gray is gone everywhere, not just on the two components the issue named.** The page, the
sidebar, the borders, the muted text, the user's own bubble (`--secondary`) and the code
block's _fallback_ panel all carry the tint now. The one surface deliberately left alone is the
highlighted code block: Shiki's three palettes (`github-light`, `github-dark-dimmed`,
`github-dark`) are measured against their own backgrounds, and a violet-tinted one under
GitHub's token colours would only move the contrast the wrong way. Nothing in the app's own
palette is read inside a highlighted block.

Every pair is at WCAG AA and the ratios are in the stylesheet comments — body text 15.6:1
(Light) / 14.0:1 (Dim) / 16.8:1 (Dark), muted text 6.5 / 7.8 / 7.7, white on the primary
5.7 / 5.7 / 5.7, the coral as type 5.8 / 6.2 / 7.0.

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

The app can run entirely on `@openharness/client/testing`, with no server:

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

`yarn build` emits one JS chunk plus ~7 kB of CSS, and — since #204 — a set of chunks that are
only ever fetched when a reply contains code. The numbers below are `vite build` output, to
the kilobyte of gzip at the time of writing:

| chunk                      | raw     | gzip     | when it is fetched                              |
| -------------------------- | ------- | -------- | ----------------------------------------------- |
| `index-*.js` (the app)     | 637 kB  | 195.2 kB | first paint                                     |
| `index-*.css`              | 36.0 kB | 6.9 kB   | first paint                                     |
| `highlight-*.js`           | 94.7 kB | 30.6 kB  | the first code block on screen                  |
| `wasm-*.js` (oniguruma)    | 622 kB  | 232.1 kB | the first code block on screen                  |
| `github-light/dimmed/dark` | 37.2 kB | 8.2 kB   | with the highlighter                            |
| the 14 grammars            | 1077 kB | 128.1 kB | one per language the first time a fence uses it |

This change moved the app's own chunk from 632.35 kB to 636.99 kB (193.47 → 195.23 kB gzip) and
the CSS from 35.32 to 35.97 kB (6.83 → 6.92 kB gzip) — **1.8 kB gzip on the first paint**, which
is the code block component and nothing else. Everything else is below the fold: `dist/` went
from 670 kB to 2.51 MB of assets, and a reader who never sees a code block downloads none of it.

Nothing unexpected is in the main chunk: React and React DOM (about a third), the markdown
stack, `zod` (via the client's response parsing), the Better Auth browser client,
`tailwind-merge`, and the app. The fake client, the AI SDK and now Shiki are not in it: the
first two were never in it, the third is a dynamic import.

There is no size budget to check against — the numbers above are a note, so a jump is noticed
in review, not a gate. Better Auth is the one dependency that was added for something other
than rendering (epic #65, A1): its client is what signs a browser in, and it costs about
20 kB gzip. The fake stays out of the build the same way it always did (a dev-only dynamic
import); nothing about the auth work changed that.

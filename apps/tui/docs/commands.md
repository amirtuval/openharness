# Slash commands, the menu, and the inline prompt slot

`oh`'s chat has slash commands, a menu that completes them, and one mechanism — the **inline
prompt slot** — for anything that has to take the input area over for a while. This is how
they fit together (issue #207). The commands themselves are in `src/chat/commands.ts`, the
menu is `src/components/command-menu.tsx`, and the slot is `src/components/prompt-slot.tsx`.

## The registry

A command is a plain value:

```ts
export interface ChatCommand {
  readonly name: string // without the slash: 'model'
  readonly aliases?: readonly string[] // 'quit' for /exit
  readonly description: string // the one line the menu and /help show
  readonly args?: string // an argument hint for the usage column, e.g. '<mode>'
  readonly skill?: SlashCommand // set on a row that stands for one of the reader's skills
  readonly run?: (context: CommandContext, args: string) => void | Promise<void>
}
```

`run` is absent on a **skill row** (#349, K7): a skill is not an action the client runs, it is
an ordinary message carrying `skill`, which the screen sends (see "What a line is"). The rows
themselves come from `@openharness/client`'s `slashCommands(skills)` — the same list the web app
draws — through `menuCommands`.

`CHAT_COMMANDS` holds them in the order the menu lists them. Adding a command is adding one
entry: the menu, the completion, `/help` and `oh --help` all read the registry, so none of
them has to be told about it.

What a command may do to the world is `CommandContext`: the session, the model picker (which
runs through the slot), starting a new chat, clearing the screen, leaving, and putting a line
above the status bar (`showNotice`). Nothing else — the screen builds the context, so a
command that wants a new power has to grow the context, where it can be seen.

| command                   | what it does                                                            |
| ------------------------- | ----------------------------------------------------------------------- |
| `/model`                  | pick a model; the choice rides the next message (epic #116 U3)          |
| `/providers [provider]`   | connect a model provider — paste its key into a hidden input (#210, X7) |
| `/new`                    | start a new chat on the current model                                   |
| `/compact [instructions]` | summarize the older history now, with optional guidance (#283)          |
| `/mcp`                    | your remote MCP servers, in the prompt slot (#303 X10; #313)            |
| `/tools`                  | which tools may run, and whether each asks first (#303 X4; #335)        |
| `/skills`                 | your imported skills: list, switch, remove, import (#349; #354)         |
| `/clear`                  | clear the screen; the session stays (the same wipe as Ctrl+L)           |
| `/help`                   | print the commands and the keys above the prompt                        |
| `/exit`                   | leave the chat (`/quit` is the same command)                            |

## What a line is

`parseChatInput` reads what the prompt submitted, and the screen does one of three things
with the answer:

| what was typed  | what happens                                                                |
| --------------- | --------------------------------------------------------------------------- |
| `//anything`    | sent to the model as `/anything` — the escape hatch for a literal slash     |
| `/name args`    | `/name` runs, with `args` (everything after the name, trimmed)              |
| `/skill args`   | sent as a message carrying `skill` — the reader's own skill (#349, K7)      |
| `/name` unknown | "Unknown command", with the closest match, shown above the prompt; not sent |
| anything else   | sent to the model, verbatim                                                 |

The name ends at the first whitespace, so `/model` must start the line and a trailing newline
or space is still `/model`. A line with a leading space is a **message**: the menu's rule is
the same (it opens on a buffer that starts with `/`, at column 0), which is what keeps what
the menu offers and what submitting does from disagreeing.

The closest match is the smallest edit distance, ties going to the registry's order — the
order the menu lists them in, so the suggestion is the higher of two equally close ones. The
registry is five short words; a name there is nothing near still gets the nearest, which beats
getting nothing.

## The menu

Typing `/` on an empty buffer opens the filtered list under the prompt. It stays up while the
command word is being typed, and closes when it is over — at the first space (the arguments
have started), or as soon as the word _is_ a command (`/model` needs no list under it).

| key   | what it does                                                                |
| ----- | --------------------------------------------------------------------------- |
| ↑/↓   | highlight a row — **not** the history or the buffer's lines, while it is up |
| Tab   | put the highlighted command in the buffer, cursor at its end                |
| Enter | run the highlighted command (which is why `/ne` + Enter is `/new`)          |
| Esc   | close the menu and keep the text                                            |

Enter runs the _highlighted_ command rather than the half-typed name: `/mo` is not a command,
and the list on screen is what is being chosen from. With the menu closed — Esc, or a line
that has gone past the name — Enter runs the buffer as it stands, which is what makes the
unknown-command message reachable.

The rows are one `<Text>` each, the highlighted one in `cyan` (an ANSI named colour, per
decision X4 — the TUI never names a hex one); the usage column is padded to the widest label
in the **whole** registry, so the descriptions do not jump sideways as the filter narrows.

**The reader's skills are rows in the same list** (#349, K7; #354). `menuCommands(skills)` puts
`CHAT_COMMANDS` first and then one row per skill the client's `slashCommands` offers — which is
to say **on** (K8) and **user-invocable**, with its `argument-hint` as the row's usage. The
screen reads the skills once in the background and re-reads them when `/skills` closes, because
a skill switched off stops being a command. A skill row completes and filters like any other,
and a near miss of a skill name is suggested by name.

## The inline prompt slot

The input area is usually the prompt. Some things are not a prompt — a list to pick from, a
secret to type, a question to answer — and the slot is the one mechanism through which they
take it over:

```tsx
const slot = usePromptSlot()

const answer = await slot.request<string | null>((settle) => (
  <ModelPicker models={models} onSelect={settle} onCancel={() => settle(null)} />
))
if (answer !== null) session.setModel(answer)
```

`request` renders the element in the prompt's place and returns a promise that settles when
the flow calls `settle`. While a flow is up:

- the prompt is **not rendered**, so it is not reading keys either: the flow owns Ctrl+C,
  Enter and the arrows, and the screen's own Ctrl+C/Ctrl+L handler stands down (`element !==
null`);
- nothing else can start a flow — there is no prompt left to type `/model` into — so one flow
  at a time is a property of the layout, not a lock. A second `request` would replace the
  first, whose promise then never settles: there is no honest value to settle a question
  nobody answered with.

A flow may take as many steps as it likes and settle once, at the end. The slot knows nothing
about steps: the model picker reads the catalog first (with `loading models…` of its own, and
a catalog that will not load settles `null` with the error already reported) and a multi-step
key entry would do the same.

`/providers` (#210, X7) is the second flow, and it is what the last paragraph is about: one
element that picks a provider from the list, asks for its key through `SecretInput` — a hidden
input with **its own buffer**, never `PromptInput`'s, which is why nothing typed into it is
echoed and why it is never handed to the history — saves it with
`client.providerCredentials.put`, and settles once, with the provider id. A rejected key is
shown in the server's words and the same view asks again; a stale session settles through the
screen's sign-in path. All of that is steps inside one view, so the slot did not change.

That is what makes the next pieces fit the same way:

- **a `question` part** (phase 5) — a view that renders the choices or a text field and
  settles with the answer;
- **an `approval`** — a view that renders allow-once / allow-always / deny and settles with
  which one, so the caller decides what to send.

After a `/providers` save the screen reads the catalog again, so `/model` offers the models the
provider just connected, and the default the server picked is named in a notice.

## Manual compaction (#283)

`/compact [instructions]` asks the brain to summarize the session's older history now, with the
rest of the line as the reader's guidance for the summary ("keep the API decisions in detail").
It is not a message and takes no prompt slot: the command calls `client.sessions.compact`, which
stores a `session.compact` request and wakes the session — the brain answers at its next request
boundary if a turn is running, and in a turn of its own if the chat is idle, and the answer is a
`session.compaction` event. The runtime shows that outcome as a notice above the status line
(`Compacted: the older history is a summary now.`, `There was no older history to summarize.`, or
the failure), because the transcript draws no bubble for a compaction — everything a reader needs
to be told lives in the notice. The event pair and the outcome field are the server's (epic #277
K8); this command is the terminal's way in.

## Tests

| file                                     | covers                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/chat/commands.test.ts`              | the registry, the parse, the filter, the closest match, each command                               |
| `src/components/command-menu.test.tsx`   | the rows, the highlight, the aligned usage column                                                  |
| `src/components/prompt-input.test.tsx`   | the menu's keys, filtering, and its precedence over the history                                    |
| `src/components/prompt-slot.test.tsx`    | an element in the prompt's place, settling, and a replaced flow                                    |
| `src/components/provider-setup.test.tsx` | the `/providers` flow itself: the list, the key entry, a save, a rejection (#210)                  |
| `src/app.test.tsx`                       | each command end to end, the unknown command, `//`, the picker, and `/providers` (#210)            |
| `src/commands/skills.test.ts`            | `oh skills`' words and flows: the listing, the preview, the pick's payload, refresh, remove (#354) |
| `src/components/skill-import.test.tsx`   | the import pick: marks, selection keys, what Enter hands back (#354)                               |
| `src/components/skill-refresh.test.tsx`  | the refresh confirm: the summary, the file lines, `y`/`n`, and the problems case (#354)            |

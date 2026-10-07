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
  readonly run: (context: CommandContext, args: string) => void | Promise<void>
}
```

`CHAT_COMMANDS` holds them in the order the menu lists them. Adding a command is adding one
entry: the menu, the completion, `/help` and `oh --help` all read the registry, so none of
them has to be told about it.

What a command may do to the world is `CommandContext`: the session, the model picker (which
runs through the slot), starting a new chat, clearing the screen, leaving, and putting a line
above the status bar (`showNotice`). Nothing else — the screen builds the context, so a
command that wants a new power has to grow the context, where it can be seen.

| command                 | what it does                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `/model`                | pick a model; the choice rides the next message (epic #116 U3)          |
| `/providers [provider]` | connect a model provider — paste its key into a hidden input (#210, X7) |
| `/new`                  | start a new chat on the current model                                   |
| `/clear`                | clear the screen; the session stays (the same wipe as Ctrl+L)           |
| `/help`                 | print the commands and the keys above the prompt                        |
| `/exit`                 | leave the chat (`/quit` is the same command)                            |

## What a line is

`parseChatInput` reads what the prompt submitted, and the screen does one of three things
with the answer:

| what was typed  | what happens                                                                |
| --------------- | --------------------------------------------------------------------------- |
| `//anything`    | sent to the model as `/anything` — the escape hatch for a literal slash     |
| `/name args`    | `/name` runs, with `args` (everything after the name, trimmed)              |
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

## Tests

| file                                     | covers                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/chat/commands.test.ts`              | the registry, the parse, the filter, the closest match, each command                    |
| `src/components/command-menu.test.tsx`   | the rows, the highlight, the aligned usage column                                       |
| `src/components/prompt-input.test.tsx`   | the menu's keys, filtering, and its precedence over the history                         |
| `src/components/prompt-slot.test.tsx`    | an element in the prompt's place, settling, and a replaced flow                         |
| `src/components/provider-setup.test.tsx` | the `/providers` flow itself: the list, the key entry, a save, a rejection (#210)       |
| `src/app.test.tsx`                       | each command end to end, the unknown command, `//`, the picker, and `/providers` (#210) |

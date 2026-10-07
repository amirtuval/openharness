# The prompt: keys, history and paste

`src/components/prompt-input.tsx` is the box `oh` reads a message in. It is a small editor
rather than a text field, and this is what it does — issue #206.

## Keys

| key                        | what it does                                                 |
| -------------------------- | ------------------------------------------------------------ |
| Enter                      | send — also while a reply streams, which is what steering is |
| Ctrl+J, Alt+Enter          | insert a newline                                             |
| ←/→                        | move the cursor                                              |
| Home/End, Ctrl+A/Ctrl+E    | the start and the end of the line                            |
| Backspace / Delete         | delete behind the cursor, and at it                          |
| Ctrl+U / Ctrl+K            | delete to the start of the line, and to its end              |
| Ctrl+W, Alt+Backspace      | delete the word before the cursor                            |
| Alt+B/Alt+F, Ctrl+←/Ctrl+→ | jump a word back and forward                                 |
| ↑/↓                        | the buffer's own lines first, then the history               |
| Ctrl+L                     | clear the screen — the session stays                         |
| Ctrl+C                     | interrupt the running turn; when idle, press twice to leave  |

"Shift+Enter" is not a key a terminal can send: most terminals send the same `\r` for Enter
and Shift+Enter, so the newline is bound to **Ctrl+J** (line feed, `0x0A`, against Enter's
carriage return, `0x0D`), which every terminal can send and none confuses with Enter, and to
**Alt+Enter** (`ESC` + `\r`) for muscle memory.

The editing keys are readline's, so muscle memory from a shell carries over. `Home`/`End`
and `Ctrl+A`/`Ctrl+E` stop at the ends of the **line**, not of the buffer, which is what makes
them useful in a multi-line draft; `Ctrl+U`/`Ctrl+K` follow them, deleting to the line's start
and its end. `Ctrl+W` and `Alt+Backspace` are the same thing under two names (Ink reports the
second as backspace with the meta flag), as are `Alt+B`/`Ctrl+←` and `Alt+F`/`Ctrl+→`.

The cursor is drawn as an **inverse-video cell** — on its own cell at the end of a line, so it
is visible in an empty buffer too. Where it is drawn, and on which line, is what `promptLines`
answers, which is how the tests can see it: Ink drops styling when the output is not a
terminal, so a test's frame has no inverse video in it.

## History

↑ walks back through what has been sent, newest first, and ↓ walks forward again. The draft is
kept while browsing and put back when ↓ passes the newest entry. On a **multi-line** buffer, ↑
and ↓ move between the lines first and only leave the buffer at its first or last line — a
recalled multi-line message can be read and edited line by line.

The entries live in `~/.config/openharness/history.json` (or `$XDG_CONFIG_HOME/…`), beside
`config.json` and `credentials.json`, one list per **server and user**:

```json
{ "servers": { "https://app.oharness.dev": { "user_123": ["first prompt", "second"] } } }
```

- **Per server**: `--server` points the CLI at another machine, and its prompts are not this
  one's.
- **Per user**: two accounts on one server sign in with different tokens but share this
  machine, so the user id from `client.me()` is the second half of the key. A server that will
  not name the caller — a `me()` that failed — gets no history rather than a failed chat.
- The file is written atomically with mode `0600` in a `0700` directory, the way the
  credentials file is (both go through `src/atomic-write.ts`).
- The list is capped at `HISTORY_LIMIT` (500) entries, oldest dropped first, and a line that
  repeats the one before it is not stored twice.
- `add(text, { record: false })` is the explicit **don't record** (#206): the hidden input that
  asks for an API key in the terminal (#207, X7) goes through the same call, and a secret never
  reaches the file.
- Unlike the config and credentials files, a history file that cannot be read is **not** an
  error. What it holds is a convenience for the next keystroke; losing a chat over a mangled
  cache of old prompts would be the wrong trade. A failed read starts empty, and the next write
  replaces the file.

History is not per session: ↑ offers what this user sent to this server, whichever chat it was.

## Paste

A paste is one **bracketed-paste** event: Ink's `usePaste` turns bracketed paste mode on for as
long as the prompt is mounted, so the terminal delivers the text as one string and Ink keeps it
off the keyboard channel entirely. Nothing pasted can therefore be read as a keypress — which
is the point, because a pasted line ending must not send the message. The `\r` (or `\r\n`) a
terminal puts in the pasted text is normalized to the buffer's own `\n`.

A paste longer than `LARGE_PASTE_CHARS` (2000) is **shown collapsed**: the buffer keeps every
character — it is what gets sent — and the screen shows a `[pasted N lines]` label in its
place, so pasting a file cannot push the prompt and the streaming reply off the screen. The
label is one thing to the editing keys: a deletion that reaches into it takes the whole paste.

## Tests

`src/components/prompt-input.test.tsx` drives every binding through the rendered prompt, and
`src/history.test.ts` covers the store on disk. The keystrokes are `src/test-support/input.ts`'s
`pressKey` (named keys, including the control characters and the `ESC`-prefixed meta ones) and
`paste` (one bracketed-paste write); `typeText` types one character at a time, because a chunk
with several characters in it is a paste and takes a different path.

# Learnings

Non-obvious things about this repo's runtime — the terminal, Ink, the browser, Postgres — that
cost somebody an afternoon and would cost the next person the same one. One entry per learning,
in this shape:

```md
## <a sentence naming the thing>

**Symptom** what was seen.

**Why** the mechanism, in two or three sentences.

**What to do** the rule that follows, or where to look.

**Seen in** the file or issue it came from.
```

Entries are about behaviour that is surprising from the outside, not about how a module works —
that is the package's `AGENTS.md`. Anything that only matters to one file belongs in that file's
TSDoc.

## A settled `<Static>` block cannot be redrawn, so a toggle cannot reach the scrollback

**Symptom** A "show me the whole thing" key — Ctrl+O in `oh` (#308), which opens a tool call's
full input and result — expands the calls that are still moving and changes nothing at all for
the calls above them, however many times it is pressed.

**Why** Ink's `<Static>` writes its items once and never rewrites them: it renders
`items.slice(index)`, where `index` is the length it last saw. That is the property a chat
client needs — a streamed reply must not repaint the scrollback on every delta (#208, X2) — and
it is also a one-way door. The terminal has already printed those characters; there is no
buffer to go back to.

**What to do** Treat the scrollback as write-once in any feature design: a value that changes
over time (a status, a fold, a detail level) has to be drawn in the **live area** to be able to
change, and a control that only affects what has already settled will look broken. Say so in the
UI or the docs rather than pretending otherwise — `components/tool-call.tsx`'s TSDoc and
`apps/tui/AGENTS.md` both spell out Ctrl+O's one-way half.

**Seen in** `apps/tui/src/components/transcript-view.tsx`, `apps/tui/src/components/tool-call.tsx`.

## The same reason rules out a second column beside the transcript

**Symptom** "I expected the todos to be permanent on the bottom **or on the right** or
something." The bottom is achievable; the right is not.

**Why** The scrollback is a single full-width stream of already-printed lines (previous entry).
A panel in a column beside it would have to be part of the live frame, so every delta would
redraw it — and it would narrow the transcript to the remaining columns, re-wrapping settled
lines that a terminal cannot unprint. Ink lays the frame out over the whole width it is given;
there is no region that is "static on the left, live on the right".

**What to do** Pin things to the bottom of the live area, and let the fold/window rules
(`components/todo-panel.tsx`) keep them within the terminal's height. The web app's slide-over
has a region a browser can scroll; a terminal does not.

**Seen in** `apps/tui/src/components/todo-panel.tsx`, `apps/tui/AGENTS.md` ("The tools, in the
transcript").

## Ctrl+O as a key name is not what a terminal sends

**Symptom** A key that tests drive as `\u000F` and a real terminal is said to send as "Ctrl+O"
look nothing alike in a terminal's own documentation — and `oh` already had to spell Ctrl+J out
for the same reason.

**Why** Ink reads raw bytes and reports `key.ctrl` plus the letter's code point, so a control
key is `letter.charCodeAt(0) - 96`; `Ctrl+O` is `0x0F` (15), `Ctrl+T` is `0x14` (20). The
"Ctrl+letter" spelling is a keyboard's, not a protocol's — and a terminal that binds `Ctrl+O`
itself (some multiplexers do) never sends it at all.

**What to do** Add the byte to `src/test-support/input.ts`'s key table beside the others, and
pick control keys that the prompt and the screen do not already own: the prompt reads
Ctrl+A/E/U/K/W, the screen owns Ctrl+C/L/R, and Ctrl+T/Ctrl+O are free (#308).

**Seen in** `apps/tui/src/test-support/input.ts`, `apps/tui/src/chat/screen.tsx`.

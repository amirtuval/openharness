# Markdown, code and colour in the transcript

`src/markdown/` is how an agent's reply becomes lines on a terminal, and this is what it
does — issue #205, epic #201, decisions X1, X2 and X4.

## What is rendered, and what is not

An **agent** message is Markdown: its `text` part goes through `parseMarkdown` (the `remark`
family, `remark-gfm`, the same grammar the web app renders with) and back out as lines. A
**user** message is not: it is drawn exactly as it was typed, its own newlines and its own
indentation, because `#` in a prompt is a hash and a prompt pasted out of an editor has the
indentation it had there. Both get the same layout — label, hanging indent, wrapping.

| Markdown       | on the terminal                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ |
| headings       | bold, in blue; `#` and `##` also underlined                                                |
| emphasis       | italic; strong: bold; strikethrough: struck through                                        |
| inline code    | magenta                                                                                    |
| lists          | `• ` bullets and `1. ` numbers; nested lists indented under their parent; task boxes `[x]` |
| block quotes   | a `▏ ` bar down the left, the whole quote dimmed                                           |
| links          | the text (blue, underlined) and the URL after it, dimmed — and once, when the text _is_ it |
| images         | the alt text, italic, and the URL                                                          |
| tables         | box-drawn (GFM), with the header row bold and the delimiter row's alignment                |
| thematic break | a `─` rule across the width                                                                |
| fenced code    | a labelled frame, syntax-highlighted                                                       |
| raw HTML       | the tags, as text, dimmed — there is no `rehype-raw` on either client                      |

A **soft break** — a newline in the source that is not a hard one — is a space, which is what
CommonMark says and what a model that wraps its prose means. Two spaces or a `\` at the end of
a line is a hard break and ends the line. Both are tested; the first one matters because
model replies wrap.

An **unterminated fence is a code block**. `remark` closes it at the end of the text, so a
reply that is still streaming renders as a code block in progress rather than as broken
prose or nothing — and it re-renders on every delta, which is what makes the streaming reply
readable while it arrives.

## Layout

`MessageView` owns the layout: the `you › ` / `agent › ` label, the indent under it, the
`▌` cursor while a reply streams, the `(queued)` note. Everything a part renderer produces is
fitted to the width left over after the label, and the view puts the label (or that many
spaces) in front of every line — so **a wrapped line stays under the text it belongs to**.
Nothing is left to the terminal's own wrapping: the terminal would put a continuation line at
column 1, under the label.

The width comes from the terminal, read when the message is drawn. That is what makes X2's
"a resize does not reflow old output" fall out of the component tree rather than out of
special-casing: settled messages go through Ink's `<Static>`, which never re-renders what it
has already written, so they keep the width they were drawn at. The message being streamed is
in the live area, and it re-wraps.

Messages are separated by one blank line (`transcript-view.tsx`), and the separator is part of
the _next_ message's output rather than a thing of its own: a reply arrives as one `<Static>`
write, and a separator of its own would be written twice — once while the next message was
live, and again when it settled.

Wrapping is ANSI-free and column-accurate (`src/markdown/text.ts`): spans carry plain text and
a style, so measuring one is `string-width` over its text, and a double-width character that
would straddle the edge of a line moves to the next one whole.

## Colour

Every colour the transcript draws is an **ANSI named colour** — one of the sixteen the
terminal's own theme defines — so `oh` wears the terminal's colours and not its own (X4). The
names are in `PALETTE` in `src/markdown/theme.ts`: `cyan` for a user's message and `green`
for an agent's label, `blue` for headings and links, `magenta` for inline code, and `gray`
(bright black) for everything structural — rules, table borders, quote bars, code frames, a
link's URL.

The **code theme** is the exception, and has to be: sixteen terminal colours are not a syntax
theme. `SYNTAX` carries a light and a dark palette (the familiar GitHub pairing), and the one
used is chosen by the terminal's background.

### Which background

`theme` in the config file is `auto` (the default), `light` or `dark`:

```json
{ "server": "https://app.oharness.dev", "autoUpdate": true, "theme": "auto" }
```

`auto` reads `COLORFGBG`, which the terminal sets to `<foreground>;<background>` as palette
indexes — VTE, iTerm2, Konsole and xterm all write it — and takes `7` and `9`-`15` as a light
background, everything else (and anything unreadable) as dark. `light` and `dark` say so
outright, for a terminal that reports nothing or reports it wrongly.

An **OSC 11 query** ("what colour is your background?") would be the more accurate half of
that, and it is deliberately not used: it means writing an escape sequence and reading stdin
**before** Ink takes the terminal over, which can swallow a keystroke, leaves stray bytes in a
transcript when the terminal does not answer, and delays the first frame by exactly the
timeout it waits — the three things X4 rules out. One detection that never costs anything and
one config key that always works beat one that costs sometimes and works often.

### NO_COLOR

`NO_COLOR` — present and not empty, per no-color.org — turns every colour off, the syntax
palette included, and changes nothing else: the same lines, the same layout, the same
Markdown, the same frames. Colour is not content. Bold, italic, underline and dim are _not_
colour and are kept, so a heading still reads as a heading and a quote still reads as a quote.

## Code blocks

Framed, with the language in the top rule, and the frame drawn in the terminal's own
"structure" colour rather than the syntax theme's:

```text
┌ ts ───────────────────────────────────────────────────────────────────
│ export function markdownLines(text: string, layout: RenderLayout) {
│   return renderBlocks(parseMarkdown(text).children, layout)
│ }
└───────────────────────────────────────────────────────────────────────
```

Lines longer than the frame are **broken at the frame's edge**, not word-wrapped: the line
breaks a language has are not the breaks a reader wants.

Highlighting is `highlight.js` — `src/markdown/highlight.ts` has the argument for it against
Shiki and `cli-highlight`, and the list of languages that ship. A fence with no language, or
one that is not registered, is shown as plain code: guessing from the content mis-colours more
than it gets right on a snippet. A language that throws while highlighting half a streamed
block falls back to plain text — a colouring problem is never a chat that stops.

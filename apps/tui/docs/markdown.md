# Markdown, code and colour in the transcript

`src/markdown/` is how an agent's reply becomes lines on a terminal, and this is what it
does — issue #205, epic #201, decisions X1, X2 and X4, and issues #229 and #231.

## What is rendered, and what is not

An **agent** message is Markdown: its `text` part goes through `parseMarkdown` (the `remark`
family, `remark-gfm`, the same grammar the web app renders with) and back out as lines. A
**user** message is not: it is drawn exactly as it was typed, its own newlines and its own
indentation, because `#` in a prompt is a hash and a prompt pasted out of an editor has the
indentation it had there. Both get the same layout — column 0, wrapping, and for the user's
message a band; see [Layout](#layout).

| Markdown       | on the terminal                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| headings       | bold, in blue; `#` and `##` also underlined                                                                                                  |
| emphasis       | italic; strong: bold; strikethrough: struck through                                                                                          |
| inline code    | magenta                                                                                                                                      |
| lists          | `• ` bullets and `1. ` numbers; nested lists indented under their parent; task boxes `[x]`                                                   |
| block quotes   | a `▏ ` bar down the left, the whole quote dimmed                                                                                             |
| links          | the text (blue, underlined) and the URL after it, dimmed — and once, when the text _is_ it                                                   |
| images         | the alt text, italic, and the URL                                                                                                            |
| tables         | box-drawn (GFM), with the header row bold and the delimiter row's alignment                                                                  |
| thematic break | a `─` rule across the width                                                                                                                  |
| fenced code    | a tinted full-width panel: a padding line with the language at its right edge, the code verbatim at column 0, a padding line under it (#231) |
| raw HTML       | the tags, as text, dimmed — there is no `rehype-raw` on either client                                                                        |

A **soft break** — a newline in the source that is not a hard one — is a space, which is what
CommonMark says and what a model that wraps its prose means. Two spaces or a `\` at the end of
a line is a hard break and ends the line. Both are tested; the first one matters because
model replies wrap.

An **unterminated fence is a code block**. `remark` closes it at the end of the text, so a
reply that is still streaming renders as a code block in progress rather than as broken
prose or nothing — and it re-renders on every delta, which is what makes the streaming reply
readable while it arrives.

## Layout

**Everything starts at column 0** (issue #229). `MessageView` owns the layout — the wrapping,
the `▌` cursor while a reply streams, the `(queued)` note — and it no longer draws a
`you › ` / `agent › ` label with a hanging indent under it. The label was a character in front
of every line, so selecting a reply and pasting it pasted the label too; there is none now, and
nothing else is in front of a line either.

What tells the two apart instead is a **band**: every line of a user's message carries a
background, padded out to the terminal's edge, so it reads as a block. The blanks a band needs
above and below it are the message's own (`transcript-view.tsx` draws no separator around one),
for the reason the separator has always belonged to a message: a message settles into
`<Static>` as a single write, and a blank line rendered beside it would be written twice.

Wrapping is still **hard** — the text is broken at the terminal's width, and the newline is a
real one in the output. Ink measures and re-wraps every line it draws to `stdout.columns`
(`wrap-text.js`, `wrap-ansi { hard: true }`), `<Static>` included, so there is no way to hand
the terminal a long line and let _it_ soft-wrap: writing the settled output around Ink would
mean owning the cursor and the live area by hand, which is the ground X2 stands on. So a copied
paragraph still has a newline where the terminal wrapped it; what it no longer has is anything
in front of the words.

The last column is left empty (`CURSOR_COLUMNS` in `message-view.tsx`). The `▌` a streaming
reply ends with is a column of its own, and a line that already fills the width — a code
block's closing rule, prose wrapped to the final column — would push it onto a line of its own:
that was the streaming bug #229 reports, where the block's closing line appeared to jump. The
column is reserved on every message rather than only the streaming one, because a reply that
re-wrapped the moment it settled would jump for the same reason.

The width comes from the terminal, read when the message is drawn. That is what makes X2's
"a resize does not reflow old output" fall out of the component tree rather than out of
special-casing: settled messages go through Ink's `<Static>`, which never re-renders what it
has already written, so they keep the width they were drawn at. The message being streamed is
in the live area, and it re-wraps.

Wrapping is ANSI-free and column-accurate (`src/markdown/text.ts`): spans carry plain text and
a style, so measuring one is `string-width` over its text, and a double-width character that
would straddle the edge of a line moves to the next one whole.

## Colour

Every **foreground** colour the transcript draws is an **ANSI named colour** — one of the
sixteen the terminal's own theme defines — so `oh` wears the terminal's colours and not its own
(X4). The names are in `PALETTE` in `src/markdown/theme.ts`: `blue` for headings and links,
`magenta` for inline code, and `gray` (bright black) for everything structural — rules, table
borders, quote bars, a code block's label where there is no panel to draw, a link's URL.

**Backgrounds are the exception** (#231). The sixteen named colours have no subtle gray in
them — the nearest, _bright black_, is a heavy band — so the two surfaces the transcript draws
are **derived** from the terminal's background instead, and how they are drawn depends on how
much colour the terminal can show:

| level | detected from                    | the band / the panel                        |
| ----- | -------------------------------- | ------------------------------------------- |
| 3     | `COLORTERM=truecolor` or `24bit` | 24-bit hex                                  |
| 2     | `TERM` ending in `-256color`     | the nearest gray of the 232-255 ramp        |
| 1     | anything else                    | the named colours (`blackBright` / `white`) |
| 0     | `NO_COLOR`                       | nothing at all                              |

The **band** a user's message sits on is a shade _of_ the terminal rather than a colour beside
it: `#2a2b33` on a dark one and `#ececf2` on a light one, or `ansi256(236)` / `ansi256(254)`,
or `blackBright` / `white` where neither is available. The text on it is left at the terminal's
default foreground — the one colour guaranteed readable on both. `messageBand()` answers it.

The **panel** a code block sits on is a step _toward_ the background on a dark terminal
(`#1f2026`, `ansi256(235)`) and the lighter of the two surfaces on a light one (`#f5f5f8`,
`ansi256(255)`), so a block reads as inset in the page rather than laid on it. `codePanel()`
answers it, and answers `undefined` where there is no tint to draw with — which is the signal
`render.ts` reads to fall back to a plain label line.

The **code theme** is the other exception, and has to be: sixteen terminal colours are not a
syntax theme. `SYNTAX` carries a light and a dark palette (the familiar GitHub pairing), and
the one used is chosen by the terminal's background.

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
palette included, and changes almost nothing else: the same lines, the same layout, the same
Markdown. Colour is not content. Bold, italic, underline and dim are _not_ colour and are kept,
so a heading still reads as a heading and a quote still reads as a quote.

What it changes is the two **surfaces**, because a surface is colour. A user's message, with no
band to tell it from an agent's, carries a dim `›` on a line of its own **above** it instead —
a mark on its own line and not a prefix, because that is the difference this whole pass is
about: a selection can leave a line above out, and can never leave out a character in front of
every line. A user's message is otherwise unchanged — the same words, the same column 0, and
(in colour) the same banded rows, whose padding Ink keeps because it is styled.

And a code block loses its panel (see [Code blocks](#code-blocks)): the label moves to column 0
and the tint goes, leaving the same lines and the same code. A block that had a panel and one
that did not are otherwise the same three lines, so a reply that starts streaming in one mode
does not change shape.

## Code blocks

A full-width **tinted panel** (#231): a padding line with the language at its right edge, the
code at column 0, and a padding line under it. Nothing is drawn _in front of_ a line, so the
code is still the code — the label is decoration at the far end of the padding.

```text
                                                              ts
export function markdownLines(text: string, layout: RenderLayout) {
  return renderBlocks(parseMarkdown(text).children, layout)
}
```

Every line is padded out to the block's width with spaces that carry the tint, which is what
makes it a panel rather than a ragged highlight around its longest line. The width is the
message's own less the streaming cursor's reserved column (`CURSOR_COLUMNS`), so the `▌` still
has somewhere to land: it goes on the bottom padding line, just outside the tint, which is
where the block ends.

With **no tint to draw with** — `NO_COLOR`, or a terminal that can mix neither 24-bit nor the
256-colour ramp — the panel would have to be made of a named colour, which is the heavy band
#231 is about. The block falls back to a dim label line above (in the terminal's "structure"
colour, as it was before) and a blank line after: the same three lines, the same code at column
0, and only the surface gone.

**There is no gutter and no box** (issue #229). The frame used to open every line with a `│ `
bar, which meant the code only existed _inside_ the drawing: select it and you copied the bar
and the space with every line, and pasted a block that no longer compiles. Then it was the
`── rust ──` pair of rules above and below (#229), which copied cleanly but left the block as
unadorned text. The code lines are now the code — at column 0, exactly as they were written, so
selecting them gives them back byte for byte, plus the panel's trailing spaces at worst.

The label, the padding and the body are drawn from the same tree on every render, so a block
whose fence has not closed yet — which `remark` reads as a code block to the end of the text —
is laid out exactly like the block it becomes. Nothing appears and nothing moves when the fence
closes, and a streaming block is the panel growing a line at a time.

Lines longer than the block are **broken at its edge**, not word-wrapped: the line breaks a
language has are not the breaks a reader wants.

Highlighting is `highlight.js` — `src/markdown/highlight.ts` has the argument for it against
Shiki and `cli-highlight`, and the list of languages that ship. A fence with no language, or
one that is not registered, is shown as plain code: guessing from the content mis-colours more
than it gets right on a snippet. A language that throws while highlighting half a streamed
block falls back to plain text — a colouring problem is never a chat that stops.

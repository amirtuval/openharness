# #314 — the chat fixes, hands-on

Captures taken against a **built server** (`node apps/server/dist/index.js`, its own Postgres
database `openharness_x15` on port 5433, port 3115) serving the **built web app**, driven by
headless Chromium through Playwright (`/usr/bin/google-chrome`). Nothing here is a mock: the
screenshots are of the real bundle the server serves.

## The task list, on screen (item 2)

`todo-panel-<width>-<theme>.png` is the panel **as it opens** in that size and theme,
`…-toggled.png` the same chat after one click on the header's chevron, and `…-remembered.png`
the same chat **reloaded** with that choice still in effect — which is the per-chat
`localStorage` memory.

| capture                                          | what it shows                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `todo-panel-1440-{light,dark}.png`               | **1440px**: the list as a 280px column **beside** the transcript, open          |
| `todo-panel-1440-{light,dark}-toggled.png`       | the same, folded to "Tasks · 2 of 6 done" and the item in progress              |
| `todo-panel-1440-{light,dark}-remembered.png`    | reloaded: still folded — the choice is remembered per chat                      |
| `todo-panel-1024-{light,dark}.png`               | **1024px**: below `xl`, so the list is the **row above the composer**, folded   |
| `todo-panel-1024-{light,dark}-toggled.png`       | the same, opened — the six items, two struck through, the one in progress coral |
| `todo-panel-1024-{light,dark}-remembered.png`    | reloaded: still open                                                            |
| `todo-panel-400-{light,dark}.png`                | **400px**: the row above the composer, folded, on a phone-width page            |

The three states were read back from the DOM rather than eyeballed, one run per size and theme:
`aria-expanded` is `true` as the 1440 side panel opens and `false` after the click and after the
reload, and `false` as the 1024 and 400 rows open and `true` after their click and reload —
which is the rule the panel documents: the row above the composer starts folded once the list is
longer than five items (it takes the conversation's height) while the side panel starts open (it
does not).

The list itself was put in the log by inserting one `agent.tool_use` (`todo_write`) and its
`agent.tool_result` into the chat's event rows — the built server has no model in this sandbox
that writes a todo list, and the panel reads the log and nothing else.

## The ynet fetch, with a real model (items 3b, 3c, 3d)

`ynet-real-model-1440-{light,dark}.png` — a real chat on `openai/gpt-5-mini` (a stored
`openai` credential, the sandbox's own key), asked "Can you check the main headline in ynet?".
`web_search` (the provider-native search) is switched **off** in the reader's tool settings so
the model has to use `web_fetch`, which is the tool these fixes are about.

What the offline evidence does not show and the screenshots do: the fetch's result in the
disclosure leads with the page's main headline — `# הרצוג: "אעשה הכול כדי שלא יהיו בחירות
חוזרות"` — and the model answers with that headline, its translation, and the article's URL.
No "your message was too long" and no "a tool result was too long" notice is drawn: nothing was
cut, which is the point of the larger per-tool cap.

The model's own words (from the log, `agent.message`), the second run being the one the
screenshots are of — ynet's front page rotates, so the headline differs between them:

> The main headline on ynet right now (front page) is:
>
> הרצוג: "אעשה הכול כדי שלא יהיו בחירות חוזרות"
>
> (Translation: "Herzog: 'I will do everything so there won't be repeat elections'")
>
> It's from a special interview — full article: https://www.ynet.co.il/news/article/rkpyi3difx
>
> Would you like a short summary or translation of the article?

and, with the same question after the extraction's last fix:

> The main headline on ynet's homepage right now is (Hebrew):
>
> אוחנה: אם יהיה רוב של 61, לגיטימי שיחליפו אותי; איזנקוט? שיישאר עם חצי עין פקוחה
>
> Link: https://www.ynet.co.il/news/elections2026/article/b1mszy9igl
>
> Would you like a translation or a short summary?

The fetched Markdown the model read began `# [אוחנה: …](https://www.ynet.co.il/news/elections2026/article/b1mszy9igl)`
— the page's headline as a linked heading, which is what "the content comes first" means.

## Which notice a cut is reported by (item 3a)

The screenshots of the fix are the two `notices-…` pairs. The chat's log was given one
`span.model_request_start` whose `truncated` record names a **tool result** (exactly what the
brain writes when a fetch came back too long), and the app draws **one** notice —
"One tool result was too long for this model and was shortened." — and no "your message was too
long" line, although the message above it is four words long. `notices-both-…` is the record
naming a message *and* a result: there, both notices are owed and both are drawn.

### Not the browser this time: the fixture's own trap

Worth writing down, because it cost an hour: the first version of that fixture inserted events
with random `sevt_` ids, and the client's history read validates every event against the
protocol — so the app dropped the two fixture events, showed the call as `execution lost`, and
looked exactly like a *different* bug. The ids were regenerated as real ULIDs (a timestamp
prefix, first character ≤ `7`) and the page then drew what the unit tests said it would. A
hand-written log is only a fixture if it validates.

## The flicker, measured (item 1)

The screenshots cannot show a re-render that paints the same pixels, so the evidence for item 1
is the measurement, taken over the same built app with CDP's
`Performance.getMetrics`: `ScriptDuration` and `LayoutCount` sampled before and after **each
keystroke** in the composer of a chat with 20 messages and one with 27 (markdown and a tool call
in both), typing `hello world, this is a longer sentence to type out`.

| chat        | before (`MessageList` plain) | after (`memo` + a stable `working`) |
| ----------- | ---------------------------- | ----------------------------------- |
| 20 messages | ~4.3 ms of scripting per keystroke | ~1.8 ms                        |
| 27 messages | ~22.6 ms of scripting per keystroke | ~5.5 ms                       |

The transcript's share is flat in the number of messages after the change; what is left is the
composer's own box and its foot. The pixel diff around a keystroke (two clipped screenshots,
compared inside the browser) confirmed the transcript and the header paint identically while
typing, before and after — the cost was React re-rendering the conversation, not the DOM moving.

# #314 — the chat fixes, hands-on

Captures taken against a **built server** (`node apps/server/dist/index.js`, its own Postgres
database `openharness_x15` on port 5433, port 3115) serving the **built web app**, driven by
headless Chromium through Playwright (`/usr/bin/google-chrome`). Nothing here is a mock: the
screenshots are of the real bundle the server serves.

## The task list, on screen (item 2)

`todo-panel-<width>-<theme>.png` — the panel as it opens, and `…-folded.png` the same chat after
one click on the header's chevron. `todo-panel-1440-light-folded-after-reload.png` is the same
chat **reloaded** with the fold still in place, which is the per-chat `localStorage` memory.

| capture                                    | what it shows                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `todo-panel-1440-{light,dark}.png`         | **1440px**: the list as a 280px column **beside** the transcript, expanded        |
| `todo-panel-1440-{light,dark}-folded.png`  | the same, folded to "Tasks · 2 of 6 done" and the item in progress                |
| `todo-panel-1440-light-folded-after-reload.png` | reloaded: still folded — the state is remembered per chat                     |
| `todo-panel-1024-{light,dark}.png`         | **1024px**: below `xl`, so the list is the **row above the composer**, expanded   |
| `todo-panel-1024-{light,dark}-folded.png`  | the same, folded                                                                  |
| `todo-panel-400-{light,dark}.png`          | **400px**: the row above the composer, folded by default (six items)              |

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

The model's own words (from the log, `agent.message`):

> The main headline on ynet right now (front page) is:
>
> הרצוג: "אעשה הכול כדי שלא יהיו בחירות חוזרות"
>
> (Translation: "Herzog: 'I will do everything so there won't be repeat elections'")
>
> It's from a special interview — full article: https://www.ynet.co.il/news/article/rkpyi3difx
>
> Would you like a short summary or translation of the article?

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

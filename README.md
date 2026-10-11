# #310 assets — the X7 approval prompt and ask_user form

Screenshots and terminal captures for the PR into `tools/x5-ui-308b`. Nothing here is part of
the build; the branch exists so the PR can link images.

## web/

| file | what it shows |
| --- | --- |
| `ask-user-{light,dim,dark}-desktop.png` | the `ask_user` form: two questions, their headers, options, Other with its write-in, the text input, Submit and Decline, and the composer's "a message would decline this" notice |
| `ask-user-{light,dim,dark}-narrow.png` | the same at 400px |
| `ask-user-answered-{form,light}-desktop.png` | the answers filled in, before and after Submit: the call reads `done` and the answers are its result |
| `approval-{light,dim,dark}-desktop.png` | the approval prompt: Allow once / Allow for this chat / Always allow / Deny |
| `approval-{light,dim,dark}-narrow.png` | the same at 400px |
| `approval-allowed-light-desktop.png`, `approval-allowed-detail-light-desktop.png` | after "Allow for this chat": the call reads `done · Allowed for this chat`, and the expanded input/result |

Taken by hand against a real server (`OPENHARNESS_DEV_LOGIN=1`, in-memory store,
`OPENHARNESS_TEST_MODEL=mock`, `OPENHARNESS_WEB_DIR=apps/web/dist`) with `web_fetch`/`echo` set
to `ask` through `PUT /v1/me/tools`.

## tui/

`tmux capture-pane` of `oh` against the same server (100×30, and 60×26 for the narrow one).

| file | what it shows |
| --- | --- |
| `tui-ask-user-paused.txt` | the question list with its keys |
| `tui-ask-user-typed.txt` | an answer typed through the prompt slot's one-line entry |
| `tui-ask-user-answered.txt` | the answers submitted: the call reads `done` and the result is the answers |
| `tui-ask-user-narrow.txt` | the same list at 60 columns |
| `tui-approval-paused.txt` | the four choices, Deny with a message, and the message row |
| `tui-approval-allowed.txt` | `done · Allowed for this chat` |
| `tui-write-a-message.txt` | "write a message instead": the hint changes and the cursor is gone |
| `tui-ask-user-dismissed.txt` | a message sent from a pause: the call reads `dismissed` |

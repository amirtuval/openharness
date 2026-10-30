import { chatReferenceLines } from './chat/commands'

/**
 * The in-chat reference, indented to sit inside {@link HELP_TEXT}.
 *
 * It is the same list `/help` prints, from the same place (`chat/commands.ts`): the commands
 * the chat has and the keys it binds, so the help text and the chat cannot come to disagree
 * about either.
 */
const CHAT_REFERENCE = chatReferenceLines()
  .map((line) => `  ${line}`)
  .join('\n')

/** The `oh --help` text, and what a usage error is followed by. */
export const HELP_TEXT = `openharness — chat with an agent from the terminal

Usage:
  oh [options]                 start a new chat on your default model
  oh -s <id>                   resume a session
  oh -c                        resume the most recent session
  oh sessions                  list sessions
  oh sessions delete <id>      delete a chat and everything in it
  oh agents                    list the saved agents (optional presets)
  oh modes                     list your modes and what each resolves to
  oh providers                 list the model-provider keys you have stored
  oh providers add [provider]  connect a provider by pasting its key (hidden input)
  oh providers remove <p>      forget a provider's key (asks; --yes skips)
  oh default-model [id]        print or set the default model for new chats
  oh settings [flags]          show or set the context (compaction) settings
  oh tools [name] [flags]      show which tools your chats may use, or change one
  oh mcp                       your remote MCP servers: add, edit, connect, test them
  oh skills                    list your imported skills
  oh skills add <url> [flags]  import skills from a public git repository
  oh skills refresh <name>     show what changed upstream, and replace the snapshot
  oh skills enable <name>      offer the skill to your chats (disable turns it off)
  oh skills remove <name>      delete the skill and its snapshot (asks; --yes skips)
  oh login                     sign in through the browser (the device flow)
  oh logout                    end the session and forget the token
  oh whoami                    print the signed-in user
  oh update                    install the newest published version now
  oh --version | -v            print the version
  oh --help | -h               print this message

Options:
  -s, --session <id>           resume the session with this id
  -c, --continue               resume the most recent session
      --agent <id|name>        start from a saved agent instead of the default model
      --model <provider/model> the model to run, skipping the picker
      --mode <name>            a mode to run, instead of a model
      --threshold <share>      with \`oh settings\`: summarize at this share of the
                               context window (0.3–0.95), or 'default'
      --summary-model <id>     with \`oh settings\`: the model that writes summaries
                               (a provider/model id, or same-as-chat)
      --summary-passes <n>     with \`oh settings\`: passes before the chat model
                               summarizes instead (1–10), or 'default'
      --on | --off             with \`oh tools <name>\`: offer the tool, or stop
                               offering it
      --policy <p>             with \`oh tools <name>\`: what a call is evaluated
                               under — allow, ask or deny
      --ref <ref>              with \`oh skills add\`: the branch, tag or commit to read
                               (default: the repository's own)
      --path <path>            with \`oh skills add\`: the folder inside the repository
                               (default: its root)
      --all                    with \`oh skills add\`: import every candidate found
      --name <n>               with \`oh skills add\`: import this candidate (repeatable)
      --yes                    with \`oh sessions delete\` / \`oh providers remove\` /
                               \`oh skills refresh|remove <name>\`: do not ask to confirm
      --server <url>           server root (default https://app.oharness.dev)
      --no-browser             with \`oh login\`: print the URL and code instead of
                               opening a browser
      --debug                  show stack traces and the resolved configuration

Environment:
  OPENHARNESS_URL              server root, if --server is not given
  OH_NO_AUTO_UPDATE            set it to stop the background self-update

Config:
  ~/.config/openharness/config.json (or $XDG_CONFIG_HOME/openharness/config.json):
    { "server": "https://app.oharness.dev", "autoUpdate": true, "theme": "auto" }

Display:
  An agent's reply is rendered as Markdown: headings, emphasis, lists, quotes,
  links, tables and fenced code blocks, which are syntax-highlighted. The user's
  own message is shown as typed. Every colour is one of the terminal's own.
  theme picks the code block theme: 'auto' follows the terminal's background
  (COLORFGBG), 'light' and 'dark' say so outright. NO_COLOR turns colour off.

Updating:
  Installed with \`npm i -g @openh/cli\`, oh keeps itself current: at most once an
  hour a background check asks npm for the published version and, when it is newer,
  installs it for the next run. It is off in CI, with OH_NO_AUTO_UPDATE set, and with
  autoUpdate false in the config. The next run prints one line about it. \`oh update\`
  does the same thing in the foreground, with npm's own progress.

Signing in:
  oh login runs the device flow: it prints the sign-in URL and a code, opens the
  browser at that URL, and polls until you approve. The session token is stored per
  server in ~/.config/openharness/credentials.json (0600) and sent as
  \`Authorization: Bearer\` by every other command. oh logout revokes it.

New chats:
  oh starts on your default model (oh default-model sets it). Without one it asks,
  from the models your own provider keys can use, and offers to save the answer.
  --model names one directly; --agent starts from a saved agent preset instead.

Context settings:
  A long chat is summarized when it fills the model's context window, so it can go
  on. oh settings prints when that happens (the share of the window that triggers
  it), which model writes the summary, and how many passes it may take before the
  chat model takes over; its flags set them, and the same values live in the web
  app's Settings -> Context.

Model providers:
  A chat runs on a model from a provider you have a key for. Add one without
  leaving the terminal: oh providers add (or /providers inside a chat, or the
  first time oh finds no key at all). The key is typed into a hidden prompt,
  sent over HTTPS, and never written to this machine. oh providers lists what is
  stored (provider, last four, when it was added); oh providers remove <provider>
  forgets one. Signed out, oh offers to run the device-flow sign-in itself.

Skills:
  A skill is a folder of instructions from a public git repository, imported as a
  snapshot you review first. oh skills add <url> prints what the repository holds —
  a clone of the folder, its SKILL.md and its files, per candidate — and then either
  imports what --all or --name <n> named or opens a pick to choose from. oh skills
  lists yours; enable/disable switches one on for your chats; refresh re-reads its
  source, shows the diff, and replaces the snapshot only when you confirm; remove
  deletes it. /skills does the same inside a chat, and typing / offers your enabled,
  user-invocable skills beside the chat's own commands: /release-notes v1.2 sends
  the message and loads the skill's instructions into that turn.

In the chat:
${CHAT_REFERENCE}

  Type / at the start of a line to see the commands, and /help inside the chat
  for this list. A message that starts with // sends a literal /.
`

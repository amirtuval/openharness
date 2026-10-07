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
  oh default-model [id]        print or set the default model for new chats
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
      --yes                    with \`oh sessions delete\`: do not ask to confirm
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
  from the models your own provider keys can use (add a key in the web app under
  Settings → Model providers), and offers to save the answer. --model names one
  directly; --agent starts from a saved agent preset instead.

In the chat:
${CHAT_REFERENCE}

  Type / at the start of a line to see the commands, and /help inside the chat
  for this list. A message that starts with // sends a literal /.
`

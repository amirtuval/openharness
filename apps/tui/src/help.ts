/** The `oh --help` text, and what a usage error is followed by. */
export const HELP_TEXT = `openharness — chat with an agent from the terminal

Usage:
  oh [options]                 start a new chat (picks a model)
  oh -s <id>                   resume a session
  oh -c                        resume the most recent session
  oh sessions                  list sessions
  oh agents                    list the saved agents (optional presets)
  oh login                     sign in through the browser (the device flow)
  oh logout                    end the session and forget the token
  oh whoami                    print the signed-in user
  oh --version | -v            print the version
  oh --help | -h               print this message

Options:
  -s, --session <id>           resume the session with this id
  -c, --continue               resume the most recent session
      --agent <id|name>        start from a saved agent instead of picking a model
      --model <provider/model> the model to run, skipping the picker
      --server <url>           server root (default http://localhost:3000)
      --no-browser             with \`oh login\`: print the URL and code instead of
                               opening a browser
      --debug                  show stack traces and the resolved configuration

Environment:
  OPENHARNESS_URL              server root, if --server is not given

Config:
  ~/.config/openharness/config.json (or $XDG_CONFIG_HOME/openharness/config.json):
    { "server": "http://localhost:3000" }

Signing in:
  oh login runs the device flow: it prints the sign-in URL and a code, opens the
  browser at that URL, and polls until you approve. The session token is stored per
  server in ~/.config/openharness/credentials.json (0600) and sent as
  \`Authorization: Bearer\` by every other command. oh logout revokes it.

New chats:
  oh asks which model to run, from the models your own provider keys can use
  (add a key in the web app under Settings → Model providers). --model names one
  directly; --agent starts from a saved agent preset instead.

In the chat:
  Enter                        send (works while the agent is replying — steering)
  Ctrl+J / Alt+Enter           insert a newline
  Ctrl+C                       interrupt the reply; press twice when idle to exit
`

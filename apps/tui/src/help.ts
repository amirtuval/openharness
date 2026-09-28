/** The `oh --help` text, and what a usage error is followed by. */
export const HELP_TEXT = `openharness — chat with an agent from the terminal

Usage:
  oh [options]                 start a new chat
  oh -s <id>                   resume a session
  oh -c                        resume the most recent session
  oh sessions                  list sessions
  oh agents                    list agents
  oh --version | -v            print the version
  oh --help | -h               print this message

Options:
  -s, --session <id>           resume the session with this id
  -c, --continue               resume the most recent session
      --agent <id|name>        the agent to chat with when several exist
      --server <url>           server root (default http://localhost:3000)
      --api-key <key>          API key, sent as \`x-api-key\`
      --debug                  show stack traces and the resolved configuration

Environment:
  OPENHARNESS_URL              server root, if --server is not given
  OPENHARNESS_API_KEY          API key, if --api-key is not given

Config:
  ~/.config/openharness/config.json (or $XDG_CONFIG_HOME/openharness/config.json):
    { "server": "http://localhost:3000", "apiKey": "oh_..." }

In the chat:
  Enter                        send (works while the agent is replying — steering)
  Ctrl+J / Alt+Enter           insert a newline
  Ctrl+C                       interrupt the reply; press twice when idle to exit
`

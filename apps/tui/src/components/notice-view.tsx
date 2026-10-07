import { Box, Text } from 'ink'

import type { Notice } from '../chat/session'

/**
 * The line between the transcript and the status line: a hint ("press Ctrl+C again"),
 * something that went wrong, or what a command printed (`/help`).
 *
 * Errors keep the server's own message and add what to check; nothing here prints a stack,
 * which is what `--debug` is for. A hint is yellow, an error red with the `error:` label,
 * and a command's own output is left in the terminal's colour: it is neither a warning nor
 * a mistake, and colouring it either way would mislabel it.
 */
export function NoticeView({ notice }: { notice: Notice }) {
  return (
    <Box flexDirection="column">
      <Text color={noticeColor(notice.kind)}>
        {notice.kind === 'error' ? `error: ${notice.text}` : notice.text}
      </Text>
      {notice.hints.map((hint) => (
        <Text key={hint} dimColor>
          {`  ${hint}`}
        </Text>
      ))}
    </Box>
  )
}

/** An ANSI named colour, or none — the TUI never names a hex one (X4). */
function noticeColor(kind: Notice['kind']): 'red' | 'yellow' | undefined {
  switch (kind) {
    case 'error':
      return 'red'
    case 'hint':
      return 'yellow'
    case 'info':
      return undefined
  }
}

import { Box, Text } from 'ink'

import type { Notice } from '../chat/session'

/**
 * The transient line between the transcript and the status line: a hint ("press Ctrl+C
 * again"), or something that went wrong.
 *
 * Errors keep the server's own message and add what to check; nothing here prints a stack,
 * which is what `--debug` is for.
 */
export function NoticeView({ notice }: { notice: Notice }) {
  return (
    <Box flexDirection="column">
      <Text color={notice.kind === 'error' ? 'red' : 'yellow'}>
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

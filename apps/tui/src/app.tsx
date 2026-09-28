import { PACKAGE_NAME as CLIENT_PACKAGE_NAME } from '@openharness/client'
import { PACKAGE_NAME as PROTOCOL_PACKAGE_NAME } from '@openharness/protocol'
import { Box, Text } from 'ink'

export type AppProps = {
  version: string
}

/**
 * Placeholder screen. It shows the project name and the packages this command is wired to
 * (which is what proves the cli → protocol / client edges resolve through built output).
 * The chat TUI lands in the v1 epic.
 */
export function App({ version }: AppProps) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="cyan" bold>
        openharness
      </Text>
      <Text>Placeholder TUI — the chat client lands in the v1 epic.</Text>
      <Text dimColor>
        version {version} · wired: {PROTOCOL_PACKAGE_NAME}, {CLIENT_PACKAGE_NAME}
      </Text>
      <Text dimColor>Ctrl+C to exit</Text>
    </Box>
  )
}

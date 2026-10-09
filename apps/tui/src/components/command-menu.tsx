import { Box, Text } from 'ink'

import { commandUsage, type ChatCommand } from '../chat/commands'

export interface CommandMenuProps {
  /** The commands the buffer completes to, in registry order. Never empty: no rows, no menu. */
  readonly commands: readonly ChatCommand[]
  /** Which row is highlighted: the one Tab completes and Enter runs. */
  readonly selected: number
  /** The width the usage column is padded to; see `commandUsageWidth`. */
  readonly width: number
}

/**
 * The command list under the prompt, while a `/` line is being typed (#207).
 *
 * A row is one `<Text>`, like every other line this UI draws: the highlight is a colour, and
 * a test's frame — which has no colours in it — still reads the list as the user sees it.
 * The highlighted row is the one that runs, and the hint line is the only place Tab and Esc
 * are named, so it stays.
 */
export function CommandMenu({ commands, selected, width }: CommandMenuProps) {
  return (
    <Box flexDirection="column">
      {commands.map((command, position) => (
        <Text key={command.name} color={position === selected ? 'cyan' : undefined}>
          {`${position === selected ? '❯' : ' '} ${commandUsage(command).padEnd(width)}  ${command.description}`}
        </Text>
      ))}
      <Text dimColor>↑/↓ to choose, Tab to complete, Enter to run, Esc to close</Text>
    </Box>
  )
}

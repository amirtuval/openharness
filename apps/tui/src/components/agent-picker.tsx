import type { Agent } from '@openharness/protocol'
import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

export interface AgentPickerProps {
  /** The agents to choose from, in the order the server listed them. */
  readonly agents: readonly Agent[]
  /** Called with the chosen agent. */
  readonly onSelect: (agent: Agent) => void
  /** Called when the user gives up (Ctrl+C). */
  readonly onCancel: () => void
}

/**
 * The agent picker, shown when the server has more than one agent and `--agent` did not say
 * which one to use.
 *
 * Up/down move, Enter picks, the number keys pick directly, Ctrl+C leaves.
 */
export function AgentPicker({ agents, onSelect, onCancel }: AgentPickerProps) {
  const [index, setIndex] = useState(0)

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }

    if (key.upArrow) {
      setIndex((current) => Math.max(current - 1, 0))
      return
    }

    if (key.downArrow) {
      setIndex((current) => Math.min(current + 1, agents.length - 1))
      return
    }

    if (key.return) {
      const agent = agents[index]
      if (agent !== undefined) onSelect(agent)
      return
    }

    const numeric = Number.parseInt(input, 10)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= agents.length) {
      const agent = agents[numeric - 1]
      if (agent !== undefined) onSelect(agent)
    }
  })

  return (
    <Box flexDirection="column">
      <Text>Which agent?</Text>
      {agents.map((agent, position) => (
        <Text key={agent.id} color={position === index ? 'cyan' : undefined}>
          {`${position === index ? '❯' : ' '} ${position + 1}. ${agent.name} · ${agent.model.id}`}
        </Text>
      ))}
      <Text dimColor>↑/↓ or a number to choose, Enter to start, Ctrl+C to quit</Text>
    </Box>
  )
}

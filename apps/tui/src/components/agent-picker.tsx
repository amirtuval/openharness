import type { Agent } from '@openharness/protocol'
import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

/**
 * How many agents the picker draws at once.
 *
 * The picker is handed every agent the server has, and a server can have hundreds — a frame
 * that tall does not fit a terminal and is slow to redraw for every keystroke. So the list
 * is windowed: at most this many rows, following the cursor, with a count of what is out of
 * sight above and below. Ten rows plus the heading, the counts and the hint fits a 24-row
 * terminal with room to spare.
 */
export const PICKER_VISIBLE_ROWS = 10

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
 * Up/down move, Enter picks, the number keys pick directly, Ctrl+C leaves. The list scrolls
 * with the cursor, so every agent can be reached however many there are; the numbers are the
 * positions in the whole list, not in the window.
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

    // Only a list of at most nine can be picked by a single keystroke. Beyond that "12" would
    // choose 1 — a chat on the wrong agent — so numbers are left to the arrows, which reach
    // every agent anyway.
    if (agents.length > 9 || !/^[1-9]$/u.test(input)) return
    const agent = agents[Number.parseInt(input, 10) - 1]
    if (agent !== undefined) onSelect(agent)
  })

  // The window is derived from the cursor rather than kept beside it, so the two cannot get
  // out of step: the cursor sits in the middle of the window wherever it can.
  const rows = Math.min(agents.length, PICKER_VISIBLE_ROWS)
  const first = clamp(index - Math.floor(rows / 2), 0, Math.max(agents.length - rows, 0))
  const visible = agents.slice(first, first + rows)
  const above = first
  const below = agents.length - first - visible.length

  return (
    <Box flexDirection="column">
      <Text>Which agent?</Text>
      {above > 0 && <Text dimColor>{`  ↑ ${above} more`}</Text>}
      {visible.map((agent, position) => {
        const selected = first + position === index
        return (
          <Text key={agent.id} color={selected ? 'cyan' : undefined}>
            {`${selected ? '❯' : ' '} ${first + position + 1}. ${agent.name} · ${agent.model.id}`}
          </Text>
        )
      })}
      {below > 0 && <Text dimColor>{`  ↓ ${below} more`}</Text>}
      <Text dimColor>
        {agents.length > 9 ? '↑/↓ to choose' : '↑/↓ or a number to choose'}, Enter to start, Ctrl+C
        to quit
      </Text>
    </Box>
  )
}

/** Keep a number inside `[low, high]`. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

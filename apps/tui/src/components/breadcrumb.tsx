import type { Session } from '@openharness/protocol'
import { Box, Text } from 'ink'

import { PALETTE, paint } from '../markdown/theme'
import { truncateSpans, type Span } from '../markdown/text'
import { shortSessionId } from './status-line'
import { useTerminalTheme } from './theme'

/**
 * Where this chat sits — a child's line, above its input section (epic #340, S9; issue #347).
 *
 * A child is a real session (S3), so `oh` opens one as a full chat: the breadcrumb is the one
 * thing that says the chat a reader is typing into is not the one they started. It is the chain
 * the client walks for both frontends (`sessionBreadcrumb`, root first), drawn as
 * `root › researcher` with the chat itself last and undimmed — the part that is *here* against
 * the parts that are above it.
 *
 * A top-level chat draws nothing at all: there is nothing above it, and a line saying so would
 * be chrome about nothing.
 */
export function BreadcrumbLine({
  chain,
  width,
}: {
  /** The chain from the root chat down to this one, root first (`sessionBreadcrumb`). */
  readonly chain: readonly Session[]
  /** How wide the terminal is, when the caller knows better than Ink does. */
  readonly width?: number | undefined
}) {
  const theme = useTerminalTheme()
  return (
    <Box flexDirection="column">
      <Text>
        {truncateSpans(breadcrumbSpans(chain, theme), width ?? 80).map((span, at) => (
          <Text key={at} color={span.color} dimColor={span.dim}>
            {span.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

/**
 * The line's spans: every step but the last dimmed, the chat itself in the foreground's own
 * colour, and the separators chrome — so a reader's eye lands on where they are.
 */
export function breadcrumbSpans(
  chain: readonly Session[],
  theme: ReturnType<typeof useTerminalTheme>,
): Span[] {
  const spans: Span[] = []
  chain.forEach((session, index) => {
    if (index > 0) {
      spans.push({ text: ' › ', color: paint(theme, PALETTE.chrome), dim: true })
    }
    const current = index === chain.length - 1
    spans.push(
      current
        ? { text: sessionLabel(session) }
        : { text: sessionLabel(session), color: paint(theme, PALETTE.chrome), dim: true },
    )
  })
  return spans
}

/** What a chat is called in the chain: its title, or a short handle when it has none yet. */
export function sessionLabel(session: Session): string {
  const title = session.title?.trim() ?? ''
  return title === '' ? shortSessionId(session.id) : title
}

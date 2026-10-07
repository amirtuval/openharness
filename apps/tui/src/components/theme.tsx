import { createContext, useContext, type ReactNode } from 'react'

import { DEFAULT_THEME, type TerminalTheme } from '../markdown/theme'

/**
 * The theme, for the components that draw (epic #201, X4).
 *
 * A context rather than a prop because of where the theme is *used*: the message view, which
 * is rendered by `<Static>` for every settled message and re-rendered for the one that is
 * streaming. Threading it down would mean the transcript view and the chat screen both
 * carrying a value neither of them looks at, purely to pass it along.
 *
 * The default is the dark theme in colour, which is what a component rendered on its own —
 * a test's `<MessageView>`, a future preview — should draw with; `runChat` provides the
 * resolved one, from the config file and the environment.
 */
const ThemeContext = createContext<TerminalTheme>(DEFAULT_THEME)

export function ThemeProvider({
  theme,
  children,
}: {
  readonly theme: TerminalTheme
  readonly children: ReactNode
}) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

/** The theme the message view draws with. */
export function useTerminalTheme(): TerminalTheme {
  return useContext(ThemeContext)
}

import globals from 'globals'
import { baseConfig } from './base.js'

/**
 * Flat config for React packages (the web app; the TUI uses it too because Ink renders
 * React components).
 *
 * @param {Parameters<typeof baseConfig>[0]} [options]
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function reactConfig(options = {}) {
  const merged = { ...globals.browser, ...globals.node }
  return baseConfig({ ...options, globals: merged })
}

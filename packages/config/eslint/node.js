import globals from 'globals'
import { baseConfig } from './base.js'

/**
 * Flat config for Node.js packages (libraries, the server and the CLI).
 *
 * @param {Parameters<typeof baseConfig>[0]} [options]
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function nodeConfig(options = {}) {
  return baseConfig({ ...options, globals: globals.node })
}

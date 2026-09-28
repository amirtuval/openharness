export type CliCommand =
  { kind: 'version' } | { kind: 'help' } | { kind: 'app'; args: readonly string[] }

/** Parses the `oh` command line. Three commands is all the placeholder needs. */
export function parseArgs(argv: readonly string[]): CliCommand {
  const [first] = argv

  if (first === '--version' || first === '-v') {
    return { kind: 'version' }
  }

  if (first === '--help' || first === '-h') {
    return { kind: 'help' }
  }

  return { kind: 'app', args: argv }
}

import { describeError, type ErrorContext } from '../errors'

/** Where a command that prints and stops writes, and what its errors should mention. */
export interface CommandIo {
  /** One line of output. */
  readonly stdout: (line: string) => void
  /** One line of error output. */
  readonly stderr: (line: string) => void
  /** The server this run is about, for the error hints. */
  readonly context: ErrorContext
}

/** Print a failure the way the rest of the CLI does, and return its exit code. */
export function reportFailure(io: CommandIo, error: unknown): number {
  const report = describeError(error, io.context)
  io.stderr(`oh: ${report.message}`)
  for (const hint of report.hints) io.stderr(`  ${hint}`)
  if (report.stack !== undefined) io.stderr(report.stack)
  return 1
}

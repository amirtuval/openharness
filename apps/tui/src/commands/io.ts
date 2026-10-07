import { createInterface } from 'node:readline'

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

/** One line from `stdin`, without its line terminator; `''` at end of input. */
export function readLine(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY })
    // Whichever comes first settles it. `close()` can emit 'close' synchronously, so the
    // guard is what keeps a read line from being overwritten by the close it caused.
    let settled = false
    const finish = (line: string): void => {
      if (settled) return
      settled = true
      lines.close()
      resolve(line)
    }

    lines.once('line', (line) => {
      finish(line)
    })
    lines.once('close', () => {
      finish('')
    })
  })
}

/** What a `[y/N]` confirmation accepts as yes. */
export function isYes(answer: string): boolean {
  return /^y(es)?$/iu.test(answer.trim())
}

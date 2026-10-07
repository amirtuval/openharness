import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Write `contents` to `path` without a window in which the file is missing or half-written:
 * a temp file in the same directory with mode `0600`, then a rename over the target.
 *
 * The directory is created `0700` when it does not exist yet — a home directory that only
 * the user may read — and one that already exists but is more open is tightened the same
 * way: what these files hold (a session token, the prompts a person typed) is worth no more
 * than the directory holding them.
 *
 * Shared by the two files under the openharness config directory that are written this way,
 * {@link credentialsFilePath | credentials.json} and the prompt history (#206). A throw here
 * is the caller's to turn into a message or to swallow, depending on what the file is worth
 * to the command that was asked for.
 */
export function writeFileAtomically(path: string, contents: string): void {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    tightenDirectory(directory)
    try {
      const handle = openSync(temporary, 'wx', 0o600)
      try {
        writeSync(handle, contents)
      } finally {
        closeSync(handle)
      }
      renameSync(temporary, path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  } catch (error) {
    throw new Error(`could not write ${path}: ${detailOf(error)}`, { cause: error })
  }
}

/** Drop group and other access from `directory`, when it has any: `0700` again. */
function tightenDirectory(directory: string): void {
  if ((statSync(directory).mode & 0o077) !== 0) {
    chmodSync(directory, 0o700)
  }
}

/** The message of whatever was thrown, for a line that has to name the problem. */
export function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether `error` is the errno `code` — `ENOENT` for a file that is simply not there. */
export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

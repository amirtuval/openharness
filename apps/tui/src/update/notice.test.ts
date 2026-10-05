import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PERMISSION_HINT } from './npm'
import { noticeLines, printPendingNotice } from './notice'
import { writeUpdateState, type UpdateResult } from './state'

let directory: string
let statePath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'oh-update-notice-'))
  statePath = join(directory, 'openharness', 'update-state.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A recorder for the two streams a notice goes to. */
function streams() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  }
}

/** The notice text for one result. */
function lines(result: UpdateResult): readonly string[] {
  return noticeLines(result)
}

describe('noticeLines', () => {
  it('is one line about the version that landed', () => {
    expect(lines({ status: 'success', version: '0.4.0', at: 'now' })).toEqual([
      'oh updated to v0.4.0',
    ])
  })

  it('says what failed and repeats the command that would fix it', () => {
    expect(
      lines({ status: 'failure', version: '0.4.0', reason: 'npm exited with code 1', at: 'now' }),
    ).toEqual(['oh could not update itself: npm exited with code 1; run npm i -g openharness'])
  })

  it('adds the sudo/prefix hint when npm could not write to its prefix', () => {
    const notice = lines({
      status: 'failure',
      version: '0.4.0',
      reason: 'npm exited with code 1: npm error code EACCES',
      permission: true,
      at: 'now',
    })

    expect(notice).toHaveLength(2)
    expect(notice[0]).toContain('oh could not update itself:')
    expect(notice[0]).toContain('run npm i -g openharness')
    expect(notice[1]).toBe(PERMISSION_HINT)
    // The two things a person can actually do about it, named.
    expect(notice[1]).toContain('sudo')
    expect(notice[1]).toContain('npm config set prefix')
  })

  it('still says something when the reason went missing', () => {
    expect(lines({ status: 'failure', version: '0.4.0', at: 'now' })[0]).toBe(
      'oh could not update itself: the install failed; run npm i -g openharness',
    )
  })
})

describe('printPendingNotice', () => {
  it('prints the pending outcome and forgets it, so the next run is silent', () => {
    writeUpdateState(statePath, {
      result: { status: 'success', version: '0.4.0', at: 'now' },
    })

    const first = streams()
    expect(printPendingNotice(statePath, first)).toBe(true)
    expect(first.out).toEqual(['oh updated to v0.4.0'])
    expect(first.err).toEqual([])

    const second = streams()
    expect(printPendingNotice(statePath, second)).toBe(false)
    expect(second.out).toEqual([])
    expect(second.err).toEqual([])
  })

  it('sends a failure to stderr, where problems go', () => {
    writeUpdateState(statePath, {
      result: { status: 'failure', version: '0.4.0', reason: 'boom', at: 'now' },
    })

    const recorded = streams()
    printPendingNotice(statePath, recorded)

    expect(recorded.out).toEqual([])
    expect(recorded.err).toEqual(['oh could not update itself: boom; run npm i -g openharness'])
  })

  it('prints nothing when there is no outcome waiting', () => {
    const recorded = streams()
    expect(printPendingNotice(statePath, recorded)).toBe(false)
    expect(recorded.out).toEqual([])
    expect(recorded.err).toEqual([])
  })
})

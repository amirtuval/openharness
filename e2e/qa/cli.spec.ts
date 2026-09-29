import { execFileSync } from 'node:child_process'

import { expect, test } from './support'
import { CLI_COMMAND, CLI_SERVER, CLI_CWD, Terminal } from './tmux'

/**
 * Leave a chat, and answer the resume hint it prints.
 *
 * One Ctrl+C arms the exit and says so; the second, inside the two-second window, takes it.
 * Waiting for the first message rather than sleeping makes the pair deterministic — a stray
 * Ctrl+C while a turn is running is an interrupt, not an arm.
 */
async function quit(terminal: Terminal): Promise<string> {
  terminal.send('C-c')
  await terminal.waitFor(/Press Ctrl\+C again to exit\./)
  terminal.send('C-c')
  const hint = await terminal.waitFor(/Resume this session with: oh -s sesn_[A-Z0-9]+/)
  await terminal.waitForShellPrompt()
  return hint[0]
}

/**
 * The `oh` scenarios, driven through a real pseudo-terminal.
 *
 * Opt-in with `QA_WITH_CLI=1`, because it needs `tmux` and a built CLI:
 *
 *   yarn turbo run build --filter=@openharness/cli...
 *   QA_WITH_CLI=1 yarn qa:web qa/cli.spec.ts
 */
test.describe('cli scenarios', () => {
  test.skip(process.env.QA_WITH_CLI !== '1', 'set QA_WITH_CLI=1 to drive the oh CLI in tmux')

  test('C1 new chat: pick an agent, send, stream, prompt back', async ({ context }) => {
    const terminal = new Terminal('oh-qa-c1')
    const shot = await context.newPage()
    terminal.start()

    try {
      terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER}`)
      await terminal.waitFor(/Which agent\?/)
      await terminal.screenshot(shot, 'c1-01-agent-picker')

      terminal.send('1', 'Enter')
      await terminal.waitForIdle()

      terminal.type('hello from the terminal')
      terminal.send('Enter')
      await terminal.waitFor(/agent ›/)

      // Wait for the reply, not just for "idle": the status line says idle before the turn
      // starts too, so an `idle` that was already on screen is not the end of anything.
      await terminal.waitFor(/agent › hello from the terminal/)
      await terminal.screenshot(shot, 'c1-02-streaming')
      await terminal.waitForIdle()
      const screen = terminal.capture()
      expect(screen).toContain('you › hello from the terminal')
      expect(screen).toContain('agent › hello from the terminal')
      expect(screen, 'the status line is back').toMatch(/idle/)
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C2 a long reply at 80x24 and at 200x50', async ({ context }) => {
    const terminal = new Terminal('oh-qa-c2', 80, 24)
    const shot = await context.newPage()
    terminal.start()

    try {
      terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER}`)
      await terminal.waitFor(/Which agent\?/)
      terminal.send('1', 'Enter')
      await terminal.waitForIdle()

      terminal.type('__slow__ a long reply please')
      terminal.send('Enter')
      await terminal.waitFor(/part 4\/40/)
      await terminal.screenshot(shot, 'c2-01-slow-stream-80x24')

      await terminal.waitFor(/part 40\/40/, 60_000)
      await terminal.waitForIdle()
      // Wrapped to the terminal width, and the status line and prompt are still there.
      const narrow = terminal.capture()
      expect(narrow).toContain('part 40/40')
      expect(narrow).toMatch(/idle/)
      expect(narrow).toContain('❯')

      terminal.resize(200, 50)
      await new Promise((resolve) => setTimeout(resolve, 500))
      terminal.type('now at the wider size')
      terminal.send('Enter')
      await terminal.waitFor(/agent › now at the wider size/, 30_000)
      await terminal.waitForIdle()
      await terminal.screenshot(shot, 'c2-02-wide-200x50')
      const wide = terminal.capture()
      expect(wide).toContain('now at the wider size')
      expect(wide).toContain('❯')
      // The reply printed before the resize keeps the 80-column wrapping it was written
      // with; nothing reflows it, and nothing is left half-drawn either.
      expect(wide).toContain('part 40/40')
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C3 resume: the printed hint, and -c', async ({ context }) => {
    const terminal = new Terminal('oh-qa-c3', 100, 30)
    const shot = await context.newPage()
    terminal.start()

    try {
      terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER}`)
      await terminal.waitFor(/Which agent\?/)
      terminal.send('1', 'Enter')
      await terminal.waitForIdle()

      terminal.type('a message worth resuming')
      terminal.send('Enter')
      await terminal.waitFor(/agent › a message worth resuming/, 30_000)
      await terminal.waitForIdle()
      const sessionId = (await terminal.waitFor(/sesn_[A-Z0-9]+/))[0]

      const hint = await quit(terminal)
      expect(hint).toContain(sessionId)
      await terminal.screenshot(shot, 'c3-01-resume-hint')

      // The hint, followed literally: the history comes back.
      terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER} -s ${sessionId}`)
      await terminal.waitFor(/a message worth resuming/)
      await terminal.waitForIdle()
      expect(terminal.capture()).toContain('a message worth resuming')
      await terminal.screenshot(shot, 'c3-02-resumed')

      await quit(terminal)

      // -c: the most recent session, which is the one just resumed.
      terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER} -c`)
      await terminal.waitFor(/agent › a message worth resuming/, 30_000)
      await terminal.waitForIdle()
      expect(terminal.capture()).toContain('a message worth resuming')
      await terminal.screenshot(shot, 'c3-03-continued')
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C4 a message sent while a reply streams is queued and answered', async ({ context }) => {
    const terminal = new Terminal('oh-qa-c4', 100, 30)
    const shot = await context.newPage()
    terminal.start()

    try {
      terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER}`)
      await terminal.waitFor(/Which agent\?/)
      terminal.send('1', 'Enter')
      await terminal.waitForIdle()

      terminal.type('__slow__ first question')
      terminal.send('Enter')
      await terminal.waitFor(/you › __slow__ first question/)
      await terminal.waitFor(/\brunning\b/, 15_000)
      await terminal.waitFor(/part 3\/40/)

      terminal.type('second question')
      terminal.send('Enter')
      await terminal.waitFor(/second question \(queued\)/)
      await terminal.screenshot(shot, 'c4-01-steering-queued')

      await terminal.waitFor(/agent › second question/, 60_000)
      await terminal.waitForIdle()
      expect(terminal.capture(), 'the queued marker is gone').not.toContain('(queued)')
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C5 Ctrl+C stops a stream and a second Ctrl+C exits cleanly', async ({ context }) => {
    // A terminal of its own: an earlier `__slow__` reply would still be on screen and its
    // "part 3/40" would satisfy the wait below before this turn had started.
    const terminal = new Terminal('oh-qa-c5', 100, 30)
    const shot = await context.newPage()
    terminal.start()

    try {
      terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER}`)
      await terminal.waitFor(/Which agent\?/)
      terminal.send('1', 'Enter')
      await terminal.waitForIdle()

      await test.step('Ctrl+C stops the stream and keeps the partial reply', async () => {
        terminal.type('__slow__ interrupt me')
        terminal.send('Enter')
        await terminal.waitFor(/\brunning\b/, 15_000)
        await terminal.waitFor(/part 5\/40/, 20_000)
        terminal.send('C-c')
        await terminal.waitForIdle()

        const screen = terminal.capture()
        const interrupted = screen.slice(screen.lastIndexOf('you › __slow__ interrupt me'))
        expect(interrupted, 'the partial reply stays on screen').toMatch(/part 1\/40/)
        expect(interrupted, 'the reply stopped short').not.toContain('part 40/40')
        expect(interrupted, 'back at the prompt').toContain('❯')
        await terminal.screenshot(shot, 'c5-01-interrupted')

        await new Promise((resolve) => setTimeout(resolve, 1500))
        expect(terminal.capture(), 'nothing arrived after the interrupt').toBe(screen)
      })

      await test.step('a new message still works', async () => {
        terminal.type('after the interrupt')
        terminal.send('Enter')
        await terminal.waitFor(/agent › after the interrupt/, 30_000)
        await terminal.waitForIdle()
      })

      await test.step('Ctrl+C twice when idle exits and restores the terminal', async () => {
        await quit(terminal)

        terminal.run('echo terminal-restored')
        await terminal.waitFor(/terminal-restored/)
        expect(terminal.capture()).toContain('terminal-restored')
        await terminal.screenshot(shot, 'c5-02-terminal-restored')
      })
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C6 Ctrl+J and Alt+Enter insert a newline', async ({ context }) => {
    const terminal = new Terminal('oh-qa-c6', 100, 30)
    const shot = await context.newPage()
    terminal.start()

    try {
      terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER}`)
      await terminal.waitFor(/Which agent\?/)
      terminal.send('1', 'Enter')
      await terminal.waitForIdle()

      terminal.type('first line')
      terminal.send('C-j')
      await new Promise((resolve) => setTimeout(resolve, 200))
      terminal.type('second line')
      await terminal.waitFor(/first line\s*\n\s+second line/)
      await terminal.screenshot(shot, 'c6-01-ctrl-j')

      terminal.send('Enter')
      await terminal.waitFor(/agent › first line/, 30_000)
      const sent = terminal.capture()
      expect(sent).toContain('second line')

      await terminal.waitForIdle()
      terminal.type('alt line one')
      terminal.send('M-Enter')
      await new Promise((resolve) => setTimeout(resolve, 200))
      terminal.type('alt line two')
      await terminal.waitFor(/alt line one\s*\n\s+alt line two/)
      await terminal.screenshot(shot, 'c6-02-alt-enter')
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C7 commands and bad arguments', async () => {
    const oh = (...args: string[]): { stdout: string; status: number } => {
      try {
        const stdout = execFileSync('node', ['apps/tui/dist/index.js', ...args], {
          cwd: CLI_CWD,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        return { stdout, status: 0 }
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; status?: number }
        return {
          stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
          status: failure.status ?? -1,
        }
      }
    }

    await test.step('--version and --help', () => {
      const version = oh('--version')
      expect(version.status).toBe(0)
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)

      const help = oh('--help')
      expect(help.status).toBe(0)
      expect(help.stdout).toContain('Usage:')
      expect(help.stdout).toContain('oh sessions')
    })

    await test.step('bad arguments explain themselves and exit 2', () => {
      const flag = oh('--nope')
      expect(flag.status).toBe(2)
      expect(flag.stdout).toContain("Unknown option '--nope'")

      const command = oh('frobnicate')
      expect(command.status).toBe(2)
      expect(command.stdout).toContain("unknown command 'frobnicate'")

      const missing = oh('-s')
      expect(missing.status).toBe(2)
      expect(missing.stdout).toContain('argument missing')
    })

    await test.step('oh agents and oh sessions are readable', () => {
      const agents = oh('agents', '--server', CLI_SERVER)
      expect(agents.status).toBe(0)
      const firstAgentLine = agents.stdout.split('\n').filter((line) => line.trim() !== '')[0] ?? ''
      expect(firstAgentLine).toMatch(/^agent_\S+\s+.*\S+\/\S+/)

      const sessions = oh('sessions', '--server', CLI_SERVER)
      expect(sessions.status).toBe(0)
      const firstSessionLine =
        sessions.stdout.split('\n').filter((line) => line.trim() !== '')[0] ?? ''
      expect(firstSessionLine).toMatch(/^sesn_\S+\s+.*\s+(running|idle)\s+\S+/)
    })
  })

  test('C9 a server that is not there, and a bad key', () => {
    const oh = (...args: string[]): { stdout: string; status: number } => {
      try {
        const stdout = execFileSync('node', ['apps/tui/dist/index.js', ...args], {
          cwd: CLI_CWD,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        return { stdout, status: 0 }
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; status?: number }
        return {
          stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
          status: failure.status ?? -1,
        }
      }
    }

    const down = oh('agents', '--server', 'http://localhost:3999')
    expect(down.status).toBe(1)
    expect(down.stdout).toContain('could not reach the server at http://localhost:3999')
    expect(down.stdout, 'no stack trace').not.toMatch(/\n\s+at /)

    if (process.env.QA_API_KEY !== undefined && process.env.QA_API_KEY !== '') {
      const wrong = oh('agents', '--server', CLI_SERVER, '--api-key', 'not-the-key')
      expect(wrong.status).toBe(1)
      expect(wrong.stdout).toMatch(/401/)
      expect(wrong.stdout).toContain('check the API key')
    }
  })
})

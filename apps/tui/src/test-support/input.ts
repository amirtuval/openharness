import { vi } from 'vitest'

/** The part of `ink-testing-library`'s stdin these helpers need. */
export interface TestStdin {
  write(data: string): void
}

/** The part of an `ink-testing-library` instance these helpers need. */
export interface TestInstance {
  readonly stdin: TestStdin
  lastFrame(): string | undefined
}

/**
 * Type text the way a terminal delivers it: one keystroke per `data` event.
 *
 * Writing a whole string at once would arrive as a single chunk, which Ink reports as one
 * multi-character `input` — that is a paste, and the prompt treats it as one (newlines and
 * all), so a test that means "type, then press Enter" has to say so keystroke by keystroke.
 */
export function typeText(instance: TestInstance, text: string): void {
  for (const character of text) {
    instance.stdin.write(character)
  }
}

/** The bytes each key sends, as a terminal would. */
const KEYS = {
  enter: '\r',
  /** Line feed: what Ctrl+J sends, and the prompt's newline. */
  newline: '\n',
  ctrlC: '\u0003',
  up: '\u001B[A',
  down: '\u001B[B',
  backspace: '\u007F',
} as const

/** Press a named key. */
export function pressKey(instance: TestInstance, key: keyof typeof KEYS): void {
  instance.stdin.write(KEYS[key])
}

/** Type `text` and press Enter. */
export function submit(instance: TestInstance, text: string): void {
  typeText(instance, text)
  pressKey(instance, 'enter')
}

/** The frame as it stands, or `''` before the first render. */
export function frameOf(instance: TestInstance): string {
  return instance.lastFrame() ?? ''
}

/**
 * Wait until the rendered frame contains `expected`.
 *
 * The UI is fed by streams and effects, so nothing is on screen the instant a keystroke is
 * written. Retrying the assertion is the only honest way to test a rendered terminal app;
 * the failure message prints the frame that was there instead.
 */
export async function waitForFrame(
  instance: TestInstance,
  expected: string | RegExp,
  timeoutMs = 2000,
): Promise<void> {
  await vi.waitFor(
    () => {
      const frame = frameOf(instance)
      const found = typeof expected === 'string' ? frame.includes(expected) : expected.test(frame)
      if (!found) {
        throw new Error(`the frame never showed ${String(expected)}. It was:\n${frame}`)
      }
    },
    { timeout: timeoutMs, interval: 20 },
  )
}

/**
 * Wait for a *screen* to appear, and for it to be ready for keys.
 *
 * React runs passive effects — which is where `useInput` subscribes — after the frame is
 * written, so a key pressed the instant a screen shows up is a key nobody is listening for.
 * A person cannot type that fast; a test can.
 */
export async function waitForScreen(
  instance: TestInstance,
  expected: string | RegExp,
  timeoutMs = 2000,
): Promise<void> {
  await waitForFrame(instance, expected, timeoutMs)
  await tick(50)
}

/** Wait until `check` holds, for state that is not on screen. */
export async function waitFor(
  check: () => boolean,
  options: { readonly timeoutMs?: number; readonly describe?: () => string } = {},
): Promise<void> {
  await vi
    .waitFor(
      () => {
        if (!check()) throw new Error('not there yet')
      },
      { timeout: options.timeoutMs ?? 2000, interval: 10 },
    )
    .catch((error: unknown) => {
      const detail = options.describe?.()
      throw new Error(
        detail === undefined
          ? 'the condition never became true'
          : `the condition never became true: ${detail}`,
        { cause: error },
      )
    })
}

/** Let the event loop turn over: enough for a stream to deliver what it has queued. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

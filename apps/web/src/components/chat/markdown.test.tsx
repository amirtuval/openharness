import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, type Mock } from 'vitest'

import { agentText, isStreaming, makeFake, renderApp } from '../../test-support/render-app'
import { gateStream } from '../../test-support/stream'
import { Markdown } from './markdown'

/**
 * The agent's markdown (epic #201, #204).
 *
 * Two halves: the renderer on its own, fed the text a reply is made of, and one end-to-end
 * pass through the app's stream — because "an unfinished fence renders sensibly **while it
 * streams**" is a claim about the transcript, not just about `react-markdown`.
 *
 * The highlighter is not mocked. `src/lib/highlight.ts` really is a dynamic import and the
 * first block really does load Shiki and its wasm engine, which is the only way to know that
 * it works in the browser build at all; the waits below are generous for that reason, and
 * every test after the first pays nothing for it.
 */

/** Install a clipboard the test can read. jsdom has no `navigator.clipboard` of its own. */
function stubClipboard(): Mock<(text: string) => Promise<void>> {
  const writeText = vi.fn<(text: string) => Promise<void>>()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

/** The first fenced block on screen, or `null` — for the conditions that run before one is. */
function findCodeBlock(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="code-block"]')
}

/** The first fenced block on screen; fails loudly when there is none. */
function codeBlock(): HTMLElement {
  const block = findCodeBlock()
  if (block === null) {
    throw new Error('no code block on screen')
  }
  return block
}

/** The first line of tokens of the block on screen. */
function tokens(block = codeBlock()): HTMLElement[] {
  return [...block.querySelectorAll<HTMLElement>('[data-slot="code-token"]')]
}

describe('the markdown renderer', () => {
  it('renders GFM: headings, lists, tables, inline code and blockquotes', () => {
    render(
      <Markdown
        text={
          '## Steps\n\n' +
          '- first\n' +
          '- second\n\n' +
          '> a quote\n\n' +
          '| a | b |\n| - | - |\n| 1 | 2 |\n\n' +
          'Use `pnpm test` to run them.\n'
        }
      />,
    )

    expect(screen.getByRole('heading', { name: 'Steps' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('a quote').closest('blockquote')).not.toBeNull()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('pnpm test').tagName).toBe('CODE')
    // A wide table scrolls rather than squashing the message — the same rule the code block
    // follows on a long line.
    expect(screen.getByRole('table').parentElement?.className).toContain('overflow-x-auto')
  })

  it('highlights a fenced block, with a theme variable for each app theme', async () => {
    render(<Markdown text={'```typescript\nconst greeting = "hi"\n```'} />)

    // The block is on screen — labelled, readable, copyable — before the highlighter has
    // answered: the dynamic import, the engine and the grammar all have to arrive first, and
    // none of them is allowed to hold the reply up. This is that moment.
    expect(codeBlock().dataset.language).toBe('typescript')
    expect(screen.getByText('typescript')).toBeInTheDocument()
    expect(codeBlock().textContent).toContain('const greeting = "hi"')
    expect(tokens()[0]?.getAttribute('style')).toBeNull()

    await waitFor(
      () => {
        expect(tokens()[0]?.getAttribute('style')).toContain('--shiki-light')
      },
      { timeout: 15_000 },
    )

    // Shiki's multi-theme output: every token carries all three palettes, and `index.css`
    // picks the one `[data-theme]` names. Asserting the variables rather than a colour is
    // asserting the thing the three themes actually depend on.
    expect(tokens()[0]?.textContent).toBe('const')
    expect(tokens()[0]?.getAttribute('style')).toContain('--shiki-dim')
    expect(tokens()[0]?.getAttribute('style')).toContain('--shiki-dark')

    // The block's own surface and ink are variables too, so an unhighlighted block can fall
    // back to the design tokens instead.
    expect(codeBlock().getAttribute('style')).toContain('--shiki-light-bg')
  })

  it('falls back to plain text for a language it does not highlight', async () => {
    render(<Markdown text={'```klingon\nnuqneH\n```'} />)

    // Still a code block, still labelled, still copyable — just not coloured. The highlighter
    // is genuinely asked and genuinely has no answer for this language, so this is not the
    // "not loaded yet" state: the block is the same one plain line after it.
    expect(codeBlock().dataset.language).toBe('klingon')
    expect(codeBlock().textContent).toContain('nuqneH')

    const { highlight } = await import('../../lib/highlight')
    await expect(highlight('nuqneH', 'klingon')).resolves.toBeNull()
    expect(codeBlock().getAttribute('style')).toBeNull()
  })

  it('copies a block, and says so briefly', async () => {
    const user = userEvent.setup({ delay: null })
    const writeText = stubClipboard()
    render(<Markdown text={'```bash\ndeploy --now\n```'} />)

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(writeText).toHaveBeenCalledWith('deploy --now\n')
    // The label flips while the timer runs, and the block is not re-highlighted to do it.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    })
  })

  it('draws a fence with no language, and an indented block, as blocks too', () => {
    // To `react-markdown` these are the same two elements as a fence, and only the
    // `language-…` class tells them apart — so both are a code block, labelled `text`.
    const { unmount } = render(<Markdown text={'```\nno language here\n```'} />)
    expect(codeBlock().dataset.language).toBe('text')
    expect(screen.getByText('text')).toBeInTheDocument()
    expect(codeBlock().textContent).toContain('no language here')
    unmount()

    render(<Markdown text={'    an indented block\n    and its second line\n'} />)
    expect(codeBlock().dataset.language).toBe('text')
    expect(codeBlock().textContent).toContain('an indented block')
    expect(codeBlock().textContent).toContain('and its second line')
  })

  it('keeps raw HTML as text', () => {
    render(<Markdown text={'<img src=x onerror="alert(1)"> and <b>not bold</b>'} />)

    // No `rehype-raw`: what arrived is what is shown, and nothing in it became an element.
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument()
  })

  it('opens links in a new tab, without a referrer', () => {
    render(<Markdown text={'See [the docs](https://example.com/docs).'} />)

    const link = screen.getByRole('link', { name: 'the docs' })
    expect(link).toHaveAttribute('href', 'https://example.com/docs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  describe('while the reply is still arriving', () => {
    it('draws an unfinished fence as the code block it is becoming', () => {
      // No closing fence: CommonMark closes it at the end of what has arrived, which is the
      // whole of the handling — the block is a code block from its first line on, so the
      // reader never sees a stray ``` or a wall of markup that turns into code later.
      render(<Markdown text={'Run this:\n\n```bash\nkubectl apply -f deploy.yaml'} />)

      expect(codeBlock().dataset.language).toBe('bash')
      expect(codeBlock().textContent).toContain('kubectl apply -f deploy.yaml')
      expect(screen.getByText(/Run this:/)).toBeInTheDocument()
    })

    it('shows an unfinished bold or link as the characters that have arrived', () => {
      const { rerender } = render(<Markdown text={'Done. **bol'} />)
      expect(screen.getByText('Done. **bol')).toBeInTheDocument()

      // Once the markers close, the same text is the emphasis they were writing.
      rerender(<Markdown text={'Done. **bold**'} />)
      expect(screen.getByText('bold').tagName).toBe('STRONG')

      render(<Markdown text={'See [the docs](/guid'} />)
      expect(screen.getByText('See [the docs](/guid')).toBeInTheDocument()
      expect(screen.queryByRole('link')).toBeNull()
    })

    it('leaves the marker of an unfinished link as text beside the address it can see', () => {
      // GFM autolinks the `https://…` it has been given, so the address half is a link
      // already — but the `[the docs](` before it stays exactly the characters that arrived,
      // and the next delta replaces the pair with the one link they were writing.
      render(<Markdown text={'See [the docs](https://exa'} />)

      expect(screen.getByText('See [the docs](')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'https://exa' })).toBeInTheDocument()
    })

    it('streams a reply with the fence still open, and finishes it', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      // The fragments are the reply cut where a model would cut it: one lands inside the
      // fence, and one inside an inline link.
      fake.respondWith('Run this:\n\n```bash\nkubectl apply -f deploy.yaml', {
        chunks: ['Run this:\n\n```bash\n', 'kubectl apply -f ', 'deploy.yaml'],
      })
      const stream = gateStream(fake)
      renderApp(fake)

      await user.type(await screen.findByLabelText('Message'), 'how do I deploy?')
      await user.click(screen.getByRole('button', { name: 'Send message' }))

      await stream.until(
        () => isStreaming() && findCodeBlock()?.textContent?.includes('deploy.yaml') === true,
        'the open fence, mid-stream',
      )

      // Mid-stream: the reply is still arriving, and the half-written fence is already the
      // code block it will be — labelled, closed at the end of what has arrived.
      expect(isStreaming()).toBe(true)
      expect(codeBlock().dataset.language).toBe('bash')
      expect(codeBlock().textContent).toContain('kubectl apply -f deploy.yaml')
      expect(agentText()).toContain('Run this:')
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()

      await stream.until(() => !isStreaming(), 'the finished reply')
      expect(codeBlock().textContent).toContain('kubectl apply -f deploy.yaml')
    })
  })
})

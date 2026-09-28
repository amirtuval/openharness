import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { App } from './app'

describe('App', () => {
  it('renders the openharness placeholder', () => {
    const { lastFrame } = render(<App version="0.0.0" />)
    const frame = lastFrame() ?? ''

    expect(frame).toContain('openharness')
    expect(frame).toContain('0.0.0')
  })
})

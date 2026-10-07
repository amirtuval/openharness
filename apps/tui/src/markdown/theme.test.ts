import { describe, expect, it } from 'vitest'

import {
  colorEnabled,
  detectBackground,
  paint,
  resolveTerminalTheme,
  syntaxColor,
  type TerminalTheme,
} from './theme'

const DARK: TerminalTheme = { background: 'dark', color: true }
const LIGHT: TerminalTheme = { background: 'light', color: true }
const PLAIN: TerminalTheme = { background: 'dark', color: false }

describe('detectBackground', () => {
  it('is dark when the terminal says nothing', () => {
    expect(detectBackground({})).toBe('dark')
    expect(detectBackground({ COLORFGBG: '' })).toBe('dark')
    expect(detectBackground({ COLORFGBG: 'nonsense' })).toBe('dark')
  })

  it('reads the background out of COLORFGBG, which is <foreground>;<background>', () => {
    // 15;0 is white on black — the iTerm2 and VTE spelling of a dark terminal.
    expect(detectBackground({ COLORFGBG: '15;0' })).toBe('dark')
    // 0;15 is the same terminal the other way up.
    expect(detectBackground({ COLORFGBG: '0;15' })).toBe('light')
  })

  it('counts 7 and the bright half as light, and the rest as dark', () => {
    for (const background of ['0', '1', '2', '3', '4', '5', '6', '8']) {
      expect(detectBackground({ COLORFGBG: `15;${background}` })).toBe('dark')
    }
    for (const background of ['7', '9', '10', '11', '12', '13', '14', '15']) {
      expect(detectBackground({ COLORFGBG: `0;${background}` })).toBe('light')
    }
  })

  it('takes the last field when the variable carries more than two', () => {
    // rxvt writes three; the background is still the one at the end.
    expect(detectBackground({ COLORFGBG: '0;7;15' })).toBe('light')
    expect(detectBackground({ COLORFGBG: '0;default;0' })).toBe('dark')
  })
})

describe('colorEnabled', () => {
  it('is on when NO_COLOR is not there', () => {
    expect(colorEnabled({})).toBe(true)
  })

  it('is off when NO_COLOR is set', () => {
    expect(colorEnabled({ NO_COLOR: '1' })).toBe(false)
    expect(colorEnabled({ NO_COLOR: 'anything' })).toBe(false)
  })

  it('is on for an empty NO_COLOR: an exported empty string asks for nothing', () => {
    expect(colorEnabled({ NO_COLOR: '' })).toBe(true)
  })
})

describe('resolveTerminalTheme', () => {
  it('defaults to auto: the terminal, in colour', () => {
    expect(resolveTerminalTheme('auto', { COLORFGBG: '0;15' })).toEqual({
      background: 'light',
      color: true,
    })
  })

  it('lets the config say the background outright', () => {
    expect(resolveTerminalTheme('light', { COLORFGBG: '15;0' })).toEqual({
      background: 'light',
      color: true,
    })
    expect(resolveTerminalTheme('dark', { COLORFGBG: '0;15' })).toEqual({
      background: 'dark',
      color: true,
    })
  })

  it('drops the colour, and keeps the background, under NO_COLOR', () => {
    expect(resolveTerminalTheme('light', { NO_COLOR: '1' })).toEqual({
      background: 'light',
      color: false,
    })
  })
})

describe('syntaxColor', () => {
  it('gives a scope a colour on both backgrounds, and different ones', () => {
    expect(syntaxColor(DARK, 'keyword')).toBe('#ff7b72')
    expect(syntaxColor(LIGHT, 'keyword')).toBe('#cf222e')
    expect(syntaxColor(DARK, 'comment')).not.toBe(syntaxColor(LIGHT, 'comment'))
  })

  it('names nothing for punctuation or an unknown scope', () => {
    expect(syntaxColor(DARK, 'punctuation')).toBeUndefined()
    expect(syntaxColor(DARK, 'not-a-scope')).toBeUndefined()
  })

  it('names nothing at all under NO_COLOR', () => {
    expect(syntaxColor(PLAIN, 'keyword')).toBeUndefined()
  })
})

describe('paint', () => {
  it('passes a named colour through, and drops it under NO_COLOR', () => {
    expect(paint(DARK, 'cyan')).toBe('cyan')
    expect(paint(PLAIN, 'cyan')).toBeUndefined()
    expect(paint(DARK, undefined)).toBeUndefined()
  })
})

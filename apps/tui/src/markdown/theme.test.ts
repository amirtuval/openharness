import { describe, expect, it } from 'vitest'

import {
  codePanel,
  colorEnabled,
  detectBackground,
  detectColorLevel,
  messageBand,
  paint,
  resolveTerminalTheme,
  syntaxColor,
  type TerminalTheme,
} from './theme'

const DARK: TerminalTheme = { background: 'dark', color: true, level: 3 }
const LIGHT: TerminalTheme = { background: 'light', color: true, level: 3 }
const PLAIN: TerminalTheme = { background: 'dark', color: false, level: 0 }
/** The same terminals with only the sixteen named colours: no tints to draw a surface with. */
const DARK_16: TerminalTheme = { background: 'dark', color: true, level: 1 }
const LIGHT_16: TerminalTheme = { background: 'light', color: true, level: 1 }

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

describe('detectColorLevel', () => {
  it('is 24-bit when COLORTERM says so, in either of its two spellings', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' })).toBe(3)
    expect(detectColorLevel({ COLORTERM: '24bit' })).toBe(3)
    // Some terminals write it in caps, and a stray space is still the same answer.
    expect(detectColorLevel({ COLORTERM: 'TRUECOLOR' })).toBe(3)
    expect(detectColorLevel({ COLORTERM: ' 24bit ' })).toBe(3)
  })

  it('is the 256-colour palette when TERM says it is', () => {
    expect(detectColorLevel({ TERM: 'xterm-256color' })).toBe(2)
    expect(detectColorLevel({ TERM: 'screen-256color' })).toBe(2)
  })

  it('takes 24-bit over the 256-colour TERM, because it is the more colour of the two', () => {
    expect(detectColorLevel({ TERM: 'xterm-256color', COLORTERM: 'truecolor' })).toBe(3)
  })

  it('is the sixteen named colours when the terminal says nothing more', () => {
    expect(detectColorLevel({})).toBe(1)
    expect(detectColorLevel({ TERM: 'xterm' })).toBe(1)
    expect(detectColorLevel({ TERM: 'dumb' })).toBe(1)
    expect(detectColorLevel({ COLORTERM: 'yes-really' })).toBe(1)
  })

  it('is 0 under NO_COLOR, whatever the terminal could have shown', () => {
    expect(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe(0)
    // An exported empty string asks for nothing, the rule `colorEnabled` already carries.
    expect(detectColorLevel({ NO_COLOR: '', COLORTERM: 'truecolor' })).toBe(3)
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
  it('defaults to auto: the terminal, in the colour it can show', () => {
    expect(resolveTerminalTheme('auto', { COLORFGBG: '0;15', COLORTERM: 'truecolor' })).toEqual({
      background: 'light',
      color: true,
      level: 3,
    })
    expect(resolveTerminalTheme('auto', { COLORFGBG: '15;0', TERM: 'xterm-256color' })).toEqual({
      background: 'dark',
      color: true,
      level: 2,
    })
    expect(resolveTerminalTheme('auto', {})).toEqual({ background: 'dark', color: true, level: 1 })
  })

  it('lets the config say the background outright', () => {
    expect(resolveTerminalTheme('light', { COLORFGBG: '15;0' })).toEqual({
      background: 'light',
      color: true,
      level: 1,
    })
    expect(resolveTerminalTheme('dark', { COLORFGBG: '0;15' })).toEqual({
      background: 'dark',
      color: true,
      level: 1,
    })
  })

  it('drops the colour, and keeps the background, under NO_COLOR', () => {
    expect(resolveTerminalTheme('light', { NO_COLOR: '1' })).toEqual({
      background: 'light',
      color: false,
      level: 0,
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

describe('the band a user message sits on (#229, #231)', () => {
  it('is a derived tint on a terminal that can mix one', () => {
    // The shade the pass is about: a step off the background rather than bright black, which is
    // the nearest *named* colour and is what a reader called too bright.
    expect(messageBand(DARK)).toBe('#2a2b33')
    expect(messageBand(LIGHT)).toBe('#ececf2')
  })

  it('is the nearest gray of the 256 ramp on a terminal that can mix that', () => {
    expect(messageBand({ ...DARK, level: 2 })).toBe('ansi256(236)')
    expect(messageBand({ ...LIGHT, level: 2 })).toBe('ansi256(254)')
  })

  it('is the named colour it has always been below that', () => {
    expect(messageBand(DARK_16)).toBe('blackBright')
    expect(messageBand(LIGHT_16)).toBe('white')
  })

  it('is no band at all under NO_COLOR', () => {
    expect(messageBand(PLAIN)).toBeUndefined()
  })
})

describe('the code block panel (#231)', () => {
  it('is a step toward the background, so the block reads as inset', () => {
    expect(codePanel(DARK)).toBe('#1f2026')
    expect(codePanel(LIGHT)).toBe('#f5f5f8')
    // The panel is the darker of the two on a dark terminal and the lighter on a light one.
    expect(codePanel(DARK)).not.toBe(messageBand(DARK))
    expect(codePanel(LIGHT)).not.toBe(messageBand(LIGHT))
  })

  it('is the gray next door on the 256 ramp, keeping that relationship', () => {
    expect(codePanel({ ...DARK, level: 2 })).toBe('ansi256(235)')
    expect(codePanel({ ...LIGHT, level: 2 })).toBe('ansi256(255)')
  })

  it('is nothing at all where there is no tint to draw with', () => {
    // Which is the signal `render.ts` reads to fall back to a label line and a blank one: a
    // panel made of a named colour would be the heavy band this issue is about.
    expect(codePanel(DARK_16)).toBeUndefined()
    expect(codePanel(LIGHT_16)).toBeUndefined()
    expect(codePanel(PLAIN)).toBeUndefined()
  })
})

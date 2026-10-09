import { createFakeClient } from '@openharness/client/testing'
import { makeMode, makeModelEntry, makeProviderCredential } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { waitFor } from '../test-support/input'
import {
  CHAT_COMMANDS,
  CHAT_KEYS,
  chatReferenceLines,
  closestCommand,
  commandQuery,
  commandUsage,
  currentModelOf,
  filterCommands,
  findCommand,
  parseChatInput,
  unknownCommandNotice,
  type ChatCommand,
  type CommandContext,
} from './commands'
import { createChatSession, type ChatSession } from './session'

/** A registry the assertions can talk about, with an argument hint and an alias in it. */
const MODEL: ChatCommand = { name: 'model', description: 'pick a model', run: () => undefined }
const MODE: ChatCommand = {
  name: 'mode',
  description: 'pick a mode',
  args: '<mode>',
  run: () => undefined,
}
const EXIT_COMMAND: ChatCommand = {
  name: 'exit',
  aliases: ['quit'],
  description: 'leave',
  run: () => undefined,
}
const COMMANDS: readonly ChatCommand[] = [MODEL, MODE, EXIT_COMMAND]

/** A chat session over the fake client, which is what a command's context takes. */
function chatSession(): { readonly session: ChatSession; readonly modelId: string } {
  const fake = createFakeClient({ models: [makeModelEntry({ id: 'anthropic/claude-sonnet-5' })] })
  return {
    session: createChatSession({ client: fake, session: fake.session }),
    modelId: fake.session.model.id,
  }
}

/** A context whose screen-side actions are recorded rather than done. */
function fakeContext(session: ChatSession) {
  const calls = {
    picked: 0,
    newChats: [] as string[],
    providers: [] as (string | undefined)[],
    clears: 0,
    exits: 0,
    notices: [] as { readonly kind: string; readonly text: string }[],
  }
  const context: CommandContext = {
    session,
    pickModel: () => {
      calls.picked += 1
    },
    newChat: (modelId) => {
      calls.newChats.push(modelId)
    },
    setupProviders: (provider) => {
      calls.providers.push(provider)
    },
    clearScreen: () => {
      calls.clears += 1
    },
    exit: () => {
      calls.exits += 1
    },
    showNotice: (notice) => {
      calls.notices.push({ kind: notice.kind, text: notice.text })
    },
  }

  return { context, calls }
}

/** Run a registry command by name, the way the screen runs what the prompt parsed. */
async function run(name: string, context: CommandContext, args = ''): Promise<void> {
  const command = findCommand(name)
  if (command === undefined) throw new Error(`the registry lost /${name}`)
  await command.run(context, args)
}

describe('parseChatInput', () => {
  it('leaves an ordinary message alone, whitespace and all', () => {
    expect(parseChatInput('hello there', COMMANDS)).toEqual({
      kind: 'message',
      text: 'hello there',
    })
    expect(parseChatInput('  spaced  ', COMMANDS)).toEqual({
      kind: 'message',
      text: '  spaced  ',
    })
  })

  it('reads a command by name, with its arguments', () => {
    expect(parseChatInput('/model', COMMANDS)).toEqual({
      kind: 'command',
      command: MODEL,
      args: '',
    })
    expect(parseChatInput('/mode plan', COMMANDS)).toEqual({
      kind: 'command',
      command: MODE,
      args: 'plan',
    })
    expect(parseChatInput('/mode  plan  now ', COMMANDS)).toEqual({
      kind: 'command',
      command: MODE,
      args: 'plan  now',
    })
  })

  it('reads a command by its alias', () => {
    expect(parseChatInput('/quit', COMMANDS)).toEqual({
      kind: 'command',
      command: EXIT_COMMAND,
      args: '',
    })
  })

  it('still reads a command with a line ending after it', () => {
    expect(parseChatInput('/model\n', COMMANDS)).toEqual({
      kind: 'command',
      command: MODEL,
      args: '',
    })
  })

  it('sends a literal slash for //, and nothing else about the line is special', () => {
    expect(parseChatInput('//model', COMMANDS)).toEqual({ kind: 'message', text: '/model' })
    expect(parseChatInput('///x', COMMANDS)).toEqual({ kind: 'message', text: '//x' })
    // Whitespace survives: it is a message, not a command line.
    expect(parseChatInput('// spaced /model', COMMANDS)).toEqual({
      kind: 'message',
      text: '/ spaced /model',
    })
  })

  it('names an unknown command and suggests the closest one', () => {
    const parsed = parseChatInput('/modl', COMMANDS)
    expect(parsed.kind).toBe('unknown')
    expect(parsed).toMatchObject({ name: 'modl', suggestion: MODEL })
  })

  it('has nothing to suggest for a bare slash', () => {
    expect(parseChatInput('/', COMMANDS)).toMatchObject({
      kind: 'unknown',
      name: '',
      suggestion: undefined,
    })
  })

  it('a command starts the line: a leading space makes it a message', () => {
    expect(parseChatInput(' /model', COMMANDS)).toEqual({ kind: 'message', text: ' /model' })
  })
})

describe('filterCommands', () => {
  it('matches a name or an alias by prefix, ignoring case', () => {
    expect(filterCommands('', COMMANDS)).toEqual(COMMANDS)
    expect(filterCommands('mod', COMMANDS)).toEqual([MODEL, MODE])
    expect(filterCommands('model', COMMANDS)).toEqual([MODEL])
    expect(filterCommands('qu', COMMANDS)).toEqual([EXIT_COMMAND])
    expect(filterCommands('MODEL', COMMANDS)).toEqual([MODEL])
  })

  it('offers nothing for a query no command starts with', () => {
    expect(filterCommands('zzz', COMMANDS)).toEqual([])
  })
})

describe('closestCommand', () => {
  it('finds the command a typo was meant to be', () => {
    expect(closestCommand('modl', COMMANDS)).toBe(MODEL)
    expect(closestCommand('quit', COMMANDS)).toBe(EXIT_COMMAND)
  })

  it('has nothing to suggest for an empty name', () => {
    expect(closestCommand('', COMMANDS)).toBeUndefined()
  })

  it('breaks a tie with the order the registry lists them in', () => {
    const tie: readonly ChatCommand[] = [
      { name: 'aaa', description: 'a', run: () => undefined },
      { name: 'bbb', description: 'b', run: () => undefined },
    ]
    expect(closestCommand('ccc', tie)).toBe(tie[0])
  })
})

describe('commandQuery', () => {
  it('is the word a / line is completing', () => {
    expect(commandQuery('/')).toBe('')
    expect(commandQuery('/mo')).toBe('mo')
    expect(commandQuery('/model')).toBe('model')
  })

  it('is null once the line is not a command line', () => {
    expect(commandQuery('')).toBeNull()
    expect(commandQuery('hello')).toBeNull()
    expect(commandQuery('//model')).toBeNull()
    expect(commandQuery('/model x')).toBeNull()
    expect(commandQuery('/model\n')).toBeNull()
  })
})

describe('the registry', () => {
  it('names every command once, without a slash', () => {
    const names = CHAT_COMMANDS.map((command) => command.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).not.toContain('/')
      expect(name).not.toContain(' ')
    }
  })

  it('describes every command, and keeps aliases distinct from names', () => {
    for (const command of CHAT_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0)
      for (const alias of command.aliases ?? []) {
        expect(command.name).not.toBe(alias)
        expect(findCommand(alias)).toBe(command)
      }
    }
  })

  it('lists everyone it names, with the usage column aligned', () => {
    const lines = chatReferenceLines()
    expect(lines).toHaveLength(CHAT_COMMANDS.length + CHAT_KEYS.length)

    for (const command of CHAT_COMMANDS) {
      expect(lines.some((line) => line.startsWith(`${commandUsage(command)}  `))).toBe(true)
    }
    expect(lines.some((line) => line.startsWith('Ctrl+C'))).toBe(true)

    // One column for every description, whatever the label: each is padded out to the
    // widest label the reference has, and then the list's own two spaces.
    const width = Math.max(
      ...CHAT_COMMANDS.map((command) => commandUsage(command).length),
      ...CHAT_KEYS.map((key) => key.keys.length),
    )
    for (const line of lines) {
      expect(line.slice(width, width + 2)).toBe('  ')
      expect(line.slice(width + 2).length).toBeGreaterThan(0)
    }
  })

  it('writes the arguments and aliases of a command into its usage', () => {
    expect(commandUsage(MODEL)).toBe('/model')
    expect(commandUsage(MODE)).toBe('/mode <mode>')
    expect(commandUsage(EXIT_COMMAND)).toBe('/exit (/quit)')
  })
})

describe('running a command', () => {
  it('/model asks the screen for the picker, and touches nothing else', async () => {
    const { session } = chatSession()
    const { context, calls } = fakeContext(session)

    await run('model', context)

    expect(calls.picked).toBe(1)
    expect(calls).toMatchObject({ newChats: [], clears: 0, exits: 0, notices: [] })
  })

  it('/new starts a chat on the current model', async () => {
    const { session, modelId } = chatSession()
    const { context, calls } = fakeContext(session)

    await run('new', context)

    expect(calls.newChats).toEqual([modelId])
  })

  it('/clear clears the screen', async () => {
    const { session } = chatSession()
    const { context, calls } = fakeContext(session)

    await run('clear', context)

    expect(calls.clears).toBe(1)
  })

  it('/providers opens the connect flow on the list (#210)', async () => {
    const { session } = chatSession()
    const { context, calls } = fakeContext(session)

    await run('providers', context)

    expect(calls.providers).toEqual([undefined])
  })

  it('/providers with a provider starts on that provider’s form', async () => {
    const { session } = chatSession()
    const { context, calls } = fakeContext(session)

    await run('providers', context, 'anthropic')

    // The name is trimmed and passed through; the flow rejects one nobody knows the same way
    // the credentials API does — by asking for a key and letting the server answer.
    expect(calls.providers).toEqual(['anthropic'])
  })

  it('/help prints the commands and the keys', async () => {
    const { session } = chatSession()
    const { context, calls } = fakeContext(session)

    await run('help', context)

    expect(calls.notices).toHaveLength(1)
    expect(calls.notices[0]).toMatchObject({ kind: 'info', text: 'Commands and keys' })
  })

  it('/exit leaves', async () => {
    const { session } = chatSession()
    const { context, calls } = fakeContext(session)

    await run('exit', context)

    expect(calls.exits).toBe(1)
  })
})

describe('currentModelOf', () => {
  it('is the model the session was created with', () => {
    const { session, modelId } = chatSession()

    expect(currentModelOf(session)).toBe(modelId)
  })

  it('is the pick that no message has carried yet', () => {
    const { session } = chatSession()

    session.setModel('openai/gpt-4.1-mini')

    expect(currentModelOf(session)).toBe('openai/gpt-4.1-mini')
  })

  it('is the model the log last said the session runs, once the pick has been sent', async () => {
    const fake = createFakeClient()
    fake.respondWith('Answered on the other model.')
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    session.setModel('openai/gpt-4.1-mini')
    await session.send('Hello.')
    await fake.waitForIdle()
    await waitFor(() => currentModelOf(session) === 'openai/gpt-4.1-mini', {
      describe: () => `still ${currentModelOf(session)}`,
    })

    session.dispose()
  })

  it('is the model a mode resolves to, after a mid-chat mode switch (#267)', async () => {
    // The mode-carrying message names no model, so nothing but the reply's own span (`meta.model`)
    // says which model the chat now runs — the session the chat was opened from is a snapshot,
    // exactly as the CLI opens one.
    const mode = makeMode({ name: 'qa-cli-fast', model: 'openai/gpt-4.1-mini' })
    const fake = createFakeClient({
      modes: [mode],
      models: [makeModelEntry({ id: 'openai/gpt-4.1-mini' })],
      credentials: [makeProviderCredential({ name: 'openai' })],
    })
    fake.respondWith('Following the mode.')
    const opened = await fake.sessions.get(fake.session.id)
    const session = createChatSession({ client: fake, session: opened })
    await session.start()
    expect(currentModelOf(session)).toBe(opened.model.id)

    session.setMode(mode.id)
    await session.send('Go fast.')
    await fake.waitForIdle()
    // The session snapshot still names the old model; only the log moved.
    expect(session.session.model.id).toBe(opened.model.id)
    expect(session.getState().transcript.model).toBeNull()
    await waitFor(() => currentModelOf(session) === 'openai/gpt-4.1-mini', {
      describe: () => `still ${currentModelOf(session)}`,
    })

    session.dispose()
  })
})

describe('the notices commands write', () => {
  it('names an unknown command, suggests, and points at /help', () => {
    const notice = unknownCommandNotice('modl', MODEL)

    expect(notice.kind).toBe('error')
    expect(notice.text).toBe('Unknown command /modl. Did you mean /model?')
    expect(notice.hints).toEqual(['/help lists the commands.'])
  })

  it('says something readable for a bare slash', () => {
    const notice = unknownCommandNotice('', undefined)

    expect(notice.text).toBe('Unknown command.')
  })
})

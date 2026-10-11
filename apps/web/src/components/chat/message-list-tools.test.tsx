import type { TranscriptMessage, TranscriptToolCall } from '@openharness/client'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { MessageList } from './message-list'

/** A message with the fields a test cares about. */
function message(
  id: string,
  position: number,
  text: string,
  role: 'user' | 'agent',
): TranscriptMessage {
  return {
    id,
    role,
    text,
    parts: [{ type: 'text', text }],
    pending: false,
    streaming: false,
    position,
  }
}

/** A call with the fields a test cares about. */
function call(id: string, position: number, name = 'web_fetch'): TranscriptToolCall {
  return {
    id,
    name,
    input: { url: 'https://example.com' },
    permission: 'allow',
    source: 'builtin',
    status: 'done',
    position,
    result: { content: 'ok', isError: false },
  }
}

/**
 * The tool calls in the conversation (epic #303, X5; #308).
 *
 * The order comes from the client's `selectTranscriptEntries` (tested there); this file is what
 * the web draws: a run of consecutive calls as one tidy block, and a call where its event sits.
 */
describe('MessageList and tool calls (#308)', () => {
  it('draws a call between the messages around it', () => {
    render(
      <MessageList
        messages={[
          message('m1', 1, 'look this up', 'user'),
          message('m3', 3, 'It says hello.', 'agent'),
        ]}
        toolCalls={[call('t2', 2)]}
        loading={false}
      />,
    )

    expect(screen.getAllByRole('article')).toHaveLength(2)
    expect(screen.getByText('web_fetch')).toBeInTheDocument()
    // The order — user, call, reply — is the client's merge (tested there); what this asserts is
    // that a lone call draws as a bare line rather than as a group of one.
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('groups several calls in a row into one tidied block', () => {
    render(
      <MessageList
        messages={[message('m1', 1, 'do both', 'user'), message('m5', 5, 'done', 'agent')]}
        toolCalls={[
          call('t2', 2, 'web_fetch'),
          call('t3', 3, 'web_search'),
          call('t4', 4, 'todo_write'),
        ]}
        loading={false}
      />,
    )

    const group = screen.getByRole('group')
    expect(within(group).getAllByText(/web_fetch|web_search|todo_write/)).toHaveLength(3)
    // One block, not three: the grouping is what makes a step read as one piece of work.
    expect(screen.getAllByRole('group')).toHaveLength(1)
  })

  it('starts a new group when a message sits between two runs of calls', () => {
    render(
      <MessageList
        messages={[message('m3', 3, 'and now?', 'user')]}
        toolCalls={[
          call('t1', 1, 'web_fetch'),
          call('t2', 2, 'web_search'),
          call('t4', 4, 'todo_write'),
          call('t5', 5, 'echo'),
        ]}
        loading={false}
      />,
    )

    expect(screen.getAllByRole('group')).toHaveLength(2)
  })

  it('leaves a lone call as a bare line rather than a group of one', () => {
    render(
      <MessageList
        messages={[message('m1', 1, 'go', 'user')]}
        toolCalls={[call('t2', 2)]}
        loading={false}
      />,
    )

    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByText('web_fetch')).toBeInTheDocument()
  })

  it('draws the tool notices at the foot with the transcript', () => {
    render(
      <MessageList
        messages={[message('m1', 1, 'hi', 'user')]}
        toolCalls={[]}
        stepLimit="This turn reached its limit of 50 model requests."
        toolsUnsupported
        truncatedResults="One tool result was shortened."
        clearedResults="Two older tool results were cleared."
        loading={false}
      />,
    )

    expect(
      screen.getByText('This turn reached its limit of 50 model requests.'),
    ).toBeInTheDocument()
    expect(screen.getByText("This model can't use tools.")).toBeInTheDocument()
    expect(screen.getByText('One tool result was shortened.')).toBeInTheDocument()
    expect(screen.getByText('Two older tool results were cleared.')).toBeInTheDocument()
  })
})

/**
 * The prompts a waiting call is owed (epic #303, X6; #310).
 *
 * The words and the events come from `@openharness/client` (tested there); this is what the
 * conversation draws: the prompt under its own call, the decision an answered call shows, and
 * the bar that answers several approvals at once.
 */
describe('MessageList and a waiting call (#310)', () => {
  /** A call waiting on the reader: `ask` is what makes it a pause. */
  function waiting(id: string, position: number, name = 'web_fetch'): TranscriptToolCall {
    return {
      id,
      name,
      input: { url: 'https://example.com' },
      permission: 'ask',
      source: 'builtin',
      status: 'waiting',
      position,
    }
  }

  it('draws the approval prompt under the call it belongs to', () => {
    render(
      <MessageList
        messages={[]}
        toolCalls={[waiting('t1', 1)]}
        loading={false}
        onRespond={() => {}}
      />,
    )

    const prompt = within(screen.getByRole('group', { name: 'Allow web_fetch?' }))
    expect(prompt.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
  })

  it('answers the call the reader decided about', async () => {
    const responded: unknown[] = []
    render(
      <MessageList
        messages={[]}
        toolCalls={[waiting('t1', 1)]}
        loading={false}
        onRespond={(events) => responded.push(...events)}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Always allow' }))

    expect(responded).toEqual([
      { type: 'user.tool_confirmation', tool_use_id: 't1', result: 'allow', remember: 'always' },
    ])
  })

  it('draws the form for an ask_user call, with its questions', () => {
    const call: TranscriptToolCall = {
      ...waiting('t1', 1, 'ask_user'),
      input: { questions: [{ type: 'confirm', question: 'Go ahead?', header: 'Go' }] },
    }
    render(<MessageList messages={[]} toolCalls={[call]} loading={false} onRespond={() => {}} />)

    const form = within(screen.getByRole('form', { name: 'Questions from ask_user' }))
    expect(form.getByText('Go ahead?')).toBeInTheDocument()
    expect(form.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
    expect(form.getByRole('button', { name: 'Decline' })).toBeInTheDocument()
  })

  it('shows the decision an answered call was made under, and no prompt', () => {
    render(
      <MessageList
        messages={[]}
        toolCalls={[waiting('t1', 1)]}
        loading={false}
        confirmations={[{ toolUseId: 't1', result: 'allow', remember: 'session', seq: 3 }]}
        onRespond={() => {}}
      />,
    )

    expect(screen.getByText('Allowed for this chat')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
  })

  it('says a confirmation is in flight before the log has echoed it', () => {
    render(
      <MessageList
        messages={[]}
        toolCalls={[waiting('t1', 1)]}
        loading={false}
        answering={['t1']}
        onRespond={() => {}}
      />,
    )

    expect(screen.getByText('Answering…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled()
  })

  it('answers several approvals together, one event each', async () => {
    const responded: unknown[] = []
    render(
      <MessageList
        messages={[]}
        toolCalls={[waiting('t1', 1), waiting('t2', 2, 'web_search')]}
        loading={false}
        onRespond={(events) => responded.push(...events)}
      />,
    )

    expect(screen.getByText('2 calls are waiting on you.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Deny all' }))

    expect(responded).toEqual([
      { type: 'user.tool_confirmation', tool_use_id: 't1', result: 'deny' },
      { type: 'user.tool_confirmation', tool_use_id: 't2', result: 'deny' },
    ])
  })

  it('leaves a single approval to its own prompt rather than a bar of its own', () => {
    render(
      <MessageList
        messages={[]}
        toolCalls={[waiting('t1', 1)]}
        loading={false}
        onRespond={() => {}}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Deny all' })).toBeNull()
  })

  it('draws no prompt at all for a reader who cannot answer', () => {
    render(<MessageList messages={[]} toolCalls={[waiting('t1', 1)]} loading={false} />)

    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
    expect(screen.getByText('waiting for you')).toBeInTheDocument()
  })
})

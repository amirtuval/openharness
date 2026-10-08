/**
 * Real-shaped SSE bodies for the two providers whose usage shape is pinned by a test.
 *
 * `model.test.ts` streams these through the *real* provider clients — `@ai-sdk/openai` and
 * `@ai-sdk/anthropic` — with `fetch` stubbed, which is the only way to assert that the token
 * counts the brain stores are the numbers the provider's own wire format carries. A mock
 * model would prove that `toModelUsage` maps an object; these prove the object is what the
 * provider actually sends.
 *
 * Nothing here is a fixture of this repository's invention: each body is the event sequence
 * the provider's streaming API documents, in order, with the fields the client reads.
 */

/** One SSE frame: a named event whose payload is one JSON object, as both providers send. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** The `text/event-stream` response a stubbed `fetch` answers with, from SSE frames. */
function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * An Anthropic Messages stream: `message_start` with the input counts (the cache breakdown
 * included), two text deltas, and a `message_delta` carrying the final output count.
 *
 * The counts are the ones the test asserts: 11 in (2 written to cache, 3 read from it), 5 out.
 */
export function anthropicSse(): Response {
  const message = {
    id: 'msg_oh_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [] as unknown[],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 1,
    },
  }
  const body = [
    frame('message_start', { type: 'message_start', message }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hi ' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'there' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('')
  return sseResponse(body)
}

/**
 * An OpenAI Responses stream: a text item that arrives in two deltas and a `response.completed`
 * carrying the report — 11 input tokens (2 of them cached), 5 output.
 */
export function openAiResponsesSse(): Response {
  const item = {
    type: 'message',
    id: 'msg_oh_test',
    status: 'in_progress',
    role: 'assistant',
    content: [] as unknown[],
  }
  const part = { type: 'output_text', text: '', annotations: [] }
  const delta = (text: string): unknown => ({
    type: 'response.output_text.delta',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: text,
    logprobs: [],
  })
  const body = [
    frame('response.created', {
      type: 'response.created',
      sequence_number: 0,
      response: {
        id: 'resp_oh_test',
        object: 'response',
        created_at: 0,
        status: 'in_progress',
        model: 'gpt-4o-mini',
        output: [],
        parallel_tool_calls: true,
        tool_choice: 'auto',
        tools: [],
      },
    }),
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: 2,
      output_index: 0,
      item,
    }),
    frame('response.content_part.added', {
      type: 'response.content_part.added',
      sequence_number: 3,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part,
    }),
    frame('response.output_text.delta', { ...(delta('Hi ') as object), sequence_number: 4 }),
    frame('response.output_text.delta', { ...(delta('there') as object), sequence_number: 5 }),
    frame('response.output_text.done', {
      type: 'response.output_text.done',
      sequence_number: 6,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: 'Hi there',
      logprobs: [],
    }),
    frame('response.content_part.done', {
      type: 'response.content_part.done',
      sequence_number: 7,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: 'Hi there', annotations: [] },
    }),
    frame('response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: 8,
      output_index: 0,
      item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'Hi there' }] },
    }),
    frame('response.completed', {
      type: 'response.completed',
      sequence_number: 9,
      response: {
        id: 'resp_oh_test',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: 'gpt-4o-mini',
        output: [
          {
            type: 'message',
            id: item.id,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hi there', annotations: [] }],
          },
        ],
        parallel_tool_calls: true,
        tool_choice: 'auto',
        tools: [],
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }),
  ].join('')
  return sseResponse(body)
}

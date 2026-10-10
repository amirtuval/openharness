/**
 * The provider wire bodies the stub answers *model* requests with.
 *
 * The stub's list and credential-check answers are JSON, but a model request streams, and the
 * AI SDK's provider client parses an SSE body — so a test that drives a whole chat through the
 * stub (`provider-proxy.test.ts`, #270) needs one. This is the OpenAI **Responses** event
 * sequence `@ai-sdk/openai`'s client reads, the same shape `packages/brain`'s own
 * `testing/provider-streams.ts` pins against a stubbed fetch: a text item that arrives in two
 * deltas and a `response.completed` carrying the usage report.
 *
 * The numbers are deliberate: 11 input tokens (2 of them cached) and 5 output, so a test can
 * assert what the log's `span.model_request_end` summed.
 */

/** One SSE frame: a named event whose payload is one JSON object, as OpenAI sends. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** The reply text {@link openAiResponsesSseBody} streams, which a test asserts on. */
export const OPENAI_STUB_REPLY = 'Hi there'

/** An OpenAI Responses stream: two deltas of {@link OPENAI_STUB_REPLY}, then the report. */
export function openAiResponsesSseBody(): string {
  const item = {
    type: 'message',
    id: 'msg_oh_e2e',
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
  return [
    frame('response.created', {
      type: 'response.created',
      sequence_number: 0,
      response: {
        id: 'resp_oh_e2e',
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
      text: OPENAI_STUB_REPLY,
      logprobs: [],
    }),
    frame('response.content_part.done', {
      type: 'response.content_part.done',
      sequence_number: 7,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: OPENAI_STUB_REPLY, annotations: [] },
    }),
    frame('response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: 8,
      output_index: 0,
      item: {
        ...item,
        status: 'completed',
        content: [{ type: 'output_text', text: OPENAI_STUB_REPLY }],
      },
    }),
    frame('response.completed', {
      type: 'response.completed',
      sequence_number: 9,
      response: {
        id: 'resp_oh_e2e',
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
            content: [{ type: 'output_text', text: OPENAI_STUB_REPLY, annotations: [] }],
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
}

import { newEventId } from './packages/protocol/dist/index.js'
import { execFileSync } from 'node:child_process'
const SID = process.argv[2]
const id = () => newEventId()
const [run, msg, spanStart, call, result, reply, spanEnd, idle] = Array.from({length:8}, id)
const rows = [
  [run, 1, 'session.status_running', { type: 'session.status_running' }],
  [msg, 2, 'user.message', { type: 'user.message', content: [{ type: 'text', text: 'Search for the capital of France.' }] }],
  [spanStart, 3, 'span.model_request_start', { type: 'span.model_request_start', model: 'anthropic/claude-sonnet-5', consumes: [msg], tools: [{ name: 'web_search', source: 'builtin' }] }],
  [call, 4, 'agent.tool_use', { type: 'agent.tool_use', name: 'web_search', input: { query: 'capital of France' }, evaluated_permission: 'allow' }],
  [result, 5, 'agent.tool_result', { type: 'agent.tool_result', tool_use_id: call, content: [{ type: 'text', text: 'Brave Search results: Paris is the capital of France.' }], is_error: false }],
  [reply, 6, 'agent.message', { type: 'agent.message', content: [{ type: 'text', text: 'The capital of France is Paris.' }] }],
  [spanEnd, 7, 'span.model_request_end', { type: 'span.model_request_end', model_request_start_id: spanStart, model_usage: { input_tokens: 42, output_tokens: 17, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, is_error: null }],
  [idle, 8, 'session.status_idle', { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }],
]
const lit = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`
const sql = [
  'begin;',
  `delete from event_claims where session_id='${SID}';`,
  `delete from events where session_id='${SID}';`,
  ...rows.map(([id, seq, type, payload]) =>
    `insert into events (id, session_id, seq, type, payload, created_at, processed_at) values ('${id}','${SID}',${seq},'${type}',${lit(payload)},now(),'2026-10-01T00:00:00Z');`),
  `insert into event_claims (session_id, event_id, claimed_by_event_id, claimed_at) values ('${SID}','${msg}','${spanStart}','2026-10-01T00:00:00Z');`,
  'commit;',
].join('\n')
execFileSync('docker', ['exec', '-i', 'oh-postgres', 'psql', '-U', 'openharness', '-d', 'openharness_qa', '-v', 'ON_ERROR_STOP=1'], { input: sql, stdio: ['pipe', 'inherit', 'inherit'] })
console.log('inserted', SID)

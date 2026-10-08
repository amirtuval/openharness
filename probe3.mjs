import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createFireworks } from '@ai-sdk/fireworks'
import { createMistral } from '@ai-sdk/mistral'
import { createTogetherAI } from '@ai-sdk/togetherai'
import { createXai } from '@ai-sdk/xai'
import { createCerebras } from '@ai-sdk/cerebras'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
const calls = []
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url
  const headers = Object.fromEntries(Object.entries(init?.headers ?? {}))
  calls.push({ url, headers })
  return new Response(JSON.stringify({ error: { message: 'stop' } }), { status: 400, headers: { 'content-type': 'application/json' } })
}
const opts = { apiKey: 'sk-explicit-000' }
const models = [
  ['anthropic', createAnthropic(opts)('claude-haiku-4-5')],
  ['openai', createOpenAI(opts).responses('gpt-4o-mini')],
  ['google', createGoogleGenerativeAI(opts)('gemini-2.5-flash')],
  ['groq', createGroq(opts)('llama-3.3-70b-versatile')],
  ['deepseek', createDeepSeek(opts)('deepseek-chat')],
  ['fireworks', createFireworks(opts)('accounts/fireworks/models/llama-v3p1-70b-instruct')],
  ['mistral', createMistral(opts)('mistral-small-latest')],
  ['togetherai', createTogetherAI(opts)('meta-llama/Llama-3.3-70B-Instruct-Turbo')],
  ['xai', createXai(opts).responses('grok-4')],
  ['cerebras', createCerebras(opts)('llama-3.3-70b')],
  ['openrouter', createOpenAICompatible({name:'openrouter', ...opts, baseURL:'https://openrouter.ai/api/v1'}).chatModel('openai/gpt-4.1-mini')],
]
for (const [name, model] of models) {
  calls.length = 0
  try { await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }) } catch (e) { /* expected */ }
  const c = calls[0]
  const auth = c ? Object.entries(c.headers).filter(([k]) => /auth|api-key|key/i.test(k)).map(([k,v]) => `${k}: ${String(v).slice(0,24)}`) : []
  console.log(name.padEnd(12), c?.url)
  console.log('   '.padEnd(12), JSON.stringify(auth))
}

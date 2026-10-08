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
console.log('exports ok')
console.log('xai responses?', typeof createXai({apiKey:'k'}).responses)
console.log('openai responses?', typeof createOpenAI({apiKey:'k'}).responses)
const m = [
  ['anthropic', createAnthropic({apiKey:'k'})( 'claude-haiku-4-5')],
  ['openai.responses', createOpenAI({apiKey:'k'}).responses('gpt-4o-mini')],
  ['google', createGoogleGenerativeAI({apiKey:'k'})('gemini-2.5-flash')],
  ['groq', createGroq({apiKey:'k'})('llama-3.3-70b-versatile')],
  ['deepseek', createDeepSeek({apiKey:'k'})('deepseek-chat')],
  ['fireworks', createFireworks({apiKey:'k'})('accounts/fireworks/models/x')],
  ['mistral', createMistral({apiKey:'k'})('mistral-small-latest')],
  ['togetherai', createTogetherAI({apiKey:'k'})('x')],
  ['xai.responses', createXai({apiKey:'k'}).responses('grok-4')],
  ['cerebras', createCerebras({apiKey:'k'})('llama-3.3-70b')],
  ['openrouter', createOpenAICompatible({name:'openrouter', apiKey:'k', baseURL:'https://openrouter.ai/api/v1'}).chatModel('x')],
]
for (const [n, model] of m) console.log(n, '| spec:', model.specificationVersion, '| provider:', model.provider)

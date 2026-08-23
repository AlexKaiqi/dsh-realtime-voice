import z from '@deepseek-ai/schemastery'
import { voiceAgentAdapters } from './service.js'
import { registerRealtimeTransport } from './transport.js'

export const name = 'voice-agent'
export const inject = []

export const Config = z.object({
  enabled: z.boolean().default(true),
  basePath: z.string().default('/dsh-voice-agent'),
  trustedOpenAIOrigins: z.array(z.string()).default(['https://api.openai.com']),
  trustedDoubaoOrigins: z.array(z.string()).default(['wss://openspeech.bytedance.com']),
})

function validateOrigins(values, name, allowedSchemes) {
  if (!Array.isArray(values) || !values.length) throw new Error(`${name} must contain at least one trusted origin`)
  for (const value of values) {
    let parsed
    try { parsed = new URL(String(value)) } catch { throw new Error(`${name} contains an invalid origin`) }
    if (!allowedSchemes.includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`${name} entries must contain only scheme and authority`)
    }
  }
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Voice Agent config is required')
  if (config.enabled === false) return
  if (!/^\/[a-z0-9][a-z0-9/_-]*$/.test(String(config.basePath || '/dsh-voice-agent'))) throw new Error('basePath must be an absolute URL path')
  validateOrigins(config.trustedOpenAIOrigins || ['https://api.openai.com'], 'trustedOpenAIOrigins', ['https:', 'http:'])
  validateOrigins(config.trustedDoubaoOrigins || ['wss://openspeech.bytedance.com'], 'trustedDoubaoOrigins', ['wss:', 'ws:'])
}

export function apply(ctx, config) {
  validateConfig(config)
  if (config.enabled === false) return
  ctx.inject(['webServer', 'realtimeModelRuntime'], scope => {
    const disposers = voiceAgentAdapters().map(adapter => scope.realtimeModelRuntime.registerAdapter(adapter))
    if (disposers.some(dispose => typeof dispose !== 'function')) throw new Error('Realtime adapter registration must return a disposer')
    if (typeof scope.effect !== 'function') throw new Error('Voice Agent requires scope.effect lifecycle ownership')
    scope.effect(() => () => disposers.forEach(dispose => dispose()), 'dsh-voice-agent.adapters')
    registerRealtimeTransport(scope, scope.realtimeModelRuntime, config)
  })
}

export { doubaoRealtimeAdapter, openAIRealtimeAdapter, voiceAgentAdapters } from './service.js'

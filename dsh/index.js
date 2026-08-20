import z from '@deepseek-ai/schemastery'
import { RealtimeVoiceService, registeredRealtimeModels } from './service.js'
import { registerRealtimeTransport } from './transport.js'

export const name = 'realtime-voice'
export const inject = []

export const Config = z.object({
  enabled: z.boolean().default(true),
  maxContextChars: z.number().default(12000),
  basePath: z.string().default('/dsh-realtime-voice'),
})

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Realtime voice config is required')
  if (config.enabled === false) return
  if (!Number.isFinite(config.maxContextChars) || config.maxContextChars < 1000 || config.maxContextChars > 50000) {
    throw new Error('maxContextChars must be between 1000 and 50000')
  }
  if (!/^\/[a-z0-9][a-z0-9/_-]*$/.test(String(config.basePath || '/dsh-realtime-voice'))) throw new Error('basePath must be an absolute URL path')
}

export function apply(ctx, config) {
  validateConfig(config)
  if (config.enabled === false) return
  ctx.inject(['webServer', 'settings', 'credentials', 'llm'], scope => {
    const service = new RealtimeVoiceService(scope, config)
    registerRealtimeTransport(scope, service, config)
    ctx.provide('realtimeVoice', service)
  })
}

export { RealtimeVoiceService, registeredRealtimeModels }

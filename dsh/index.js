import z from '@deepseek-ai/schemastery'
import { realtimeVoiceAdapters } from './service.js'
import { registerRealtimeTransport } from './transport.js'

export const name = 'realtime-voice'
export const inject = []

export const Config = z.object({
  enabled: z.boolean().default(true),
  basePath: z.string().default('/dsh-realtime-voice'),
})

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Realtime voice config is required')
  if (config.enabled === false) return
  if (!/^\/[a-z0-9][a-z0-9/_-]*$/.test(String(config.basePath || '/dsh-realtime-voice'))) throw new Error('basePath must be an absolute URL path')
}

export function apply(ctx, config) {
  validateConfig(config)
  if (config.enabled === false) return
  ctx.inject(['webServer', 'realtimeModelRuntime'], scope => {
    const disposers = realtimeVoiceAdapters().map(adapter => scope.realtimeModelRuntime.registerAdapter(adapter))
    registerRealtimeTransport(scope, scope.realtimeModelRuntime, config)
    if (typeof scope.effect === 'function') {
      scope.effect(() => () => disposers.forEach(dispose => dispose()), 'dsh-realtime-voice.adapters')
    }
  })
}

export { doubaoRealtimeAdapter, openAIRealtimeAdapter, realtimeVoiceAdapters } from './service.js'

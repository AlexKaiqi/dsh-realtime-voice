import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeVoiceService, registeredRealtimeModels } from '../dsh/service.js'

function scope() {
  return {
    settings: { describe: () => [] },
    llm: { listProviders: () => [], listModels: async () => [] },
    credentials: { resolve: async () => undefined },
  }
}

test('discovers task-registered OpenAI and Doubao realtime models', () => {
  const routes = registeredRealtimeModels([{ ns: 'multi-model-provider', value: {
    connections: {
      openai: { provider: 'openai', credentialRef: 'OPENAI_API_KEY' },
      doubao: { provider: 'doubao-speech', credentialRefs: { apiKey: 'DOUBAO_API_KEY' } },
    },
    models: {
      'openai/realtime': { connection: 'openai', enabled: true, task: 'realtime-speech', model: 'gpt-realtime' },
      'doubao/realtime': { connection: 'doubao', enabled: true, task: 'realtime-speech', model: '1.2.6.1', profile: { protocol: 'doubao-realtime-duplex', voice: 'voice-id' } },
    },
  } }])
  assert.deepEqual(routes.map(route => route.protocol), ['openai-webrtc', 'doubao-realtime-duplex'])
  assert.equal(routes[1].credentialRef, 'DOUBAO_API_KEY')
})

test('keeps provider-selected Doubao voices even when task-model enablement is derived', () => {
  const routes = registeredRealtimeModels([{ ns: 'multi-model-provider', value: {
    connections: {
      doubao: {
        provider: 'doubao-speech',
        credentialRefs: { apiKey: 'DOUBAO_API_KEY' },
        models: [{ id: 'voice-id' }],
      },
    },
    models: {
      'doubao/realtime/voice-id': {
        connection: 'doubao', enabled: false, task: 'realtime-speech', model: '1.2.6.1',
        profile: { protocol: 'doubao-realtime-duplex', voice: 'voice-id' },
      },
    },
  } }])
  assert.deepEqual(routes.map(route => route.id), ['doubao/realtime/voice-id'])
})

test('profiles own role instructions and exact tool whitelist', () => {
  const service = new RealtimeVoiceService(scope(), { maxContextChars: 4000 })
  const dispose = service.registerProfile({
    id: 'session-assistant',
    instructions: context => `SESSION ROLE\n${context}`,
    tools: [{ type: 'function', name: 'submit_to_agent', parameters: { type: 'object' } }],
    voice: { openai: 'marin', doubao: 'doubao-voice' },
  })
  const openai = service.session({ profileId: 'session-assistant', route: { protocol: 'openai-webrtc', model: 'gpt-realtime' }, context: 'current draft' })
  assert.match(openai.instructions, /SESSION ROLE/)
  assert.deepEqual(openai.tools.map(tool => tool.name), ['submit_to_agent'])
  const doubao = service.session({ profileId: 'session-assistant', route: { protocol: 'doubao-realtime-duplex', model: '1.2.6.1' }, context: 'current draft' })
  assert.equal(doubao.session.audio.output.voice, 'doubao-voice')
  dispose()
  assert.throws(() => service.profile('session-assistant'), /Unknown/)
})

test('bounds context and rejects duplicate or unsupported profiles', () => {
  const service = new RealtimeVoiceService(scope(), { maxContextChars: 1000 })
  service.registerProfile({ id: 'pet-assistant', instructions: context => context, tools: [] })
  assert.throws(() => service.registerProfile({ id: 'pet-assistant', instructions: 'x', tools: [] }), /already registered/)
  const session = service.session({ profileId: 'pet-assistant', route: { protocol: 'openai-webrtc', model: 'gpt-realtime' }, context: 'x'.repeat(2000) })
  assert.equal(session.instructions.length, 1000)
  assert.throws(() => service.session({ profileId: 'pet-assistant', route: { protocol: 'unknown', model: 'x' } }), /Unsupported/)
})

test('selects exact routes and publishes availability without exposing credentials', async () => {
  const secret = 'never-return-this-key'
  const service = new RealtimeVoiceService({
    settings: { describe: () => [{ ns: 'multi-model-provider', value: {
      connections: { doubao: { provider: 'doubao-speech', credentialRefs: { apiKey: 'DOUBAO_API_KEY' } } },
      models: { 'doubao/realtime': { connection: 'doubao', enabled: true, task: 'realtime-speech', model: '1.2.6.1', profile: { protocol: 'doubao-realtime-duplex' } } },
    } }] },
    llm: { listProviders: () => [], listModels: async () => [] },
    credentials: { resolve: async ref => ref === 'DOUBAO_API_KEY' ? { value: secret } : undefined },
  })
  const route = await service.model('doubao/realtime', 'doubao-realtime-duplex')
  assert.equal(route.model, '1.2.6.1')
  const rows = await service.publicModels()
  assert.equal(rows[0].available, true)
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(secret))
})

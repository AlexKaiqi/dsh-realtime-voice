import assert from 'node:assert/strict'
import test from 'node:test'
import { doubaoRealtimeAdapter, openAIRealtimeAdapter, realtimeVoiceAdapters } from '../dsh/service.js'

const profile = {
  id: 'session-assistant',
  tools: [{ type: 'function', name: 'submit_to_agent', parameters: { type: 'object' } }],
  voice: { openai: 'marin', doubao: 'doubao-voice' },
}

test('exports the exact GPT and Doubao adapter ids consumed by the multi-model catalog', () => {
  assert.deepEqual(realtimeVoiceAdapters().map(adapter => adapter.id), ['openai-webrtc', 'doubao-realtime-duplex'])
})

test('assembles an OpenAI WebRTC session from runtime-owned route and role data', () => {
  const session = openAIRealtimeAdapter.session({
    route: { model: 'gpt-realtime', voice: '' },
    profile,
    instructions: 'SESSION ROLE\ncurrent draft',
  })
  assert.equal(session.model, 'gpt-realtime')
  assert.equal(session.audio.output.voice, 'marin')
  assert.deepEqual(session.tools.map(tool => tool.name), ['submit_to_agent'])
  assert.match(session.instructions, /current draft/)
})

test('assembles a Doubao Duplex session without owning model discovery or credentials', () => {
  const result = doubaoRealtimeAdapter.session({
    route: { model: '1.2.6.1', voice: 'catalog-voice' },
    profile,
    instructions: 'SESSION ROLE\ncurrent draft',
  })
  assert.equal(result.session.model, '1.2.6.1')
  assert.equal(result.session.audio.output.voice, 'doubao-voice')
  assert.deepEqual(result.session.tools.map(tool => tool.name), ['submit_to_agent'])
  assert.ok(result.session.id)
})

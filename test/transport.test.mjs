import assert from 'node:assert/strict'
import test from 'node:test'
import { callsUrl, isSameOriginUpgrade, safeUpstreamEvent } from '../dsh/transport.js'

test('normalizes OpenAI-compatible base URLs without duplicating v1', () => {
  assert.equal(callsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/realtime/calls')
  assert.equal(callsUrl('https://proxy.example.test/'), 'https://proxy.example.test/v1/realtime/calls')
})

test('accepts only same-origin browser websocket upgrades', () => {
  assert.equal(isSameOriginUpgrade({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }), true)
  assert.equal(isSameOriginUpgrade({ headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } }), false)
  assert.equal(isSameOriginUpgrade({ headers: { host: '127.0.0.1:3080' } }), false)
})

test('whitelists local Doubao events and preserves the server-owned profile on context update', () => {
  const state = { id: 'session-id', profileId: 'session-assistant', route: { protocol: 'doubao-realtime-duplex', model: '1.2.6.1' } }
  const service = {
    session(input) {
      assert.equal(input.profileId, 'session-assistant')
      return { session: { id: 'new-id', instructions: `context:${input.context}`, tools: [] } }
    },
  }
  const update = safeUpstreamEvent({ type: 'context.update', context: 'new focus' }, state, service)
  assert.equal(update.type, 'session.update')
  assert.equal(update.session.id, 'session-id')
  assert.throws(() => safeUpstreamEvent({ type: 'arbitrary.upstream.command' }, state, service), /unsupported/)
  assert.throws(() => safeUpstreamEvent({ type: 'input_audio_buffer.append', audio: '../bad' }, state, service), /invalid/)
})

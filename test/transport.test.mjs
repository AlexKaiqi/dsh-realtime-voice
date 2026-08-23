import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizeBrowserRequest,
  authorizeWebSocketRequest,
  callsUrl,
  createStartupQueue,
  isSameOriginUpgrade,
  REALTIME_WS_PROTOCOL,
  safeUpstreamEvent,
  sanitizeProviderEvent,
  transportPolicy,
  validateProviderRoute,
} from '../dsh/transport.js'

test('normalizes OpenAI-compatible base URLs without duplicating v1', () => {
  assert.equal(callsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/realtime/calls')
  assert.equal(callsUrl('https://proxy.example.test/'), 'https://proxy.example.test/v1/realtime/calls')
})

test('requires same-origin Origin and Host plus marker and Sec-Fetch-Site when present', () => {
  const valid = { headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'x-dsh-realtime-voice': '1', 'sec-fetch-site': 'same-origin' } }
  assert.equal(isSameOriginUpgrade(valid), true)
  assert.deepEqual(authorizeBrowserRequest(valid), { ok: true })
  assert.equal(authorizeBrowserRequest({ headers: { ...valid.headers, origin: 'https://evil.example' } }).ok, false)
  assert.equal(authorizeBrowserRequest({ headers: { ...valid.headers, 'sec-fetch-site': 'cross-site' } }).ok, false)
  assert.equal(authorizeBrowserRequest({ headers: { origin: valid.headers.origin, host: valid.headers.host } }).ok, false)
  assert.deepEqual(authorizeBrowserRequest({ headers: { ...valid.headers, 'x-dsh-realtime-voice': undefined, 'x-dsh-voice-agent': '1' } }), { ok: true })
})

test('authorizes browser websocket upgrades through a real WebSocket subprotocol', () => {
  const valid = {
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'sec-websocket-protocol': REALTIME_WS_PROTOCOL,
    },
  }
  assert.deepEqual(authorizeWebSocketRequest(valid), { ok: true })
  assert.deepEqual(authorizeWebSocketRequest({ headers: { ...valid.headers, 'sec-websocket-protocol': 'dsh-voice-agent-v1' } }), { ok: true })
  assert.equal(authorizeWebSocketRequest({ headers: { ...valid.headers, 'sec-websocket-protocol': '' } }).ok, false)
  assert.equal(authorizeWebSocketRequest({ headers: { ...valid.headers, origin: 'https://evil.example' } }).ok, false)
})

test('validates route identity and official origins before credentials are used', () => {
  const policy = transportPolicy()
  const openaiRoute = { model: 'gpt-realtime', provider: 'openai', protocol: 'openai-webrtc', adapter: 'openai-webrtc' }
  const doubaoRoute = { model: '1.2.6.1', provider: 'doubao-speech', protocol: 'doubao-realtime-duplex', adapter: 'doubao-realtime-duplex' }
  const openai = validateProviderRoute(openaiRoute, 'openai-webrtc', policy)
  assert.equal(openai.baseURL, 'https://api.openai.com/v1')
  assert.throws(() => validateProviderRoute({ ...openaiRoute, provider: 'other' }, 'openai-webrtc', policy), /provider/)
  assert.throws(() => validateProviderRoute({ ...openaiRoute, baseURL: 'https://proxy.example/v1' }, 'openai-webrtc', policy), /not trusted/)
  assert.throws(() => validateProviderRoute({ ...doubaoRoute, endpoint: 'ws://openspeech.bytedance.com/path' }, 'doubao-realtime-duplex', policy), /WSS/)
  assert.throws(() => validateProviderRoute({ ...openaiRoute, protocol: undefined }, 'openai-webrtc', policy), /protocol/)
  assert.throws(() => validateProviderRoute({ ...openaiRoute, adapter: undefined }, 'openai-webrtc', policy), /adapter/)
  const custom = transportPolicy({ trustedOpenAIOrigins: ['http://127.0.0.1:4321'], trustedDoubaoOrigins: ['ws://127.0.0.1:4322'] })
  assert.equal(validateProviderRoute({ ...openaiRoute, baseURL: 'http://127.0.0.1:4321/v1' }, 'openai-webrtc', custom).baseURL, 'http://127.0.0.1:4321/v1')
  assert.equal(validateProviderRoute({ ...doubaoRoute, endpoint: 'ws://127.0.0.1:4322/path' }, 'doubao-realtime-duplex', custom).endpoint, 'ws://127.0.0.1:4322/path')
})

test('queues a bounded ordered startup set and rejects overflow', () => {
  const queue = createStartupQueue(2)
  queue.push({ type: 'one' })
  queue.push({ type: 'two' })
  assert.throws(() => queue.push({ type: 'three' }), /overflow/)
  const values = []
  queue.flush(event => values.push(event.type))
  assert.deepEqual(values, ['one', 'two'])
  assert.equal(queue.size, 0)
})

test('whitelists Doubao provider events and strips diagnostic blobs', () => {
  const state = { pendingToolCalls: new Set() }
  assert.deepEqual(sanitizeProviderEvent({ type: 'response.audio.delta', delta: 'AAA=', debug: { secret: true } }, state), { type: 'response.audio.delta', delta: 'AAA=' })
  assert.equal(sanitizeProviderEvent({ type: 'provider.internal.diagnostic', credentials: 'never' }, state), null)
  assert.equal(sanitizeProviderEvent({ type: 'response.audio.delta', delta: '../bad' }, state), null)
  assert.equal(sanitizeProviderEvent({ type: 'response.audio.delta', delta: 'AAAA' }, state), null)
  assert.deepEqual(sanitizeProviderEvent({ type: 'error', error: { code: 'bad', message: 'safe', request: { headers: 'hidden' } } }, state), { type: 'error', error: { code: 'bad', message: 'safe' } })
  assert.deepEqual(sanitizeProviderEvent({ type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'submit', arguments: '{}', debug: 'hidden' }, state), { type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'submit', arguments: '{}' })
  assert.equal(state.pendingToolCalls.has('call-1'), true)
  assert.equal(sanitizeProviderEvent({ type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'submit', arguments: '{}', replay: true }, state), null)
})

test('accepts Doubao function calls delivered inside an items array', () => {
  const state = { pendingToolCalls: new Set() }
  // Doubao Duplex shape: { type, items: [{ call_id, name, arguments }] }
  assert.deepEqual(sanitizeProviderEvent({ type: 'response.function_call_arguments.done', items: [{ call_id: 'call-d1', name: 'submit_to_agent', arguments: '{"draft":"hello"}' }] }, state), {
    type: 'response.function_call_arguments.done', call_id: 'call-d1', name: 'submit_to_agent', arguments: '{"draft":"hello"}',
  })
  assert.equal(state.pendingToolCalls.has('call-d1'), true)
  // Multiple calls in one event expand to an array.
  const multi = sanitizeProviderEvent({ type: 'response.function_call_arguments.done', items: [{ call_id: 'a', name: 'update_working_draft', arguments: '{}' }, { call_id: 'b', name: 'submit_to_agent', arguments: '{}' }] }, state)
  assert.deepEqual(multi, [
    { type: 'response.function_call_arguments.done', call_id: 'a', name: 'update_working_draft', arguments: '{}' },
    { type: 'response.function_call_arguments.done', call_id: 'b', name: 'submit_to_agent', arguments: '{}' },
  ])
  assert.equal(state.pendingToolCalls.has('a'), true)
  assert.equal(state.pendingToolCalls.has('b'), true)
  // Duplicate call_id inside the array is dropped.
  assert.equal(sanitizeProviderEvent({ type: 'response.function_call_arguments.done', items: [{ call_id: 'a', name: 'update_working_draft', arguments: '{}' }] }, state), null)
  // Malformed items are dropped, never forwarded.
  assert.equal(sanitizeProviderEvent({ type: 'response.function_call_arguments.done', items: [{ call_id: '', name: 'x', arguments: '{}' }] }, state), null)
})

test('forwards streaming input transcription for live transcript display', () => {
  const state = { pendingToolCalls: new Set() }
  assert.deepEqual(sanitizeProviderEvent({ type: 'conversation.item.input_audio_transcription.started', delta: '你', item_id: 'i1' }, state), { type: 'conversation.item.input_audio_transcription.started', delta: '你' })
  assert.deepEqual(sanitizeProviderEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: '你好', item_id: 'i1' }, state), { type: 'conversation.item.input_audio_transcription.delta', delta: '你好' })
  assert.deepEqual(sanitizeProviderEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '你好世界', item_id: 'i1' }, state), { type: 'conversation.item.input_audio_transcription.completed', transcript: '你好世界' })
  assert.equal(sanitizeProviderEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: '', item_id: 'i1' }, state), null)
  assert.equal(sanitizeProviderEvent({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'i1' }, state), null)
})

test('accepts exactly one result for each pending upstream tool call', () => {
  const state = {
    id: 'session-id',
    profileId: 'session-assistant',
    route: { protocol: 'doubao-realtime-duplex', model: '1.2.6.1' },
    pendingToolCalls: new Set(['call-1']),
  }
  const service = { session() { return { session: { id: 'new-id', tools: [] } } } }
  const result = safeUpstreamEvent({ type: 'tool.result', call_id: 'call-1', output: 'done' }, state, service)
  assert.equal(result.items[0].call_id, 'call-1')
  assert.equal(safeUpstreamEvent({ type: 'response.create' }, state, service).type, 'response.create')
  assert.throws(() => safeUpstreamEvent({ type: 'tool.result', call_id: 'call-1', output: 'again' }, state, service), /pending/)
  assert.throws(() => safeUpstreamEvent({ type: 'tool.result', call_id: 'unknown', output: 'no' }, state, service), /pending/)
})

test('maps a provider-neutral preview to a fixed microphone-free Doubao audio turn', () => {
  const events = safeUpstreamEvent({ type: 'preview.speak', text: '你好，我是试听声音。' }, { pendingToolCalls: new Set() }, {})
  assert.equal(events.length, 21)
  assert.equal(events.at(-1).type, 'input_audio_buffer.commit')
  const chunks = events.slice(0, -1)
  assert.equal(chunks.every(event => event.type === 'input_audio_buffer.append'), true)
  assert.equal(chunks.every(event => /^[A-Za-z0-9+/]+={0,2}$/.test(event.audio)), true)
  assert.equal(chunks.reduce((total, event) => total + Buffer.from(event.audio, 'base64').length, 0), 63894)
  assert.throws(() => safeUpstreamEvent({ type: 'preview.speak', text: '' }, { pendingToolCalls: new Set() }, {}), /required/)
  assert.equal(safeUpstreamEvent({ type: 'preview.speak', text: 'x'.repeat(501) }, { pendingToolCalls: new Set() }, {}).at(-1).type, 'input_audio_buffer.commit')
})

test('keeps a pending tool call retryable when its result is invalid', () => {
  const state = {
    id: 'session-id',
    profileId: 'session-assistant',
    route: { protocol: 'doubao-realtime-duplex', model: '1.2.6.1' },
    pendingToolCalls: new Set(['call-1']),
  }
  assert.throws(
    () => safeUpstreamEvent({ type: 'tool.result', call_id: 'call-1', output: 'x'.repeat(64 * 1024 + 1) }, state, {}),
    /invalid tool result/,
  )
  assert.equal(state.pendingToolCalls.has('call-1'), true)
})

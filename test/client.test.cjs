const assert = require('node:assert/strict')
const test = require('node:test')
const { REALTIME_WS_PROTOCOL, RealtimeHandle, RealtimeVoiceService, normalizeProviderEvent, normalizeMediaError } = require('../client/client.js')

test('exports the browser websocket subprotocol used by the Host authorization fence', () => {
  assert.equal(REALTIME_WS_PROTOCOL, 'dsh-realtime-voice-v1')
})

test('constructs against the Cordis class-based Service contract', () => {
  const provided = []
  const ctx = { reflect: { provide(name, service) { provided.push([name, service]) } } }
  const service = new RealtimeVoiceService(ctx, { root: {}, basePath: '/voice' })
  assert.equal(service.name, 'realtimeVoice')
  assert.equal(service.basePath, '/voice')
  assert.deepEqual(provided, [['realtimeVoice', service]])
  service.dispose()
})

test('normalizes provider events to the public service contract', () => {
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'session.created' }), { type: 'status', connected: true, status: 'connected' })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'session.ready' }), { type: 'status', connected: true, status: 'ready' })
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'input_audio_buffer.speech_started' }), { type: 'phase', phase: 'listening' })
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'response.created' }), { type: 'phase', phase: 'thinking' })
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'response.output_audio.delta' }), { type: 'phase', phase: 'speaking' })
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' }), { type: 'transcript', role: 'input', source: 'input', text: 'hello', final: true })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'conversation.item.input_audio_transcription.delta', delta: 'hel' }), { type: 'transcript', role: 'input', source: 'input', text: 'hel', final: false })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'conversation.item.input_audio_transcription.started', delta: 'h' }), { type: 'transcript', role: 'input', source: 'input', text: 'h', final: false })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'response.output_text.delta', delta: 'answer' }), { type: 'transcript', role: 'output', source: 'output', text: 'answer', final: false })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'tool', arguments: '{}' }), { type: 'tool', callId: 'c1', name: 'tool', arguments: '{}' })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'error', error: { code: 'bad', message: 'failed' } }), { type: 'error', code: 'bad', message: 'failed', recoverable: true })
  assert.equal(normalizeProviderEvent('openai-webrtc', { type: 'provider.internal' }), null)
})

test('media errors normalize to stable localizable codes and canonical messages', () => {
  const notFound = new Error('Requested device not found')
  notFound.name = 'NotFoundError'
  const normalizedNotFound = normalizeMediaError(notFound)
  assert.equal(normalizedNotFound.code, 'mic_not_found')
  assert.equal(normalizedNotFound.message, 'No microphone input device was found. Check your system input devices or connect a headset.')
  const denied = new Error('Permission denied')
  denied.name = 'NotAllowedError'
  assert.equal(normalizeMediaError(denied).code, 'mic_permission_denied')
  const unreadable = new Error('hardware unavailable')
  unreadable.name = 'NotReadableError'
  assert.equal(normalizeMediaError(unreadable).code, 'mic_unreadable')
  const unrelated = new Error('network failed')
  assert.equal(normalizeMediaError(unrelated), unrelated)
  assert.equal(unrelated.code, undefined)
  assert.equal(unrelated.message, 'network failed')
})

test('media errors normalize without mutating a read-only code getter (DOMException)', () => {
  const notFound = {
    name: 'NotFoundError',
    message: 'Requested device not found',
    get code() { return 8 },
  }
  const normalized = normalizeMediaError(notFound)
  assert.notEqual(normalized, notFound)
  assert.equal(normalized.code, 'mic_not_found')
  assert.equal(normalized.message, 'No microphone input device was found. Check your system input devices or connect a headset.')
  assert.equal(notFound.code, 8, 'the original DOMException-like object is untouched')
})

test('realtime handle replays startup events emitted before the first subscriber', () => {
  const handle = new RealtimeHandle('openai-webrtc')
  handle.emit({ type: 'phase', phase: 'connecting' })
  handle.emit({ type: 'status', connected: true, status: 'ready' })
  handle.emit({ type: 'phase', phase: 'listening' })
  const first = []
  const second = []
  handle.subscribe(event => first.push(event))
  handle.subscribe(event => second.push(event))
  assert.deepEqual(first, [
    { type: 'phase', phase: 'connecting' },
    { type: 'status', connected: true, status: 'ready' },
    { type: 'phase', phase: 'listening' },
  ])
  assert.deepEqual(second, [])
})

test('realtime handle exposes contract methods and disposes owned resources once', () => {
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  const sent = []
  const events = []
  let cleanups = 0
  let playbackCancels = 0
  handle.send = event => sent.push(event)
  handle.cancelPlayback = () => { playbackCancels += 1 }
  handle.own(() => { cleanups += 1 })
  const unsubscribe = handle.subscribe(event => events.push(event))
  handle.updateContext('context')
  handle.resolveTool('call-1', { ok: true }, { continueResponse: true })
  handle.interrupt()
  assert.deepEqual(sent, [
    { type: 'context.update', context: 'context' },
    { type: 'tool.result', call_id: 'call-1', output: '{"ok":true}' },
    { type: 'response.create' },
    { type: 'response.cancel' },
  ])
  assert.deepEqual(events, [{ type: 'interrupted' }])
  assert.equal(playbackCancels, 1)
  unsubscribe()
  handle.close()
  handle.close()
  assert.equal(cleanups, 1)
  assert.throws(() => handle.updateContext('late'), /closed/)
})

test('late-callback generation guard is invalidated by close', () => {
  const handle = new RealtimeHandle('openai-webrtc')
  let calls = 0
  const callback = handle.guard(() => { calls += 1 })
  callback()
  handle.close()
  callback()
  assert.equal(calls, 1)
})

test('OpenAI startup replays readiness, interrupts playback, and cleans resources', async () => {
  const sent = []
  const channel = {
    readyState: 1,
    send(value) { sent.push(JSON.parse(value)) },
    close() { this.closed = true },
  }
  const track = { stop() { this.stopped = true } }
  const stream = { getTracks: () => [track] }
  const remoteStream = { remote: true }
  const audio = {
    srcObject: null,
    pause() { this.paused = (this.paused || 0) + 1 },
    play() { this.played = (this.played || 0) + 1; return Promise.resolve() },
    remove() { this.removed = true },
  }
  let peer
  class Peer {
    constructor() { peer = this }
    addTrack() {}
    createDataChannel() { return channel }
    async createOffer() { return { sdp: 'v=0' } }
    async setLocalDescription() {}
    async setRemoteDescription() { channel.onopen() }
    close() { this.closed = true }
  }
  const service = Object.create(RealtimeVoiceService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    RTCPeerConnection: Peer,
    document: { createElement: () => audio },
    MediaStream: function () {},
    fetch: async () => ({ ok: true, text: async () => 'v=0' }),
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  const handle = await service.open({ protocol: 'openai-webrtc', profileId: 'session-assistant', ownerId: 'session-assistant:s1' })
  const events = []
  handle.subscribe(event => events.push(event))
  assert.deepEqual(events, [
    { type: 'phase', phase: 'connecting' },
    { type: 'status', connected: true, status: 'ready' },
    { type: 'phase', phase: 'listening' },
  ])
  peer.ontrack({ streams: [remoteStream] })
  assert.equal(audio.srcObject, remoteStream)
  handle.interrupt()
  assert.equal(audio.srcObject, null)
  assert.equal(sent.at(-1).type, 'response.cancel')
  channel.onmessage({ data: JSON.stringify({ type: 'response.output_audio.delta' }) })
  assert.equal(audio.srcObject, remoteStream)
  handle.close()
  assert.equal(track.stopped, true)
  assert.equal(peer.closed, true)
  assert.equal(channel.closed, true)
  assert.equal(audio.removed, true)
  assert.equal(service.inputLease, null)
})

test('output-only OpenAI preview sends one text turn without microphone access', async () => {
  const sent = []
  const channel = { readyState: 1, send(value) { sent.push(JSON.parse(value)) }, close() {} }
  let transceiver
  class Peer {
    addTransceiver(kind, options) { transceiver = { kind, options } }
    createDataChannel() { return channel }
    async createOffer() { return { sdp: 'v=0' } }
    async setLocalDescription() {}
    async setRemoteDescription() { channel.onopen() }
    close() {}
  }
  const service = Object.create(RealtimeVoiceService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('microphone must not be requested') } } },
    RTCPeerConnection: Peer,
    document: { createElement: () => ({ pause() {}, play() { return Promise.resolve() }, remove() {} }) },
    fetch: async () => ({ ok: true, text: async () => 'v=0' }),
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  const handle = await service.open({ protocol: 'openai-webrtc', outputOnly: true, previewText: 'Hello preview' })
  const events = []
  handle.subscribe(event => events.push(event))
  assert.deepEqual(transceiver, { kind: 'audio', options: { direction: 'recvonly' } })
  assert.deepEqual(sent, [
    { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello preview' }] } },
    { type: 'response.create' },
  ])
  assert.deepEqual(events.map(event => event.phase || event.status), ['connecting', 'ready', 'thinking'])
  handle.close()
})

test('OpenAI startup failure closes already allocated browser resources', async () => {
  const track = { stop() { this.stopped = true } }
  const channel = { readyState: 1, send() {}, close() { this.closed = true } }
  let peer
  class Peer {
    constructor() { peer = this }
    addTrack() {}
    createDataChannel() { return channel }
    async createOffer() { return { sdp: 'v=0' } }
    async setLocalDescription() {}
    close() { this.closed = true }
  }
  const audio = { pause() {}, remove() { this.removed = true } }
  const service = Object.create(RealtimeVoiceService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
    RTCPeerConnection: Peer,
    document: { createElement: () => audio },
    fetch: async () => { throw new Error('network failed') },
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  await assert.rejects(() => service.open({ protocol: 'openai-webrtc' }), /network failed/)
  assert.equal(track.stopped, true)
  assert.equal(peer.closed, true)
  assert.equal(channel.closed, true)
  assert.equal(audio.removed, true)
  assert.equal(service.handles.size, 0)
})

test('missing microphone surfaces as a normalized mic_not_found rejection', async () => {
  const notFound = new Error('Requested device not found')
  notFound.name = 'NotFoundError'
  const service = Object.create(RealtimeVoiceService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => { throw notFound } } },
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  await assert.rejects(() => service.open({ protocol: 'doubao-realtime-duplex' }), error => {
    assert.equal(error.code, 'mic_not_found')
    assert.match(error.message, /No microphone input device was found/)
    return true
  })
  assert.equal(service.handles.size, 0)
})

test('doubao duplex drops the OpenAI-only response.create after a tool result', async () => {
  const sent = []
  let socket
  class WSocket {
    constructor() { this.readyState = 1; socket = this }
    send(value) { sent.push(JSON.parse(value)) }
    close() { this.closed = true }
  }
  function AudioContext() { this.currentTime = 0 }
  AudioContext.prototype.createBuffer = function () { return { getChannelData: () => new Float32Array(0), duration: 0 } }
  AudioContext.prototype.createBufferSource = function () { return { buffer: null, connect() {}, start() {}, onended: null } }
  AudioContext.prototype.createMediaStreamSource = function () { return { connect() {} } }
  AudioContext.prototype.createScriptProcessor = function () { return { connect() {}, disconnect() {}, onaudioprocess: null } }
  AudioContext.prototype.close = function () {}
  const service = Object.create(RealtimeVoiceService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('microphone must not be requested') } } },
    AudioContext,
    WebSocket: WSocket,
    location: { protocol: 'http:', host: 'localhost:3080' },
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  const handle = await service.open({ protocol: 'doubao-realtime-duplex', outputOnly: true })
  socket.onopen()
  handle.resolveTool('call-1', { ok: true })
  assert.deepEqual(sent, [
    { type: 'session.start' },
    { type: 'tool.result', call_id: 'call-1', output: '{"ok":true}' },
  ])
  assert.equal(sent.some(event => event.type === 'response.create'), false)
  handle.close()
})

test('browser recognition error codes normalize to the same mic codes', () => {
  const recognitions = []
  class Recognition {
    constructor() { recognitions.push(this) }
    start() {}
    stop() {}
  }
  const service = Object.create(RealtimeVoiceService.prototype)
  service.root = { SpeechRecognition: Recognition }
  service.auxiliary = new Set()
  service.inputLease = null
  const errors = []
  service.recognize({ ownerId: 'session-assistant:s1', onError: event => errors.push(event) })
  recognitions[0].onerror({ error: 'audio-capture', message: 'no mic' })
  recognitions[0].onerror({ error: 'no-speech', message: 'nothing heard' })
  assert.deepEqual(errors, [
    { type: 'error', code: 'mic_not_found', message: 'No microphone input device was found. Check your system input devices or connect a headset.', recoverable: false },
    { type: 'error', code: 'no-speech', message: 'nothing heard', recoverable: true },
  ])
})

test('continuous recognition restarts after an idle end so wake-word standby survives', () => {
  const recognitions = []
  let timers = 0
  class Recognition {
    constructor() { this.starts = 0; recognitions.push(this) }
    start() { this.starts += 1 }
    stop() { this.stopped = true }
  }
  const service = Object.create(RealtimeVoiceService.prototype)
  service.root = {
    SpeechRecognition: Recognition,
    setTimeout(callback) { timers += 1; callback() },
  }
  service.auxiliary = new Set()
  service.inputLease = null
  const handle = service.recognize({ ownerId: 'session-assistant:s1:standby', continuous: true })
  assert.equal(recognitions[0].starts, 1)
  // The browser ends recognition after an idle spell; the listener must come back.
  recognitions[0].onend()
  assert.equal(timers, 1)
  assert.equal(recognitions[0].starts, 2, 'continuous listener restarts after idle end')
  // Closing the handle detaches the browser callbacks so no restart happens.
  handle.close()
  assert.equal(recognitions[0].onend, null, 'closed listener detaches onend')
  assert.equal(recognitions[0].starts, 2, 'closed listener does not restart')
  // Explicitly non-continuous recognition still closes on end.
  const single = service.recognize({ ownerId: 'session-assistant:s2', continuous: false })
  assert.equal(service.auxiliary.size, 1)
  const current = recognitions[1]
  current.onend()
  assert.equal(current.starts, 1, 'non-continuous recognition does not restart')
  assert.equal(service.auxiliary.size, 0)
  single.close()
})

test('browser capabilities expose an exclusive audio-input lease', () => {
  const recognitions = []
  class Recognition {
    constructor() { recognitions.push(this) }
    start() {}
    stop() { this.stopped = true }
  }
  const service = Object.create(RealtimeVoiceService.prototype)
  service.root = {
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia() {} } },
    RTCPeerConnection() {},
    WebSocket() {},
    AudioContext() {},
    SpeechRecognition: Recognition,
    speechSynthesis: { getVoices: () => [{ name: 'Voice A', lang: 'en-US', default: true }] },
  }
  service.auxiliary = new Set()
  service.inputLease = null
  const capabilities = service.capabilities()
  assert.equal(capabilities.secureContext, true)
  assert.equal(capabilities.realtime['openai-webrtc'], true)
  assert.equal(capabilities.realtime['doubao-realtime-duplex'], true)
  assert.deepEqual(capabilities.audioInput, { exclusive: true, busy: false, ownerId: '' })
  assert.deepEqual(capabilities.voices, [{ id: 'Voice A', name: 'Voice A', lang: 'en-US', default: true }])

  const transcripts = []
  const first = service.recognize({ ownerId: 'pet-assistant:standby', onTranscript: event => transcripts.push(event) })
  assert.throws(() => service.recognize({ ownerId: 'session-assistant:s1', onTranscript() {} }), error => error.code === 'audio_input_busy' && error.ownerId === 'pet-assistant:standby')
  assert.deepEqual(service.capabilities().audioInput, { exclusive: true, busy: true, ownerId: 'pet-assistant:standby' })
  first.close()
  const second = service.recognize({ ownerId: 'session-assistant:s1', onTranscript: event => transcripts.push(event) })
  recognitions[1].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'now active' }], { isFinal: true })] })
  assert.deepEqual(transcripts, [{ text: 'now active', final: true, resultIndex: 0 }])
  assert.equal(service.auxiliary.size, 1)
  second.close()
  assert.equal(service.auxiliary.size, 0)
  assert.equal(service.inputLease, null)
})

test('an active consumer preempts a preemptible standby recognizer', () => {
  class Recognition { start() {} stop() { this.stopped = true } }
  const service = Object.create(RealtimeVoiceService.prototype)
  service.root = { SpeechRecognition: Recognition }
  service.auxiliary = new Set()
  service.inputLease = null
  let preempted = 0
  const standby = service.recognize({ ownerId: 'pet-assistant:standby', preemptible: true, onPreempt: () => { preempted += 1 } })
  const release = service.acquireInput('session-assistant:s1')
  assert.equal(preempted, 1)
  assert.equal(service.auxiliary.size, 0)
  assert.equal(service.capabilities().audioInput.ownerId, 'session-assistant:s1')
  standby.close()
  release()
  assert.equal(service.inputLease, null)
})

test('registerTools resolves matched tool events through the executor and emits tool-result', async () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  const results = []
  const registry = service.registerTools('session-assistant:s1', {
    update_working_draft: { execute: args => ({ ok: true, draft: args.draft }) },
  })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  handle.subscribe(event => { if (event.type === 'tool-result') results.push(event) })
  const sent = []
  handle.resolveTool = (callId, result, options) => { sent.push({ callId, result, options }) }
  handle.emit({ type: 'tool', callId: 'c1', name: 'update_working_draft', arguments: '{"draft":"hello"}' })
  await Promise.resolve()
  assert.deepEqual(sent, [{ callId: 'c1', result: { ok: true, draft: 'hello' }, options: undefined }])
  assert.deepEqual(results, [{ type: 'tool-result', callId: 'c1', name: 'update_working_draft', ok: true, output: { ok: true, draft: 'hello' } }])
  registry.dispose()
})

test('a matched owner with an unknown tool name resolves an error instead of leaving the model waiting', () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerTools('session-assistant:s1', { update_working_draft: { execute: () => ({ ok: true }) } })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveTool = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'tool', callId: 'c2', name: 'submit_to_agent', arguments: '{}' })
  assert.deepEqual(sent, [{ callId: 'c2', result: { ok: false, error: 'Unknown tool: submit_to_agent' } }])
})

test('handles without a matching registry keep the legacy consumer-resolved behavior', () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerTools('pet-assistant', { ask_knowledge: { execute: () => ({ ok: true }) } })
  const handle = new RealtimeHandle('openai-webrtc')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveTool = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'tool', callId: 'c3', name: 'update_working_draft', arguments: '{}' })
  assert.deepEqual(sent, [])
})

test('async executors settle the tool result and continue the response after completion', async () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  let finish
  service.registerTools('session-assistant:s1', {
    delegate: { execute: () => new Promise(resolve => { finish = resolve }) },
  })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveTool = (callId, result, options) => sent.push({ callId, result, options })
  handle.emit({ type: 'tool', callId: 'c4', name: 'delegate', arguments: '{}' })
  assert.deepEqual(sent, [], 'no result is sent while the async executor is pending')
  finish({ ok: true, task: 't1' })
  await Promise.resolve()
  assert.deepEqual(sent, [{ callId: 'c4', result: { ok: true, task: 't1' }, options: undefined }])
})

test('control.resolve lets the executor settle first and run follow-up work afterwards', () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  const order = []
  service.registerTools('session-assistant:s1', {
    submit_to_agent: { execute: (args, control) => {
      order.push('resolve')
      control.resolve({ ok: true, draft: args.draft })
      order.push('submit')
    } },
  })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveTool = (callId, result, options) => { sent.push({ callId, result, options }) }
  handle.emit({ type: 'tool', callId: 'c5', name: 'submit_to_agent', arguments: '{"draft":"final"}' })
  assert.deepEqual(order, ['resolve', 'submit'])
  assert.deepEqual(sent, [{ callId: 'c5', result: { ok: true, draft: 'final' }, options: undefined }])
})

test('throwing executors resolve an error result instead of leaving the model waiting', () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerTools('session-assistant:s1', { boom: { execute: () => { throw new Error('action failed') } } })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveTool = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'tool', callId: 'c6', name: 'boom', arguments: '{}' })
  assert.deepEqual(sent, [{ callId: 'c6', result: { ok: false, error: 'action failed' } }])
})

test('invalid tool arguments resolve an error result', () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerTools('session-assistant:s1', { update_working_draft: { execute: () => ({ ok: true }) } })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveTool = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'tool', callId: 'c7', name: 'update_working_draft', arguments: 'not json' })
  assert.deepEqual(sent, [{ callId: 'c7', result: { ok: false, error: 'Invalid tool arguments.' } }])
})

test('registerTools validates its arguments and dispose removes the entry', () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  assert.throws(() => service.registerTools('', {}), TypeError)
  assert.throws(() => service.registerTools('owner', []), TypeError)
  assert.throws(() => service.registerTools('owner', { bad: {} }), /execute function/)
  const registry = service.registerTools('owner', { ok: { execute: () => ({ ok: true }) } })
  assert.equal(service.lookupTools('owner:x').ok, registry ? service.toolRegistries[0].tools.ok : null)
  registry.dispose()
  assert.equal(service.lookupTools('owner:x'), null)
  assert.equal(service.toolRegistries.length, 0)
})

test('async executors that never settle are resolved with a timeout instead of hanging the model', async () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerTools('session-assistant:s1', {
    never_settles: { timeoutMs: 25, execute: () => new Promise(() => {}) },
  })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  const results = []
  handle.resolveTool = (callId, result) => sent.push({ callId, result })
  handle.subscribe(event => { if (event.type === 'tool-result') results.push(event) })
  handle.emit({ type: 'tool', callId: 'c8', name: 'never_settles', arguments: '{}' })
  assert.deepEqual(sent, [], 'no result before the timeout fires')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(sent, [{ callId: 'c8', result: { ok: false, error: 'Tool execution timed out.' } }])
  // tool-result.ok means the result was delivered; the executor outcome is in output.
  assert.equal(results[0].ok, true)
  assert.equal(results[0].output.ok, false)
  assert.match(results[0].output.error, /timed out/)
})

test('timeout does not fire for sync executors or settled async executors', async () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerTools('session-assistant:s1', {
    sync_ok: { timeoutMs: 25, execute: () => ({ ok: true, fast: true }) },
    async_ok: { timeoutMs: 25, execute: async () => ({ ok: true, async: true }) },
  })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveTool = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'tool', callId: 'c9', name: 'sync_ok', arguments: '{}' })
  handle.emit({ type: 'tool', callId: 'c10', name: 'async_ok', arguments: '{}' })
  await Promise.resolve()
  assert.deepEqual(sent.map(item => item.callId), ['c9', 'c10'])
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(sent.map(item => item.callId), ['c9', 'c10'], 'no late timeout resolution may fire')
})

test('closing the handle cancels the pending timeout timer', async () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerTools('session-assistant:s1', {
    slow: { timeoutMs: 25, execute: () => new Promise(() => {}) },
  })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveTool = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'tool', callId: 'c11', name: 'slow', arguments: '{}' })
  handle.close()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(sent, [], 'no resolution after the handle is closed')
})

test('tool-result events bound large string payloads for subscribers', () => {
  const service = Object.create(RealtimeVoiceService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerTools('session-assistant:s1', {
    update_working_draft: { execute: () => ({ ok: true, draft: 'x'.repeat(20000) }) },
  })
  const handle = new RealtimeHandle('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const results = []
  handle.resolveTool = () => {}
  handle.subscribe(event => { if (event.type === 'tool-result') results.push(event) })
  handle.emit({ type: 'tool', callId: 'c12', name: 'update_working_draft', arguments: '{}' })
  assert.equal(results[0].output.draft.length, 4001, 'large strings are bounded with an ellipsis')
  assert.equal(results[0].output.ok, true)
})

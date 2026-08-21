const assert = require('node:assert/strict')
const test = require('node:test')
const { REALTIME_WS_PROTOCOL, RealtimeHandle, RealtimeVoiceService, normalizeProviderEvent } = require('../client/client.js')

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
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'response.output_text.delta', delta: 'answer' }), { type: 'transcript', role: 'output', source: 'output', text: 'answer', final: false })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'tool', arguments: '{}' }), { type: 'tool', callId: 'c1', name: 'tool', arguments: '{}' })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'error', error: { code: 'bad', message: 'failed' } }), { type: 'error', code: 'bad', message: 'failed', recoverable: true })
  assert.equal(normalizeProviderEvent('openai-webrtc', { type: 'provider.internal' }), null)
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
  const handle = await service.open({ protocol: 'openai-webrtc', profileId: 'session-assistant' })
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

test('browser capabilities and auxiliary handles are isolated', () => {
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
  const capabilities = service.capabilities()
  assert.equal(capabilities.secureContext, true)
  assert.equal(capabilities.realtime['openai-webrtc'], true)
  assert.equal(capabilities.realtime['doubao-realtime-duplex'], true)
  assert.deepEqual(capabilities.voices, [{ id: 'Voice A', name: 'Voice A', lang: 'en-US', default: true }])

  const transcripts = []
  const first = service.recognize({ onTranscript: event => transcripts.push(event) })
  const second = service.recognize({ onTranscript: event => transcripts.push(event) })
  first.close()
  recognitions[1].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'still active' }], { isFinal: true })] })
  assert.deepEqual(transcripts, [{ text: 'still active', final: true, resultIndex: 0 }])
  assert.equal(service.auxiliary.size, 1)
  second.close()
  assert.equal(service.auxiliary.size, 0)
})

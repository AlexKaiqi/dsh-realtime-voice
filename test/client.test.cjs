const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const test = require('node:test')
const { runInNewContext } = require('node:vm')
const client = require('../client/client.js')
const { REALTIME_WS_PROTOCOL, VoiceConversation, VoiceAgentService, normalizeProviderEvent, normalizeMediaError } = client

test('keeps the stable realtime-voice package and Loader name while exposing voiceAgent', () => {
  const pkg = require('../package.json')
  const source = readFileSync(require.resolve('../client/client.js'), 'utf8')
  assert.equal(pkg.name, 'dsh-realtime-voice')
  assert.equal(client.name, 'dsh-realtime-voice')
  assert.match(source, /load\(\{ id: 'dsh-realtime-voice'/)
  assert.match(source, /root\.DSHRealtimeVoice = standaloneModule\.exports/)
  const service = new VoiceAgentService({ reflect: { provide() {} } }, { root: {} })
  assert.equal(service.name, 'voiceAgent')
  service.dispose()
})

test('the standalone browser script publishes a usable global without the DSH module loader', () => {
  const source = readFileSync(require.resolve('../client/client.js'), 'utf8')
  const sandbox = { window: {} }
  runInNewContext(source, sandbox)
  assert.equal(typeof sandbox.window.DSHRealtimeVoice.VoiceAgentService, 'function')
  const service = new sandbox.window.DSHRealtimeVoice.VoiceAgentService(null, { root: sandbox.window })
  assert.equal(service.name, 'voiceAgent')
  service.dispose()
})

test('the Doubao input worklet batches transferable Float32 microphone frames', () => {
  const source = readFileSync(require.resolve('../client/audio-input-worklet.js'), 'utf8')
  let name
  let Processor
  class AudioWorkletProcessor {
    constructor() { this.port = { postMessage() {} } }
  }
  runInNewContext(source, {
    AudioWorkletProcessor,
    Float32Array,
    Number,
    sampleRate: 48000,
    registerProcessor(value, implementation) { name = value; Processor = implementation },
  })
  assert.equal(name, 'dsh-realtime-voice-input')
  const instance = new Processor({ processorOptions: { chunkFrames: 256 } })
  const messages = []
  instance.port.postMessage = (message, transfer) => messages.push({ message, transfer })
  assert.equal(instance.process([[new Float32Array(128).fill(.25)]]), true)
  assert.equal(messages.length, 0)
  instance.process([[new Float32Array(128).fill(-.25)]])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].message.sampleRate, 48000)
  assert.deepEqual(Array.from(messages[0].message.samples.slice(0, 2)), [.25, .25])
  assert.deepEqual(Array.from(messages[0].message.samples.slice(-2)), [-.25, -.25])
  assert.equal(messages[0].transfer[0], messages[0].message.samples.buffer)
})

test('a product-owned same-origin gateway keeps authorization data on its own route and emits output levels', async () => {
  const sent = []
  const sources = []
  const modules = []
  let socket
  let processor
  class WSocket {
    constructor(url, protocol) { this.url = url; this.protocol = protocol; this.readyState = 1; socket = this }
    send(value) { sent.push(JSON.parse(value)) }
    close() {}
  }
  function AudioContext() { this.currentTime = 0; this.sampleRate = 48000; this.destination = {}; this.audioWorklet = { addModule: async path => modules.push(path) } }
  AudioContext.prototype.createBuffer = function (_channels, length) { return { getChannelData: () => new Float32Array(length), duration: .02 } }
  AudioContext.prototype.createBufferSource = function () { const source = { connect() {}, start(at) { this.startedAt = at }, onended: null }; sources.push(source); return source }
  AudioContext.prototype.createMediaStreamSource = function () { return { connect() {}, disconnect() {} } }
  AudioContext.prototype.createGain = function () { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
  AudioContext.prototype.close = function () {}
  class AudioWorkletNode {
    constructor(_context, name, options) { this.name = name; this.options = options; this.port = { onmessage: null }; processor = this }
    connect() {}
    disconnect() {}
  }
  const track = { stop() {} }
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
    AudioContext,
    AudioWorkletNode,
    WebSocket: WSocket,
    location: { protocol: 'http:', host: 'localhost:3080' },
    atob: globalThis.atob,
    btoa: globalThis.btoa,
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  service.inputLease = null
  const handle = await service.startConversation({
    protocol: 'doubao-realtime-duplex',
    gateway: { path: '/persona/realtime?token=opaque', version: 1, readyEvent: 'session.created', start: { type: 'session.start', persona: 'kaiqi' } },
  })
  const events = []
  handle.subscribe(event => events.push(event))
  socket.onopen()
  assert.equal(socket.url, 'ws://localhost:3080/persona/realtime?token=opaque')
  assert.equal(socket.protocol, undefined)
  assert.deepEqual(modules, ['/dsh-realtime-voice/audio-input-worklet.js'])
  assert.equal(processor.name, 'dsh-realtime-voice-input')
  assert.deepEqual(sent, [{ version: 1, type: 'session.start', persona: 'kaiqi' }])
  const inputEvent = { data: { samples: new Float32Array(480).fill(.1), sampleRate: 48000 } }
  processor.port.onmessage(inputEvent)
  assert.equal(sent.length, 1, 'microphone audio waits for the product gateway readiness event')
  socket.onmessage({ data: JSON.stringify({ type: 'session.created' }) })
  assert.equal(events.some(event => event.type === 'status' && event.status === 'ready'), true)
  assert.equal(events.some(event => event.type === 'phase' && event.phase === 'listening'), true)
  processor.port.onmessage(inputEvent)
  assert.equal(sent.at(-1).type, 'input_audio_buffer.append')
  assert.equal(sent.at(-1).version, 1)
  const pcm = Buffer.alloc(8); pcm.writeInt16LE(16384, 0); pcm.writeInt16LE(-16384, 2); pcm.writeInt16LE(8192, 4); pcm.writeInt16LE(-8192, 6)
  socket.onmessage({ data: JSON.stringify({ type: 'response.output_audio.delta', delta: pcm.toString('base64') }) })
  assert.equal(events.some(event => event.type === 'audio-level' && event.source === 'output' && event.level > 0), true)
  assert.equal(sources.at(-1).startedAt, .12)
  assert.notEqual(handle.outputIdleTimer, null, 'a missing provider done event has a queue-aware idle fallback')
  const listeningBeforeDone = events.filter(event => event.type === 'phase' && event.phase === 'listening').length
  socket.onmessage({ data: JSON.stringify({ type: 'response.output_audio.done' }) })
  assert.equal(handle.outputIdleTimer, null)
  assert.equal(events.filter(event => event.type === 'phase' && event.phase === 'listening').length, listeningBeforeDone, 'provider completion waits for queued browser audio')
  sources.at(-1).onended()
  assert.equal(events.filter(event => event.type === 'phase' && event.phase === 'listening').length, listeningBeforeDone + 1)
  assert.deepEqual(events.slice(-2), [
    { type: 'audio-level', source: 'output', level: 0 },
    { type: 'phase', phase: 'listening' },
  ])
  handle.interrupt()
  assert.deepEqual(sent.at(-1), { version: 1, type: 'response.cancel' })
  handle.end()
  assert.equal(processor.port.onmessage, null)
})

test('rejects cross-origin or protocol-relative product gateway paths', async () => {
  function AudioContext() { this.currentTime = 0 }
  AudioContext.prototype.close = function () {}
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('microphone must not be requested') } } },
    AudioContext,
    WebSocket: class {},
    location: { protocol: 'https:', host: 'dsh.local' },
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  await assert.rejects(
    () => service.startConversation({ protocol: 'doubao-realtime-duplex', outputOnly: true, gateway: { path: '//evil.example/voice', start: { type: 'session.start' } } }),
    /same-origin absolute path/,
  )
})

test('interactive Doubao preview gates the live microphone until its injected cue is committed', async () => {
  const sent = []
  let socket
  let processor
  let microphoneRequests = 0
  class WSocket {
    constructor() { this.readyState = 1; socket = this }
    send(value) { sent.push(JSON.parse(value)) }
    close() {}
  }
  function AudioContext() {
    this.currentTime = 0
    this.sampleRate = 48_000
    this.destination = {}
    this.audioWorklet = { addModule: async () => {} }
  }
  AudioContext.prototype.createMediaStreamSource = function () { return { connect() {}, disconnect() {} } }
  AudioContext.prototype.createGain = function () { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
  AudioContext.prototype.close = function () {}
  class AudioWorkletNode {
    constructor() { this.port = { onmessage: null }; processor = this }
    connect() {}
    disconnect() {}
  }
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => { microphoneRequests += 1; return { getTracks: () => [{ stop() {} }] } } } },
    AudioContext,
    AudioWorkletNode,
    WebSocket: WSocket,
    location: { protocol: 'http:', host: 'localhost:3080' },
    btoa,
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  service.inputLease = null
  const handle = await service.startConversation({
    protocol: 'doubao-realtime-duplex',
    ownerId: 'session-assistant:preview',
    previewText: '请先打个招呼',
  })
  socket.onopen()
  socket.onmessage({ data: JSON.stringify({ type: 'session.ready' }) })
  assert.equal(microphoneRequests, 1)
  assert.equal(sent.at(-1).type, 'preview.speak')
  const frame = { data: { samples: new Float32Array(480).fill(.1), sampleRate: 48_000 } }
  processor.port.onmessage(frame)
  assert.equal(sent.some(event => event.type === 'input_audio_buffer.append'), false, 'live input cannot overlap the injected cue')
  socket.onmessage({ data: JSON.stringify({ type: 'preview.input_committed' }) })
  processor.port.onmessage(frame)
  assert.equal(sent.at(-1).type, 'input_audio_buffer.append', 'live input maintains the duplex clock after the cue')
  handle.end()
})

test('exports the browser websocket subprotocol used by the Host authorization fence', () => {
  assert.equal(REALTIME_WS_PROTOCOL, 'dsh-realtime-voice-v1')
})

test('constructs against the Cordis class-based Service contract', () => {
  const provided = []
  const ctx = { reflect: { provide(name, service) { provided.push([name, service]) } } }
  const service = new VoiceAgentService(ctx, { root: {}, basePath: '/voice' })
  assert.equal(service.name, 'voiceAgent')
  assert.equal(service.basePath, '/voice')
  assert.deepEqual(provided, [['voiceAgent', service], ['realtimeVoice', service]])
  service.dispose()
})

test('startConversation infers the provider protocol from the selected route', async () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.models = async () => [{ id: 'local/realtime-voice', protocol: 'unsupported-test-protocol' }]
  await assert.rejects(
    () => service.startConversation({ routeId: 'local/realtime-voice' }),
    /does not support a duplex Agent conversation/,
  )
})

test('normalizes provider events to the public service contract', () => {
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'session.created' }), { type: 'status', connected: true, status: 'connected' })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'session.ready' }), { type: 'status', connected: true, status: 'ready' })
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'input_audio_buffer.speech_started' }), { type: 'phase', phase: 'listening' })
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'response.created' }), { type: 'phase', phase: 'thinking' })
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'response.output_audio.started' }), { type: 'phase', phase: 'speaking' })
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'response.output_audio.delta' }), { type: 'phase', phase: 'speaking' })
  assert.deepEqual(normalizeProviderEvent('openai-webrtc', { type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' }), { type: 'transcript', role: 'input', source: 'input', text: 'hello', final: true })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'conversation.item.input_audio_transcription.delta', delta: 'hel' }), { type: 'transcript', role: 'input', source: 'input', text: 'hel', final: false })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'conversation.item.input_audio_transcription.started', delta: 'h' }), { type: 'transcript', role: 'input', source: 'input', text: 'h', final: false })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'response.output_text.delta', delta: 'answer' }), { type: 'transcript', role: 'output', source: 'output', text: 'answer', final: false })
  assert.deepEqual(normalizeProviderEvent('doubao-realtime-duplex', { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'tool', arguments: '{}' }), { type: 'action', callId: 'c1', name: 'tool', arguments: '{}' })
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
  const handle = new VoiceConversation('openai-webrtc')
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
  const handle = new VoiceConversation('doubao-realtime-duplex')
  const sent = []
  const events = []
  let cleanups = 0
  let playbackCancels = 0
  handle.send = event => sent.push(event)
  handle.cancelPlayback = () => { playbackCancels += 1 }
  handle.own(() => { cleanups += 1 })
  const unsubscribe = handle.subscribe(event => events.push(event))
  handle.updateContext('context')
  handle.resolveAction('call-1', { ok: true }, { continueResponse: true })
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
  handle.end()
  handle.end()
  assert.equal(cleanups, 1)
  assert.throws(() => handle.updateContext('late'), /closed/)
})

test('late-callback generation guard is invalidated by close', () => {
  const handle = new VoiceConversation('openai-webrtc')
  let calls = 0
  const callback = handle.guard(() => { calls += 1 })
  callback()
  handle.end()
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
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    RTCPeerConnection: Peer,
    document: { createElement: () => audio },
    MediaStream: function () {},
    fetch: async () => ({ ok: true, text: async () => 'v=0' }),
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  const handle = await service.startConversation({ protocol: 'openai-webrtc', profileId: 'session-assistant', ownerId: 'session-assistant:s1', initialUserText: '继续完成部署' })
  const events = []
  handle.subscribe(event => events.push(event))
  assert.deepEqual(events, [
    { type: 'phase', phase: 'connecting' },
    { type: 'status', connected: true, status: 'ready' },
    { type: 'phase', phase: 'thinking' },
    { type: 'transcript', role: 'input', source: 'input', text: '继续完成部署', final: true },
  ])
  assert.deepEqual(sent.slice(0, 2), [
    { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续完成部署' }] } },
    { type: 'response.create' },
  ])
  peer.ontrack({ streams: [remoteStream] })
  assert.equal(audio.srcObject, remoteStream)
  handle.interrupt()
  assert.equal(audio.srcObject, null)
  assert.equal(sent.at(-1).type, 'response.cancel')
  channel.onmessage({ data: JSON.stringify({ type: 'response.output_audio.delta' }) })
  assert.equal(audio.srcObject, remoteStream)
  handle.end()
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
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('microphone must not be requested') } } },
    RTCPeerConnection: Peer,
    document: { createElement: () => ({ pause() {}, play() { return Promise.resolve() }, remove() {} }) },
    fetch: async () => ({ ok: true, text: async () => 'v=0' }),
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  const handle = await service.startConversation({ protocol: 'openai-webrtc', outputOnly: true, previewText: 'Hello preview' })
  const events = []
  handle.subscribe(event => events.push(event))
  assert.deepEqual(transceiver, { kind: 'audio', options: { direction: 'recvonly' } })
  assert.deepEqual(sent, [
    { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello preview' }] } },
    { type: 'response.create' },
  ])
  assert.deepEqual(events.map(event => event.phase || event.status), ['connecting', 'ready', 'thinking'])
  handle.end()
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
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
    RTCPeerConnection: Peer,
    document: { createElement: () => audio },
    fetch: async () => { throw new Error('network failed') },
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  await assert.rejects(() => service.startConversation({ protocol: 'openai-webrtc' }), /network failed/)
  assert.equal(track.stopped, true)
  assert.equal(peer.closed, true)
  assert.equal(channel.closed, true)
  assert.equal(audio.removed, true)
  assert.equal(service.handles.size, 0)
})

test('missing microphone surfaces as a normalized mic_not_found rejection', async () => {
  const notFound = new Error('Requested device not found')
  notFound.name = 'NotFoundError'
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => { throw notFound } } },
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  await assert.rejects(() => service.startConversation({ protocol: 'doubao-realtime-duplex' }), error => {
    assert.equal(error.code, 'mic_not_found')
    assert.match(error.message, /No microphone input device was found/)
    return true
  })
  assert.equal(service.handles.size, 0)
})

test('doubao duplex submits initial user text once but drops the OpenAI-only response.create after a tool result', async () => {
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
  AudioContext.prototype.close = function () {}
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('microphone must not be requested') } } },
    AudioContext,
    WebSocket: WSocket,
    location: { protocol: 'http:', host: 'localhost:3080' },
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  const handle = await service.startConversation({ protocol: 'doubao-realtime-duplex', outputOnly: true, initialUserText: '打开项目状态' })
  const events = []
  handle.subscribe(event => events.push(event))
  socket.onopen()
  socket.onmessage({ data: JSON.stringify({ type: 'session.ready' }) })
  handle.resolveAction('call-1', { ok: true })
  assert.deepEqual(sent, [
    { type: 'session.start' },
    { type: 'input.text', text: '打开项目状态' },
    { type: 'tool.result', call_id: 'call-1', output: '{"ok":true}' },
  ])
  assert.equal(events.some(event => event.type === 'transcript' && event.text === '打开项目状态' && event.final), true)
  assert.equal(sent.some(event => event.type === 'response.create'), false)
  handle.end()
})

test('doubao duplex replays captured wake PCM before opening the live microphone turn', async () => {
  const sent = []
  let socket
  class WSocket {
    constructor() { this.readyState = 1; socket = this }
    send(value) { sent.push(JSON.parse(value)) }
    close() {}
  }
  function AudioContext() { this.currentTime = 0 }
  AudioContext.prototype.close = function () {}
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    atob,
    btoa,
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('microphone must not be requested') } } },
    AudioContext,
    WebSocket: WSocket,
    location: { protocol: 'http:', host: 'localhost:3080' },
  }
  service.basePath = '/dsh-realtime-voice'
  service.handles = new Set()
  const pcm24k = Buffer.alloc(4_800 * 2, 1)
  const handle = await service.startConversation({
    protocol: 'doubao-realtime-duplex',
    outputOnly: true,
    initialUserText: '你好小宠物，继续任务',
    initialAudio: { pcm16Base64: pcm24k.toString('base64'), sampleRate: 24_000 },
  })
  const events = []
  handle.subscribe(event => events.push(event))
  socket.onopen()
  socket.onmessage({ data: JSON.stringify({ type: 'session.ready' }) })
  const audioEvents = sent.filter(event => event.type === 'input_audio_buffer.append')
  assert.equal(audioEvents.length, 2)
  assert.equal(audioEvents.reduce((sum, event) => sum + Buffer.from(event.audio, 'base64').length, 0), 6_400)
  assert.equal(sent.at(-1).type, 'input_audio_buffer.commit')
  assert.equal(events.some(event => event.type === 'transcript' && event.text === '你好小宠物，继续任务' && event.final), true)
  handle.end()
})

test('wake recognition captures bounded PCM in memory and supports take/discard lifecycle', async () => {
  let processor
  const track = { stop() { this.stopped = true } }
  class Recognition { start() {} stop() { this.stopped = true } }
  function AudioContext() {
    this.sampleRate = 48_000
    this.destination = {}
    this.audioWorklet = { addModule: async () => {} }
  }
  AudioContext.prototype.createMediaStreamSource = function () { return { connect() {}, disconnect() {} } }
  AudioContext.prototype.createGain = function () { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
  AudioContext.prototype.close = function () { this.closed = true }
  class AudioWorkletNode {
    constructor() { this.port = { onmessage: null }; processor = this }
    connect() {}
    disconnect() {}
  }
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    btoa,
    SpeechRecognition: Recognition,
    AudioContext,
    AudioWorkletNode,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
  }
  service.basePath = '/dsh-realtime-voice'
  service.auxiliary = new Set()
  service.inputLease = null
  const handle = service.recognize({ ownerId: 'pet-assistant:standby', captureAudio: true })
  await new Promise(resolve => setImmediate(resolve))
  processor.port.onmessage({ data: { samples: new Float32Array(4_800).fill(.25), sampleRate: 48_000 } })
  const captured = handle.takeAudio()
  assert.equal(captured.sampleRate, 24_000)
  assert.equal(Buffer.from(captured.pcm16Base64, 'base64').length, 4_800)
  assert.equal(handle.takeAudio(), undefined)
  processor.port.onmessage({ data: { samples: new Float32Array(480).fill(.25), sampleRate: 48_000 } })
  handle.discardAudio()
  assert.equal(handle.takeAudio(), undefined)
  handle.close()
  assert.equal(track.stopped, true)
  assert.equal(service.inputLease, null)
})

test('browser recognition error codes normalize to the same mic codes', () => {
  const recognitions = []
  class Recognition {
    constructor() { recognitions.push(this) }
    start() {}
    stop() {}
  }
  const service = Object.create(VoiceAgentService.prototype)
  service.root = { SpeechRecognition: Recognition }
  service.auxiliary = new Set()
  service.inputLease = null
  const errors = []
  service.recognize({ ownerId: 'session-assistant:s1', onError: event => errors.push(event) })
  recognitions[0].onerror({ error: 'audio-capture', message: 'no mic' })
  recognitions[0].onerror({ error: 'no-speech', message: 'nothing heard' })
  recognitions[0].onerror({ error: 'network', message: '' })
  assert.deepEqual(errors, [
    { type: 'error', code: 'mic_not_found', message: 'No microphone input device was found. Check your system input devices or connect a headset.', recoverable: false },
    { type: 'error', code: 'no-speech', message: 'nothing heard', recoverable: true },
    { type: 'error', code: 'network', message: 'Browser speech recognition failed: network', recoverable: false },
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
  const service = Object.create(VoiceAgentService.prototype)
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
  const service = Object.create(VoiceAgentService.prototype)
  service.root = {
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia() {} } },
    RTCPeerConnection() {},
    WebSocket() {},
    AudioContext() {},
    AudioWorkletNode() {},
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
  const service = Object.create(VoiceAgentService.prototype)
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

test('registerActions resolves matched action events through the executor and emits action-result', async () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  const results = []
  const registry = service.registerActions('session-assistant:s1', {
    update_working_draft: { execute: args => ({ ok: true, draft: args.draft }) },
  })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  handle.subscribe(event => { if (event.type === 'action-result') results.push(event) })
  const sent = []
  handle.resolveAction = (callId, result, options) => { sent.push({ callId, result, options }) }
  handle.emit({ type: 'action', callId: 'c1', name: 'update_working_draft', arguments: '{"draft":"hello"}' })
  await Promise.resolve()
  assert.deepEqual(sent, [{ callId: 'c1', result: { ok: true, draft: 'hello' }, options: undefined }])
  assert.deepEqual(results, [{ type: 'action-result', callId: 'c1', name: 'update_working_draft', ok: true, output: { ok: true, draft: 'hello' } }])
  registry.dispose()
})

test('a matched owner with an unknown action name resolves an error instead of leaving the model waiting', () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerActions('session-assistant:s1', { update_working_draft: { execute: () => ({ ok: true }) } })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveAction = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'action', callId: 'c2', name: 'submit_to_agent', arguments: '{}' })
  assert.deepEqual(sent, [{ callId: 'c2', result: { ok: false, error: 'Unknown action: submit_to_agent' } }])
})

test('handles without a matching registry keep the legacy consumer-resolved behavior', () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerActions('pet-assistant', { ask_knowledge: { execute: () => ({ ok: true }) } })
  const handle = new VoiceConversation('openai-webrtc')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveAction = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'action', callId: 'c3', name: 'update_working_draft', arguments: '{}' })
  assert.deepEqual(sent, [])
})

test('async executors settle the tool result and continue the response after completion', async () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  let finish
  service.registerActions('session-assistant:s1', {
    delegate: { execute: () => new Promise(resolve => { finish = resolve }) },
  })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveAction = (callId, result, options) => sent.push({ callId, result, options })
  handle.emit({ type: 'action', callId: 'c4', name: 'delegate', arguments: '{}' })
  assert.deepEqual(sent, [], 'no result is sent while the async executor is pending')
  finish({ ok: true, task: 't1' })
  await Promise.resolve()
  assert.deepEqual(sent, [{ callId: 'c4', result: { ok: true, task: 't1' }, options: undefined }])
})

test('control.resolve lets the executor settle first and run follow-up work afterwards', () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  const order = []
  service.registerActions('session-assistant:s1', {
    submit_to_agent: { execute: (args, control) => {
      order.push('resolve')
      control.resolve({ ok: true, draft: args.draft })
      order.push('submit')
    } },
  })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveAction = (callId, result, options) => { sent.push({ callId, result, options }) }
  handle.emit({ type: 'action', callId: 'c5', name: 'submit_to_agent', arguments: '{"draft":"final"}' })
  assert.deepEqual(order, ['resolve', 'submit'])
  assert.deepEqual(sent, [{ callId: 'c5', result: { ok: true, draft: 'final' }, options: undefined }])
})

test('throwing executors resolve an error result instead of leaving the model waiting', () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerActions('session-assistant:s1', { boom: { execute: () => { throw new Error('action failed') } } })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveAction = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'action', callId: 'c6', name: 'boom', arguments: '{}' })
  assert.deepEqual(sent, [{ callId: 'c6', result: { ok: false, error: 'action failed' } }])
})

test('invalid tool arguments resolve an error result', () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerActions('session-assistant:s1', { update_working_draft: { execute: () => ({ ok: true }) } })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveAction = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'action', callId: 'c7', name: 'update_working_draft', arguments: 'not json' })
  assert.deepEqual(sent, [{ callId: 'c7', result: { ok: false, error: 'Invalid action arguments.' } }])
})

test('registerActions validates its arguments and dispose removes the entry', () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  assert.throws(() => service.registerActions('', {}), TypeError)
  assert.throws(() => service.registerActions('owner', []), TypeError)
  assert.throws(() => service.registerActions('owner', { bad: {} }), /execute function/)
  const registry = service.registerActions('owner', { ok: { execute: () => ({ ok: true }) } })
  assert.equal(service.lookupTools('owner:x').ok, registry ? service.toolRegistries[0].tools.ok : null)
  registry.dispose()
  assert.equal(service.lookupTools('owner:x'), null)
  assert.equal(service.toolRegistries.length, 0)
})

test('async executors that never settle are resolved with a timeout instead of hanging the model', async () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerActions('session-assistant:s1', {
    never_settles: { timeoutMs: 25, execute: () => new Promise(() => {}) },
  })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  const results = []
  handle.resolveAction = (callId, result) => sent.push({ callId, result })
  handle.subscribe(event => { if (event.type === 'action-result') results.push(event) })
  handle.emit({ type: 'action', callId: 'c8', name: 'never_settles', arguments: '{}' })
  assert.deepEqual(sent, [], 'no result before the timeout fires')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(sent, [{ callId: 'c8', result: { ok: false, error: 'Action execution timed out.' } }])
  // action-result.ok means the result was delivered; the executor outcome is in output.
  assert.equal(results[0].ok, true)
  assert.equal(results[0].output.ok, false)
  assert.match(results[0].output.error, /timed out/)
})

test('timeout does not fire for sync executors or settled async executors', async () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerActions('session-assistant:s1', {
    sync_ok: { timeoutMs: 25, execute: () => ({ ok: true, fast: true }) },
    async_ok: { timeoutMs: 25, execute: async () => ({ ok: true, async: true }) },
  })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveAction = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'action', callId: 'c9', name: 'sync_ok', arguments: '{}' })
  handle.emit({ type: 'action', callId: 'c10', name: 'async_ok', arguments: '{}' })
  await Promise.resolve()
  assert.deepEqual(sent.map(item => item.callId), ['c9', 'c10'])
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(sent.map(item => item.callId), ['c9', 'c10'], 'no late timeout resolution may fire')
})

test('closing the handle cancels the pending timeout timer', async () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerActions('session-assistant:s1', {
    slow: { timeoutMs: 25, execute: () => new Promise(() => {}) },
  })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const sent = []
  handle.resolveAction = (callId, result) => sent.push({ callId, result })
  handle.emit({ type: 'action', callId: 'c11', name: 'slow', arguments: '{}' })
  handle.end()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(sent, [], 'no resolution after the handle is closed')
})

test('action-result events bound large string payloads for subscribers', () => {
  const service = Object.create(VoiceAgentService.prototype)
  service.toolRegistries = []
  service.handles = new Set()
  service.registerActions('session-assistant:s1', {
    update_working_draft: { execute: () => ({ ok: true, draft: 'x'.repeat(20000) }) },
  })
  const handle = new VoiceConversation('doubao-realtime-duplex')
  handle.ownerId = 'session-assistant:s1'
  service.track(handle)
  const results = []
  handle.resolveAction = () => {}
  handle.subscribe(event => { if (event.type === 'action-result') results.push(event) })
  handle.emit({ type: 'action', callId: 'c12', name: 'update_working_draft', arguments: '{}' })
  assert.equal(results[0].output.draft.length, 4001, 'large strings are bounded with an ellipsis')
  assert.equal(results[0].output.ok, true)
})

(function (root, factory) {
  if (root && root.__ModuleLoader__) {
    root.__ModuleLoader__.load({ id: 'dsh-realtime-voice', factory: function (require) {
      var module = { exports: {} }
      factory(module, module.exports, require, root)
      return module.exports
    } })
  } else if (typeof module === 'object' && module.exports) {
    factory(module, module.exports, require, globalThis)
  } else if (root) {
    var standaloneModule = { exports: {} }
    factory(standaloneModule, standaloneModule.exports, function (name) {
      if (name !== '@deepseek-ai/cordis') throw new Error('Unsupported standalone dependency: ' + name)
      return {
        Service: class Service {
          constructor(ctx, serviceName) {
            this.ctx = ctx
            this.name = serviceName
            if (ctx && ctx.reflect && typeof ctx.reflect.provide === 'function') ctx.reflect.provide(serviceName, this)
          }
        },
      }
    }, root)
    root.DSHRealtimeVoice = standaloneModule.exports
  }
})(typeof window === 'undefined' ? globalThis : window, function (module, exports, require, root) {
  'use strict'

  var Cordis = require('@deepseek-ai/cordis')
  var Service = Cordis.Service
  var BASE_PATH = '/dsh-realtime-voice'
  var MARKER = 'x-dsh-realtime-voice'
  var WS_PROTOCOL = 'dsh-realtime-voice-v1'
  var AUDIO_INPUT_WORKLET_NAME = 'dsh-realtime-voice-input'
  var protocols = Object.freeze(['openai-webrtc', 'doubao-realtime-duplex'])
  var nextHandleId = 1
  /** Defensive ceiling for async tool executors that never settle. */
  var DEFAULT_TOOL_TIMEOUT_MS = 300000

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }

  function text(value) {
    return typeof value === 'string' ? value : ''
  }

  function errorMessage(error) {
    if (error instanceof Error) return error.message || String(error)
    if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
    return error === undefined || error === null ? 'Unknown error' : String(error)
  }

  /** Providers deliver tool arguments as a JSON string; object arguments pass through. */
  function parseToolArguments(value) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    if (typeof value !== 'string') return undefined
    try {
      var parsed = JSON.parse(value)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
    } catch (_) { return undefined }
  }

  function errorEvent(code, message, recoverable) {
    return { type: 'error', code: text(code) || 'realtime_voice_error', message: text(message) || 'Realtime voice error', recoverable: !!recoverable }
  }

  function inputBusyError(ownerId) {
    var error = new Error('Audio input is already owned by ' + ownerId)
    error.code = 'audio_input_busy'
    error.ownerId = ownerId
    return error
  }

  function voiceLog(direction, detail) {
    try {
      var sink = root.console || (typeof console !== 'undefined' ? console : null)
      if (sink && typeof sink.log === 'function') sink.log('[realtime-voice]', direction, detail)
    } catch (_) { /* logging must never break the voice loop */ }
  }

  // Stable, consumer-localizable codes for browser media failures. The raw
  // DOMException message ("Requested device not found", "Permission denied" …)
  // is replaced with one canonical English sentence per code so every consumer
  // can show a friendly fallback and map `error.code` to its own language.
  var MEDIA_ERROR_CODES = {
    NotFoundError: 'mic_not_found',
    NotAllowedError: 'mic_permission_denied',
    SecurityError: 'mic_permission_denied',
    NotReadableError: 'mic_unreadable',
    AbortError: 'mic_aborted',
    OverconstrainedError: 'mic_constraints',
  }
  var MEDIA_ERROR_MESSAGES = {
    mic_not_found: 'No microphone input device was found. Check your system input devices or connect a headset.',
    mic_permission_denied: 'Microphone permission was denied. Allow microphone access in your browser and system settings.',
    mic_unreadable: 'The microphone is unavailable or in use by another application.',
    mic_aborted: 'Microphone access was interrupted. Please try again.',
    mic_constraints: 'No microphone matches the requested constraints.',
  }
  var RECOGNITION_ERROR_CODES = {
    'not-allowed': 'mic_permission_denied',
    'service-not-allowed': 'mic_permission_denied',
    'audio-capture': 'mic_not_found',
  }

  function normalizeMediaError(error) {
    if (error && typeof error === 'object') {
      var code = MEDIA_ERROR_CODES[text(error.name)]
      if (code) {
        // DOMException exposes `code` as a read-only getter, so mutating the
        // original error in place throws. Carry the stable code on a fresh
        // plain Error instead; consumers map error.code to their own language.
        var normalized = new Error(MEDIA_ERROR_MESSAGES[code])
        normalized.name = 'MediaError'
        normalized.code = code
        return normalized
      }
    }
    return error
  }

  function normalizeRecognitionError(error) {
    var raw = text(error && error.error || error)
    var mapped = RECOGNITION_ERROR_CODES[raw]
    var code = mapped || raw || 'recognition_failed'
    return {
      code: code,
      message: mapped ? MEDIA_ERROR_MESSAGES[mapped] : text(error && error.message) || (raw ? 'Browser speech recognition failed: ' + raw : 'Browser speech recognition failed.'),
    }
  }

  function emitter() {
    var listeners = new Set()
    return {
      emit: function (event) { listeners.forEach(function (listener) { try { listener(event) } catch (_) {} }) },
      subscribe: function (listener) {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function')
        listeners.add(listener)
        return function () { listeners.delete(listener) }
      },
      clear: function () { listeners.clear() },
    }
  }

  function transcriptEvent(role, value, final) {
    return { type: 'transcript', role: role, source: role, text: text(value), final: !!final }
  }

  function outputLevelEvent(level) {
    var bounded = Math.max(0, Math.min(1, Number(level) || 0))
    return { type: 'audio-level', source: 'output', level: Math.round(bounded * 1000) / 1000 }
  }

  function pcmLevel(pcm) {
    if (!pcm || !pcm.length) return 0
    var sum = 0
    for (var i = 0; i < pcm.length; i += 1) {
      var sample = pcm[i] / 32768
      sum += sample * sample
    }
    return Math.min(1, Math.sqrt(sum / pcm.length) * 2.4)
  }

  function normalizeProviderEvent(protocol, event) {
    event = object(event)
    var type = text(event.type)
    if (type === 'session.ready' || type === 'session.created' || type === 'session.updated') return { type: 'status', connected: true, status: type === 'session.ready' ? 'ready' : 'connected' }
    if (type === 'input_audio_buffer.speech_started') return { type: 'phase', phase: 'listening' }
    if (type === 'input_audio_buffer.speech_stopped' || type === 'response.created') return { type: 'phase', phase: 'thinking' }
    if (type === 'response.audio.delta' || type === 'response.output_audio.delta' || type === 'response.output_audio.started') return { type: 'phase', phase: 'speaking' }
    if (type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta' || type === 'response.output_text.delta' || type === 'response.text.delta') {
      return transcriptEvent('output', event.delta, false)
    }
    if (type === 'response.audio.done' || type === 'response.output_audio.done' || type === 'response.done') return { type: 'phase', phase: 'listening' }
    if (type === 'conversation.item.input_audio_transcription.started' || type === 'conversation.item.input_audio_transcription.delta') {
      return transcriptEvent('input', event.delta !== undefined ? event.delta : event.transcript, false)
    }
    if (type === 'conversation.item.input_audio_transcription.completed') return transcriptEvent('input', event.transcript, true)
    if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done' || type === 'response.output_text.done' || type === 'response.text.done') {
      return transcriptEvent('output', event.transcript || event.text, true)
    }
    if (type === 'response.function_call_arguments.done') return { type: 'action', callId: text(event.call_id), name: text(event.name), arguments: text(event.arguments) }
    if (type === 'response.cancelled') return { type: 'interrupted' }
    if (type === 'error') {
      var detail = object(event.error)
      return errorEvent(detail.code, detail.message, true)
    }
    return null
  }

  function jsonSend(channel, event) {
    if (!channel || channel.readyState !== 1) throw new Error('Realtime session is not connected')
    channel.send(JSON.stringify(event))
  }

  function VoiceConversation(protocol) {
    this.id = 'realtime-voice-' + nextHandleId++
    this.protocol = protocol
    this.events = emitter()
    this.generation = 1
    this.closed = false
    this.cleanups = []
    this.send = null
    this.cancelPlayback = null
    this.resumePlayback = null
    this.hasSubscriber = false
    this.pendingEvents = []
  }

  VoiceConversation.prototype.subscribe = function (listener) {
    var dispose = this.events.subscribe(listener)
    if (!this.hasSubscriber) {
      this.hasSubscriber = true
      var pending = this.pendingEvents.splice(0)
      pending.forEach(function (event) { try { listener(event) } catch (_) {} })
    }
    return dispose
  }
  VoiceConversation.prototype.emit = function (event) {
    if (this.closed) return
    if (!this.hasSubscriber && this.pendingEvents.length < 16) this.pendingEvents.push(event)
    this.events.emit(event)
    // Dual output: the runtime resolves registered action requests itself
    // (async results included) so product layers only register executors.
    if (event && event.type === 'action' && this.service) this.service.dispatchAction(this, event)
  }
  VoiceConversation.prototype.guard = function (callback) {
    var self = this
    var generation = this.generation
    return function () { if (!self.closed && self.generation === generation) return callback.apply(this, arguments) }
  }
  VoiceConversation.prototype.own = function (cleanup) { if (typeof cleanup === 'function') this.cleanups.push(cleanup); return cleanup }
  VoiceConversation.prototype.updateContext = function (context) { this.sendEvent({ type: 'context.update', context: context }) }
  VoiceConversation.prototype.resolveAction = function (callId, result, options) {
    this.sendEvent({ type: 'tool.result', call_id: text(callId), output: typeof result === 'string' ? result : JSON.stringify(result) })
    if (!options || options.continueResponse !== false) this.sendEvent({ type: 'response.create' })
  }
  VoiceConversation.prototype.resolveTool = VoiceConversation.prototype.resolveAction
  VoiceConversation.prototype.interrupt = function () {
    if (this.closed) return
    if (typeof this.cancelPlayback === 'function') this.cancelPlayback()
    if (this.send) this.sendEvent({ type: 'response.cancel' })
    this.emit({ type: 'interrupted' })
  }
  VoiceConversation.prototype.sendEvent = function (event) {
    if (this.closed || !this.send) throw new Error('Realtime session is closed or not ready')
    this.send(event)
  }
  VoiceConversation.prototype.end = function () {
    if (this.closed) return
    this.closed = true
    this.generation += 1
    for (var i = this.cleanups.length - 1; i >= 0; i -= 1) { try { this.cleanups[i]() } catch (_) {} }
    this.cleanups.length = 0
    this.pendingEvents.length = 0
    this.events.emit({ type: 'phase', phase: 'stopped' })
    this.events.emit({ type: 'closed' })
    this.events.clear()
  }
  VoiceConversation.prototype.close = VoiceConversation.prototype.end

  function openAIEvent(handle, event) {
    var normalized = normalizeProviderEvent('openai-webrtc', event)
    if (normalized && normalized.type === 'phase' && normalized.phase === 'speaking' && typeof handle.resumePlayback === 'function') handle.resumePlayback()
    if (normalized) handle.emit(normalized)
  }

  async function openOpenAI(service, options) {
    var handle = service.track(new VoiceConversation('openai-webrtc'))
    handle.ownerId = text(options.ownerId)
    handle.emit({ type: 'phase', phase: 'connecting' })
    try {
      var outputOnly = options.outputOnly === true
      if (!outputOnly) handle.own(service.acquireInput(options.ownerId))
      var stream = outputOnly ? null : await service.root.navigator.mediaDevices.getUserMedia({ audio: true })
      if (handle.closed) { if (stream) stream.getTracks().forEach(function (track) { track.stop() }); return handle }
      if (stream) handle.own(function () { stream.getTracks().forEach(function (track) { track.stop() }) })
      var peer = new service.root.RTCPeerConnection()
      handle.own(function () { peer.close() })
      var audio = service.root.document.createElement('audio')
      audio.autoplay = true
      handle.own(function () { audio.pause(); audio.srcObject = null; audio.remove() })
      if (stream) stream.getTracks().forEach(function (track) { peer.addTrack(track, stream) })
      else if (typeof peer.addTransceiver === 'function') peer.addTransceiver('audio', { direction: 'recvonly' })
      handle.cancelPlayback = function () { audio.pause(); audio.srcObject = null }
      handle.resumePlayback = function () {
        if (!handle.remoteStream || handle.closed) return
        if (audio.srcObject !== handle.remoteStream) audio.srcObject = handle.remoteStream
        if (typeof audio.play !== 'function') return
        var playing = audio.play()
        if (playing && typeof playing.catch === 'function') playing.catch(function () {})
      }
      peer.ontrack = handle.guard(function (event) {
        handle.remoteStream = event.streams[0] || new service.root.MediaStream([event.track])
        handle.resumePlayback()
      })
      var channel = peer.createDataChannel('oai-events')
      handle.own(function () { try { channel.close() } catch (_) {} })
      handle.send = function (event) {
        if (event.type === 'context.update') return jsonSend(channel, { type: 'session.update', session: { instructions: text(event.context) } })
        if (event.type === 'tool.result') return jsonSend(channel, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: event.output } })
        if (event.type === 'response.create') return jsonSend(channel, { type: 'response.create' })
        return jsonSend(channel, event)
      }
      var openAISend = handle.send
      handle.send = function (event) { voiceLog('upstream', event.type + (event.call_id ? ':' + event.call_id : '')); return openAISend(event) }
      channel.onopen = handle.guard(function () {
        handle.emit({ type: 'status', connected: true, status: 'ready' })
        handle.emit({ type: 'phase', phase: options.previewText ? 'thinking' : 'listening' })
        if (options.previewText) {
          jsonSend(channel, { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: text(options.previewText) }] } })
          jsonSend(channel, { type: 'response.create' })
        }
      })
      channel.onmessage = handle.guard(function (message) {
        try {
          var event = JSON.parse(message.data)
          voiceLog('downstream', 'openai:' + event.type)
          openAIEvent(handle, event)
        } catch (_) {}
      })
      channel.onerror = handle.guard(function () { handle.emit(errorEvent('data_channel_error', 'OpenAI Realtime data channel failed', true)) })
      var offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      var response = await service.root.fetch(service.basePath + '/openai/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [MARKER]: '1' },
        body: JSON.stringify({ sdp: offer.sdp, routeId: options.routeId, profileId: options.profileId, context: options.context }),
      })
      var answer = await response.text()
      if (!response.ok) throw new Error(answer || 'OpenAI Realtime session failed')
      await peer.setRemoteDescription({ type: 'answer', sdp: answer })
      return handle
    } catch (error) {
      handle.close()
      throw normalizeMediaError(error)
    }
  }

  function bytesToBase64(rootObject, bytes) {
    var binary = ''
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
    return rootObject.btoa(binary)
  }

  function base64ToInt16(rootObject, encoded) {
    var binary = rootObject.atob(encoded)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new Int16Array(bytes.buffer)
  }

  function downsamplePCM(float32, inputRate, outputRate) {
    var ratio = inputRate / outputRate
    var length = Math.floor(float32.length / ratio)
    var output = new Int16Array(length)
    for (var i = 0; i < length; i += 1) {
      var sample = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)] || 0))
      output[i] = sample < 0 ? sample * 32768 : sample * 32767
    }
    return output
  }

  function schedulePCM(service, handle, encoded) {
    var context = handle.audioContext
    if (!context) return
    var pcm
    try { pcm = base64ToInt16(service.root, encoded) } catch (_) {
      handle.emit(errorEvent('invalid_audio_frame', 'Doubao Realtime returned invalid PCM audio', false))
      return
    }
    var buffer = context.createBuffer(1, pcm.length, 24000)
    var channel = buffer.getChannelData(0)
    for (var i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768
    handle.emit(outputLevelEvent(pcmLevel(pcm)))
    var source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    var now = context.currentTime
    handle.playAt = Math.max(handle.playAt || now, now)
    source.start(handle.playAt)
    handle.playAt += buffer.duration
    handle.sources.add(source)
    source.onended = handle.guard(function () {
      handle.sources.delete(source)
      if (!handle.sources.size) handle.emit(outputLevelEvent(0))
    })
  }

  function gatewayOptions(value) {
    var gateway = object(value)
    if (!gateway.path) return null
    var path = text(gateway.path)
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{1,2047}$/.test(path) || path.indexOf('//') === 0) {
      throw new TypeError('Voice gateway path must be a bounded same-origin absolute path')
    }
    var version = Number.isSafeInteger(gateway.version) && gateway.version > 0 ? gateway.version : null
    var start = object(gateway.start)
    if (!text(start.type)) throw new TypeError('Voice gateway start event requires a type')
    var readyEvent = text(gateway.readyEvent) || 'session.ready'
    if (!/^[a-z0-9._-]{1,120}$/i.test(readyEvent)) throw new TypeError('Voice gateway ready event is invalid')
    return { path: path, version: version, start: start, readyEvent: readyEvent }
  }

  function gatewayEvent(gateway, event) {
    if (!gateway || gateway.version === null) return event
    return Object.assign({}, event, { version: gateway.version })
  }

  async function openDoubao(service, options) {
    var handle = service.track(new VoiceConversation('doubao-realtime-duplex'))
    handle.ownerId = text(options.ownerId)
    handle.emit({ type: 'phase', phase: 'connecting' })
    try {
      var outputOnly = options.outputOnly === true
      if (!outputOnly) handle.own(service.acquireInput(options.ownerId))
      var stream = outputOnly ? null : await service.root.navigator.mediaDevices.getUserMedia({ audio: true })
      if (stream) handle.own(function () { stream.getTracks().forEach(function (track) { track.stop() }) })
      var AudioContext = service.root.AudioContext || service.root.webkitAudioContext
      if (!AudioContext) throw new Error('AudioContext is not available')
      var context = new AudioContext()
      handle.audioContext = context
      handle.sources = new Set()
      handle.sessionReady = false
      handle.own(function () { context.close() })
      handle.cancelPlayback = function () {
        handle.sources.forEach(function (source) { try { source.stop() } catch (_) {} })
        handle.sources.clear()
        handle.playAt = context.currentTime
        handle.emit(outputLevelEvent(0))
      }
      handle.own(handle.cancelPlayback)
      var gateway = gatewayOptions(options.gateway)
      var wsProtocol = service.root.location.protocol === 'https:' ? 'wss:' : 'ws:'
      var socketURL = wsProtocol + '//' + service.root.location.host + (gateway ? gateway.path : service.basePath + '/doubao')
      var socket = gateway ? new service.root.WebSocket(socketURL) : new service.root.WebSocket(socketURL, WS_PROTOCOL)
      handle.send = function (event) {
        // Doubao Duplex resumes the turn automatically after a function-call
        // result (the official SDK sends no response.create); forwarding the
        // OpenAI-only trigger is not part of this dialect and can leave the
        // model waiting on a stale event instead of speaking the follow-up.
        if (event.type === 'response.create') return
        voiceLog('upstream', event.type + (event.call_id ? ':' + event.call_id : ''))
        jsonSend(socket, gatewayEvent(gateway, event))
      }
      handle.own(function () { socket.close(1000, 'client closed') })
      socket.onopen = handle.guard(function () {
        voiceLog('upstream', 'session.start')
        jsonSend(socket, gateway
          ? gatewayEvent(gateway, gateway.start)
          : { type: 'session.start', routeId: options.routeId, profileId: options.profileId, context: options.context })
      })
      socket.onmessage = handle.guard(function (message) {
        var event
        try { event = JSON.parse(message.data) } catch (_) { return }
        if (event.type === 'error') {
          var detail = object(event.error)
          voiceLog('downstream', 'error ' + (text(detail.code) || 'unknown') + ' ' + text(detail.message))
        } else {
          voiceLog('downstream', event.type)
        }
        if (event.type === (gateway ? gateway.readyEvent : 'session.ready')) {
          handle.sessionReady = true
          handle.emit({ type: 'status', connected: true, status: 'ready' })
          handle.emit({ type: 'phase', phase: options.previewText ? 'thinking' : 'listening' })
          if (options.previewText) jsonSend(socket, { type: 'preview.speak', text: text(options.previewText) })
        }
        if ((event.type === 'input_audio_buffer.speech_started' || event.type === 'conversation.item.input_audio_transcription.started') && handle.sources.size) {
          handle.cancelPlayback()
          jsonSend(socket, gatewayEvent(gateway, { type: 'response.cancel' }))
          handle.emit({ type: 'interrupted' })
        }
        if (event.type === 'response.audio.delta' || event.type === 'response.output_audio.delta') schedulePCM(service, handle, text(event.delta))
        var normalized = normalizeProviderEvent('doubao-realtime-duplex', event)
        if (normalized) handle.emit(normalized)
      })
      socket.onerror = handle.guard(function () { handle.emit(errorEvent('websocket_error', 'Doubao Realtime WebSocket failed', true)) })
      socket.onclose = handle.guard(function () { handle.close() })
      if (stream) {
        var AudioWorkletNode = service.root.AudioWorkletNode
        if (!context.audioWorklet || typeof context.audioWorklet.addModule !== 'function' || typeof AudioWorkletNode !== 'function') {
          throw new Error('AudioWorklet is not available')
        }
        await context.audioWorklet.addModule(service.basePath + '/audio-input-worklet.js')
        var input = context.createMediaStreamSource(stream)
        var processor = new AudioWorkletNode(context, AUDIO_INPUT_WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { chunkFrames: 2048 },
        })
        var mute = context.createGain()
        mute.gain.value = 0
        input.connect(processor)
        processor.connect(mute)
        mute.connect(context.destination)
        processor.port.onmessage = handle.guard(function (event) {
          if (socket.readyState !== 1 || !handle.sessionReady) return
          var payload = object(event.data)
          var samples = payload.samples
          if (!samples || typeof samples.length !== 'number') return
          var inputRate = Number(payload.sampleRate) || context.sampleRate
          var pcm = downsamplePCM(samples, inputRate, 16000)
          jsonSend(socket, gatewayEvent(gateway, { type: 'input_audio_buffer.append', audio: bytesToBase64(service.root, new Uint8Array(pcm.buffer)) }))
        })
        handle.own(function () {
          processor.port.onmessage = null
          processor.disconnect()
          mute.disconnect()
          input.disconnect()
        })
      }
      return handle
    } catch (error) {
      handle.close()
      throw normalizeMediaError(error)
    }
  }

  function browserRecognition(service, options) {
    var Recognition = service.root.SpeechRecognition || service.root.webkitSpeechRecognition
    if (!Recognition) throw new Error('SpeechRecognition is not available')
    var handle
    var releaseInput = service.acquireInput(options.ownerId, {
      preemptible: options.preemptible === true,
      onPreempt: function () {
        if (handle) handle.close()
        if (typeof options.onPreempt === 'function') options.onPreempt()
      },
    })
    var recognition
    try { recognition = new Recognition() } catch (error) { releaseInput(); throw error }
    var closed = false
    recognition.lang = options.lang || 'en-US'
    recognition.continuous = options.continuous !== false
    recognition.interimResults = options.interim !== false
    recognition.maxAlternatives = 1
    handle = {
      close: function () {
        if (closed) return
        closed = true
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        service.auxiliary.delete(handle)
        releaseInput()
        try { recognition.stop() } catch (_) {}
      },
    }
    recognition.onresult = function (event) {
      if (closed) return
      for (var i = event.resultIndex; i < event.results.length; i += 1) {
        var result = event.results[i]
        if (typeof options.onTranscript === 'function') options.onTranscript({ text: text(result[0] && result[0].transcript), final: !!result.isFinal, resultIndex: i })
      }
    }
    recognition.onerror = function (event) {
      if (closed) return
      var normalized = normalizeRecognitionError(event)
      if (typeof options.onError !== 'function') return
      options.onError(errorEvent(normalized.code, normalized.message, event.error === 'no-speech'))
    }
    recognition.onend = function () {
      if (closed) return
      // Chrome/Edge end continuous recognition silently after an idle spell;
      // a standby wake-word listener must come right back or the wake word
      // quietly stops working. Restart unless the consumer preempted/closed us.
      if (options.continuous !== false) {
        var restart = function () {
          if (closed) return
          try { recognition.start() } catch (error) {
            options.onError(errorEvent('recognition_restart_failed', text(error && error.message || error), true))
          }
        }
        if (typeof service.root.setTimeout === 'function') service.root.setTimeout(restart, 0)
        else restart()
        return
      }
      handle.close()
    }
    service.auxiliary.add(handle)
    try { recognition.start() } catch (error) { handle.close(); throw error }
    return handle
  }

  function browserReadAloud(service, options) {
    var utterance = new service.root.SpeechSynthesisUtterance(text(options.text))
    var closed = false
    utterance.lang = options.lang || ''
    utterance.rate = Number.isFinite(options.rate) ? options.rate : 1
    var voices = service.root.speechSynthesis.getVoices()
    utterance.voice = voices.find(function (voice) { return voice.name === options.voiceName }) || null
    var handle = {
      interrupt: function () {
        if (closed) return
        closed = true
        utterance.onend = null
        utterance.onerror = null
        service.auxiliary.delete(handle)
        service.root.speechSynthesis.cancel()
      },
    }
    handle.close = handle.interrupt
    utterance.onend = function () {
      if (closed) return
      closed = true
      service.auxiliary.delete(handle)
      if (typeof options.onEnd === 'function') options.onEnd()
    }
    utterance.onerror = function (event) {
      if (closed) return
      closed = true
      service.auxiliary.delete(handle)
      if (typeof options.onError === 'function') options.onError(errorEvent(event.error, event.message || event.error, false))
    }
    service.auxiliary.add(handle)
    try { service.root.speechSynthesis.speak(utterance) } catch (error) { handle.close(); throw error }
    return handle
  }

  function VoiceAgentService(ctx, options) {
    var self = Reflect.construct(Service, [ctx, 'voiceAgent'], VoiceAgentService)
    // Temporary compatibility alias for product plugins migrating from the
    // old transport-oriented service name.
    if (ctx && ctx.reflect && typeof ctx.reflect.provide === 'function') ctx.reflect.provide('realtimeVoice', self)
    self.root = options && options.root || root
    self.basePath = options && options.basePath || BASE_PATH
    self.handles = new Set()
    self.auxiliary = new Set()
    self.inputLease = null
    self.toolRegistries = []
    self.generation = 1
    return self
  }
  VoiceAgentService.prototype = Object.create(Service.prototype)
  VoiceAgentService.prototype.constructor = VoiceAgentService
  VoiceAgentService.prototype.capabilities = function () {
    var media = !!(this.root.navigator && this.root.navigator.mediaDevices && this.root.navigator.mediaDevices.getUserMedia)
    var voices = this.root.speechSynthesis && typeof this.root.speechSynthesis.getVoices === 'function'
      ? this.root.speechSynthesis.getVoices().map(function (voice) { return { id: voice.name, name: voice.name, lang: voice.lang || '', default: !!voice.default } })
      : []
    return {
      secureContext: this.root.isSecureContext !== false,
      protocols: protocols.slice(),
      realtime: {
        'openai-webrtc': media && typeof this.root.RTCPeerConnection === 'function',
        'doubao-realtime-duplex': media && typeof this.root.WebSocket === 'function' && typeof this.root.AudioWorkletNode === 'function' && !!(this.root.AudioContext || this.root.webkitAudioContext),
      },
      recognition: !!(this.root.SpeechRecognition || this.root.webkitSpeechRecognition),
      audioInput: { exclusive: true, busy: !!this.inputLease, ownerId: this.inputLease ? this.inputLease.ownerId : '' },
      readAloud: !!this.root.speechSynthesis,
      voices: voices,
    }
  }
  VoiceAgentService.prototype.models = async function () {
    var response = await this.root.fetch(this.basePath + '/models', { method: 'GET' })
    var body = await response.json()
    if (!response.ok) throw new Error(text(body.error) || 'Unable to list Realtime voice models')
    return Array.isArray(body.models) ? body.models : []
  }
  VoiceAgentService.prototype.acquireInput = function (ownerId, options) {
    var service = this
    var normalized = text(ownerId).trim().slice(0, 120) || 'legacy-consumer'
    if (this.inputLease && this.inputLease.preemptible) {
      try { this.inputLease.onPreempt() } catch (_) {}
    }
    if (this.inputLease) throw inputBusyError(this.inputLease.ownerId)
    options = object(options)
    var lease = { ownerId: normalized, preemptible: options.preemptible === true, onPreempt: typeof options.onPreempt === 'function' ? options.onPreempt : function () {} }
    this.inputLease = lease
    var released = false
    return function () {
      if (released) return
      released = true
      if (service.inputLease === lease) service.inputLease = null
    }
  }
  VoiceAgentService.prototype.track = function (handle) {
    var self = this
    this.handles.add(handle)
    handle.service = self
    var end = handle.end.bind(handle)
    var trackedEnd = function () { end(); self.handles.delete(handle) }
    handle.end = trackedEnd
    handle.close = trackedEnd
    return handle
  }
  VoiceAgentService.prototype.startConversation = async function (options) {
    options = object(options)
    var protocol = options.protocol
    if (!protocol && options.routeId) {
      var models = await this.models()
      var route = models.find(function (candidate) { return candidate && candidate.id === options.routeId })
      protocol = route && route.protocol
    }
    if (protocol === 'openai-webrtc') return openOpenAI(this, options)
    if (protocol === 'doubao-realtime-duplex') return openDoubao(this, options)
    throw new Error('The selected voice route does not support a duplex Agent conversation')
  }
  VoiceAgentService.prototype.open = VoiceAgentService.prototype.startConversation
  VoiceAgentService.prototype.recognize = function (options) { return browserRecognition(this, object(options)) }
  VoiceAgentService.prototype.readAloud = function (options) { return browserReadAloud(this, object(options)) }

  /** Register product action executors for one conversation-owner prefix. */
  VoiceAgentService.prototype.registerActions = function (ownerPrefix, actions) {
    var prefix = text(ownerPrefix)
    if (!prefix) throw new TypeError('ownerPrefix is required')
    if (!actions || typeof actions !== 'object' || Array.isArray(actions)) throw new TypeError('actions must be an object of executors')
    var normalized = {}
    Object.keys(actions).forEach(function (name) {
      var action = object(actions[name])
      if (typeof action.execute !== 'function') throw new TypeError('action ' + name + ' must provide an execute function')
      normalized[name] = action
    })
    var entry = { ownerPrefix: prefix, tools: normalized }
    this.toolRegistries.push(entry)
    var self = this
    return {
      dispose: function () {
        var index = self.toolRegistries.indexOf(entry)
        if (index >= 0) self.toolRegistries.splice(index, 1)
      },
    }
  }
  VoiceAgentService.prototype.registerTools = VoiceAgentService.prototype.registerActions

  /** Merged executor map for a handle owner; later registrations win on name conflicts. */
  VoiceAgentService.prototype.lookupTools = function (ownerId) {
    var merged = null
    for (var i = this.toolRegistries.length - 1; i >= 0; i -= 1) {
      var entry = this.toolRegistries[i]
      if (ownerId && ownerId.indexOf(entry.ownerPrefix) === 0) {
        if (!merged) merged = {}
        var tools = entry.tools
        for (var name in tools) merged[name] = tools[name]
      }
    }
    return merged
  }

  /** Bound strings inside an observable action result. */
  function boundedResult(value, max) {
    max = max || 4000
    if (typeof value === 'string') return value.length > max ? value.slice(0, max) + '…' : value
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      var out = {}
      for (var key in value) out[key] = boundedResult(value[key], max)
      return out
    }
    return value
  }

  /** Resolve one action result through the provider-specific wire. */
  VoiceAgentService.prototype.settleAction = function (handle, event, result, options) {
    try {
      handle.resolveAction(event.callId, result, options)
      handle.emit({ type: 'action-result', callId: event.callId, name: event.name, ok: true, output: boundedResult(result) })
      return true
    } catch (error) {
      handle.emit({ type: 'action-result', callId: event.callId, name: event.name, ok: false, error: errorMessage(error) })
      return false
    }
  }

  /**
   * Execute a normalized tool event through the owner-matched registry. The
   * executor may return a plain value, a Promise, or call control.resolve
   * itself when it must settle the result before running follow-up work.
   */
  VoiceAgentService.prototype.dispatchAction = function (handle, event) {
    var tools = this.lookupTools(handle.ownerId)
    if (!tools) return
    var executor = tools[event.name]
    if (typeof executor !== 'object' || typeof executor.execute !== 'function') {
      this.settleAction(handle, event, { ok: false, error: 'Unknown action: ' + text(event.name) })
      return
    }
    var args = parseToolArguments(event.arguments)
    if (args === undefined) {
      this.settleAction(handle, event, { ok: false, error: 'Invalid action arguments.' })
      return
    }
    var self = this
    var resolved = false
    // Defensive timeout for async executors: a hanging executor must never
    // leave the voice model waiting on its tool result forever. Per-tool
    // timeoutMs overrides the default; no timer is armed for synchronous
    // executors that settle within the same tick.
    var timeoutMs = Number.isFinite(executor.timeoutMs) && executor.timeoutMs > 0 ? executor.timeoutMs : DEFAULT_TOOL_TIMEOUT_MS
    var timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(function () {
        if (!resolved && !handle.closed) control.resolve({ ok: false, error: 'Action execution timed out.' })
      }, timeoutMs)
      if (typeof handle.own === 'function') handle.own(function () { clearTimeout(timer) })
    }
    var control = {
      resolve: function (result, options) {
        if (resolved || handle.closed) return false
        resolved = true
        if (timer !== null) clearTimeout(timer)
        return self.settleAction(handle, event, result, options)
      },
    }
    var outcome
    try {
      outcome = executor.execute(args, control)
    } catch (error) {
      if (timer !== null) clearTimeout(timer)
      if (!resolved) this.settleAction(handle, event, { ok: false, error: errorMessage(error) })
      return
    }
    if (outcome && typeof outcome.then === 'function') {
      Promise.resolve(outcome).then(
        function (value) {
          if (!resolved && !handle.closed) control.resolve(value === undefined ? { ok: true } : value)
        },
        function (error) {
          if (!resolved && !handle.closed) control.resolve({ ok: false, error: errorMessage(error) })
        },
      )
      return
    }
    if (!resolved) control.resolve(outcome === undefined ? { ok: true } : outcome)
  }

  VoiceAgentService.prototype.dispose = function () {
    this.generation += 1
    this.handles.forEach(function (handle) { handle.close() })
    this.auxiliary.forEach(function (handle) { handle.close() })
    this.handles.clear()
    this.auxiliary.clear()
    this.inputLease = null
    this.toolRegistries.length = 0
  }

  function apply(ctx) {
    var service = new VoiceAgentService(ctx)
    if (typeof ctx.effect === 'function') ctx.effect(function () { return function () { service.dispose() } }, 'dsh-realtime-voice.client')
  }

  exports.name = 'dsh-realtime-voice'
  exports.inject = []
  exports.apply = apply
  exports.VoiceAgentService = VoiceAgentService
  exports.VoiceConversation = VoiceConversation
  exports.RealtimeVoiceService = VoiceAgentService
  exports.RealtimeHandle = VoiceConversation
  exports.normalizeProviderEvent = normalizeProviderEvent
  exports.normalizeMediaError = normalizeMediaError
  exports.REALTIME_WS_PROTOCOL = WS_PROTOCOL
  module.exports = exports
})

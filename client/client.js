(function (root, factory) {
  if (root && root.__ModuleLoader__) {
    root.__ModuleLoader__.load({ id: 'dsh-realtime-voice', factory: function (require) {
      var module = { exports: {} }
      factory(module, module.exports, require, root)
      return module.exports
    } })
  } else if (typeof module === 'object' && module.exports) {
    factory(module, module.exports, require, globalThis)
  }
})(typeof window === 'undefined' ? globalThis : window, function (module, exports, require, root) {
  'use strict'

  var Cordis = require('@deepseek-ai/cordis')
  var Service = Cordis.Service
  var BASE_PATH = '/dsh-realtime-voice'
  var MARKER = 'x-dsh-realtime-voice'
  var WS_PROTOCOL = 'dsh-realtime-voice-v1'
  var protocols = Object.freeze(['openai-webrtc', 'doubao-realtime-duplex'])
  var nextHandleId = 1

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }

  function text(value) {
    return typeof value === 'string' ? value : ''
  }

  function errorEvent(code, message, recoverable) {
    return { type: 'error', code: text(code) || 'realtime_voice_error', message: text(message) || 'Realtime voice error', recoverable: !!recoverable }
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
    if (type === 'conversation.item.input_audio_transcription.completed') return transcriptEvent('input', event.transcript, true)
    if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done' || type === 'response.output_text.done' || type === 'response.text.done') {
      return transcriptEvent('output', event.transcript || event.text, true)
    }
    if (type === 'response.function_call_arguments.done') return { type: 'tool', callId: text(event.call_id), name: text(event.name), arguments: text(event.arguments) }
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

  function RealtimeHandle(protocol) {
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

  RealtimeHandle.prototype.subscribe = function (listener) {
    var dispose = this.events.subscribe(listener)
    if (!this.hasSubscriber) {
      this.hasSubscriber = true
      var pending = this.pendingEvents.splice(0)
      pending.forEach(function (event) { try { listener(event) } catch (_) {} })
    }
    return dispose
  }
  RealtimeHandle.prototype.emit = function (event) {
    if (this.closed) return
    if (!this.hasSubscriber && this.pendingEvents.length < 16) this.pendingEvents.push(event)
    this.events.emit(event)
  }
  RealtimeHandle.prototype.guard = function (callback) {
    var self = this
    var generation = this.generation
    return function () { if (!self.closed && self.generation === generation) return callback.apply(this, arguments) }
  }
  RealtimeHandle.prototype.own = function (cleanup) { if (typeof cleanup === 'function') this.cleanups.push(cleanup); return cleanup }
  RealtimeHandle.prototype.updateContext = function (context) { this.sendEvent({ type: 'context.update', context: context }) }
  RealtimeHandle.prototype.resolveTool = function (callId, result, options) {
    this.sendEvent({ type: 'tool.result', call_id: text(callId), output: typeof result === 'string' ? result : JSON.stringify(result) })
    if (!options || options.continueResponse !== false) this.sendEvent({ type: 'response.create' })
  }
  RealtimeHandle.prototype.interrupt = function () {
    if (this.closed) return
    if (typeof this.cancelPlayback === 'function') this.cancelPlayback()
    if (this.send) this.sendEvent({ type: 'response.cancel' })
    this.emit({ type: 'interrupted' })
  }
  RealtimeHandle.prototype.sendEvent = function (event) {
    if (this.closed || !this.send) throw new Error('Realtime session is closed or not ready')
    this.send(event)
  }
  RealtimeHandle.prototype.close = function () {
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

  function openAIEvent(handle, event) {
    var normalized = normalizeProviderEvent('openai-webrtc', event)
    if (normalized && normalized.type === 'phase' && normalized.phase === 'speaking' && typeof handle.resumePlayback === 'function') handle.resumePlayback()
    if (normalized) handle.emit(normalized)
  }

  async function openOpenAI(service, options) {
    var handle = service.track(new RealtimeHandle('openai-webrtc'))
    handle.emit({ type: 'phase', phase: 'connecting' })
    try {
      var outputOnly = options.outputOnly === true
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
      channel.onopen = handle.guard(function () {
        handle.emit({ type: 'status', connected: true, status: 'ready' })
        handle.emit({ type: 'phase', phase: options.previewText ? 'thinking' : 'listening' })
        if (options.previewText) {
          jsonSend(channel, { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: text(options.previewText) }] } })
          jsonSend(channel, { type: 'response.create' })
        }
      })
      channel.onmessage = handle.guard(function (message) { try { openAIEvent(handle, JSON.parse(message.data)) } catch (_) {} })
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
      throw error
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
    var source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    var now = context.currentTime
    handle.playAt = Math.max(handle.playAt || now, now)
    source.start(handle.playAt)
    handle.playAt += buffer.duration
    handle.sources.add(source)
    source.onended = handle.guard(function () { handle.sources.delete(source) })
  }

  async function openDoubao(service, options) {
    var handle = service.track(new RealtimeHandle('doubao-realtime-duplex'))
    handle.emit({ type: 'phase', phase: 'connecting' })
    try {
      var outputOnly = options.outputOnly === true
      var stream = outputOnly ? null : await service.root.navigator.mediaDevices.getUserMedia({ audio: true })
      if (stream) handle.own(function () { stream.getTracks().forEach(function (track) { track.stop() }) })
      var AudioContext = service.root.AudioContext || service.root.webkitAudioContext
      if (!AudioContext) throw new Error('AudioContext is not available')
      var context = new AudioContext()
      handle.audioContext = context
      handle.sources = new Set()
      handle.own(function () { context.close() })
      handle.cancelPlayback = function () {
        handle.sources.forEach(function (source) { try { source.stop() } catch (_) {} })
        handle.sources.clear()
        handle.playAt = context.currentTime
      }
      handle.own(handle.cancelPlayback)
      var wsProtocol = service.root.location.protocol === 'https:' ? 'wss:' : 'ws:'
      var socket = new service.root.WebSocket(wsProtocol + '//' + service.root.location.host + service.basePath + '/doubao', WS_PROTOCOL)
      handle.send = function (event) { jsonSend(socket, event) }
      handle.own(function () { socket.close(1000, 'client closed') })
      socket.onopen = handle.guard(function () {
        jsonSend(socket, { type: 'session.start', routeId: options.routeId, profileId: options.profileId, context: options.context })
      })
      socket.onmessage = handle.guard(function (message) {
        var event
        try { event = JSON.parse(message.data) } catch (_) { return }
        if (event.type === 'session.ready') {
          handle.emit({ type: 'status', connected: true, status: 'ready' })
          handle.emit({ type: 'phase', phase: options.previewText ? 'thinking' : 'listening' })
          if (options.previewText) jsonSend(socket, { type: 'preview.speak', text: text(options.previewText) })
        }
        if (event.type === 'response.audio.delta' || event.type === 'response.output_audio.delta') schedulePCM(service, handle, text(event.delta))
        var normalized = normalizeProviderEvent('doubao-realtime-duplex', event)
        if (normalized) handle.emit(normalized)
      })
      socket.onerror = handle.guard(function () { handle.emit(errorEvent('websocket_error', 'Doubao Realtime WebSocket failed', true)) })
      socket.onclose = handle.guard(function () { handle.close() })
      if (stream) {
        var input = context.createMediaStreamSource(stream)
        var processor = context.createScriptProcessor(4096, 1, 1)
        input.connect(processor)
        processor.connect(context.destination)
        processor.onaudioprocess = handle.guard(function (event) {
          if (socket.readyState !== 1) return
          var pcm = downsamplePCM(event.inputBuffer.getChannelData(0), context.sampleRate, 16000)
          jsonSend(socket, { type: 'input_audio_buffer.append', audio: bytesToBase64(service.root, new Uint8Array(pcm.buffer)) })
        })
        handle.own(function () { processor.disconnect(); input.disconnect(); processor.onaudioprocess = null })
      }
      return handle
    } catch (error) {
      handle.close()
      throw error
    }
  }

  function browserRecognition(service, options) {
    var Recognition = service.root.SpeechRecognition || service.root.webkitSpeechRecognition
    if (!Recognition) throw new Error('SpeechRecognition is not available')
    var recognition = new Recognition()
    var closed = false
    recognition.lang = options.lang || 'en-US'
    recognition.continuous = options.continuous !== false
    recognition.interimResults = options.interim !== false
    var handle = {
      close: function () {
        if (closed) return
        closed = true
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        service.auxiliary.delete(handle)
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
    recognition.onerror = function (event) { if (!closed && typeof options.onError === 'function') options.onError(errorEvent(event.error, event.message || event.error, event.error === 'no-speech')) }
    recognition.onend = function () { if (!closed) handle.close() }
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

  function RealtimeVoiceService(ctx, options) {
    var self = Reflect.construct(Service, [ctx, 'realtimeVoice'], RealtimeVoiceService)
    self.root = options && options.root || root
    self.basePath = options && options.basePath || BASE_PATH
    self.handles = new Set()
    self.auxiliary = new Set()
    self.generation = 1
    return self
  }
  RealtimeVoiceService.prototype = Object.create(Service.prototype)
  RealtimeVoiceService.prototype.constructor = RealtimeVoiceService
  RealtimeVoiceService.prototype.capabilities = function () {
    var media = !!(this.root.navigator && this.root.navigator.mediaDevices && this.root.navigator.mediaDevices.getUserMedia)
    var voices = this.root.speechSynthesis && typeof this.root.speechSynthesis.getVoices === 'function'
      ? this.root.speechSynthesis.getVoices().map(function (voice) { return { id: voice.name, name: voice.name, lang: voice.lang || '', default: !!voice.default } })
      : []
    return {
      secureContext: this.root.isSecureContext !== false,
      protocols: protocols.slice(),
      realtime: {
        'openai-webrtc': media && typeof this.root.RTCPeerConnection === 'function',
        'doubao-realtime-duplex': media && typeof this.root.WebSocket === 'function' && !!(this.root.AudioContext || this.root.webkitAudioContext),
      },
      recognition: !!(this.root.SpeechRecognition || this.root.webkitSpeechRecognition),
      readAloud: !!this.root.speechSynthesis,
      voices: voices,
    }
  }
  RealtimeVoiceService.prototype.models = async function () {
    var response = await this.root.fetch(this.basePath + '/models', { method: 'GET' })
    var body = await response.json()
    if (!response.ok) throw new Error(text(body.error) || 'Unable to list Realtime voice models')
    return Array.isArray(body.models) ? body.models : []
  }
  RealtimeVoiceService.prototype.track = function (handle) {
    var self = this
    this.handles.add(handle)
    var close = handle.close.bind(handle)
    handle.close = function () { close(); self.handles.delete(handle) }
    return handle
  }
  RealtimeVoiceService.prototype.open = async function (options) {
    options = object(options)
    if (options.protocol === 'openai-webrtc') return openOpenAI(this, options)
    if (options.protocol === 'doubao-realtime-duplex') return openDoubao(this, options)
    throw new Error('Unsupported Realtime voice protocol: ' + text(options.protocol))
  }
  RealtimeVoiceService.prototype.recognize = function (options) { return browserRecognition(this, object(options)) }
  RealtimeVoiceService.prototype.readAloud = function (options) { return browserReadAloud(this, object(options)) }
  RealtimeVoiceService.prototype.dispose = function () {
    this.generation += 1
    this.handles.forEach(function (handle) { handle.close() })
    this.auxiliary.forEach(function (handle) { handle.close() })
    this.handles.clear()
    this.auxiliary.clear()
  }

  function apply(ctx) {
    var service = new RealtimeVoiceService(ctx)
    if (typeof ctx.effect === 'function') ctx.effect(function () { return function () { service.dispose() } }, 'dsh-realtime-voice.client')
  }

  exports.name = 'dsh-realtime-voice'
  exports.inject = []
  exports.apply = apply
  exports.RealtimeVoiceService = RealtimeVoiceService
  exports.RealtimeHandle = RealtimeHandle
  exports.normalizeProviderEvent = normalizeProviderEvent
  exports.REALTIME_WS_PROTOCOL = WS_PROTOCOL
  module.exports = exports
})

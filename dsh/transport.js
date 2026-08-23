import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import WebSocket, { WebSocketServer } from 'ws'
import { DOUBAO_PREVIEW_PROMPT_PCM_BASE64 } from './preview-audio.js'

export const OPENAI_API_ORIGIN = 'https://api.openai.com'
export const DOUBAO_DUPLEX_ORIGIN = 'wss://openspeech.bytedance.com'
export const DOUBAO_DUPLEX_ENDPOINT = `${DOUBAO_DUPLEX_ORIGIN}/api/v3/duplex/realtime/dialogue`
export const REALTIME_MARKER_HEADER = 'x-dsh-realtime-voice'
export const REALTIME_WS_PROTOCOL = 'dsh-realtime-voice-v1'
export const MODEL_PROBE_HEADER = 'x-dsh-model-probe'
export const DEFAULT_BASE_PATH = '/dsh-realtime-voice'
export const MAX_STARTUP_EVENTS = 16
export const MAX_PROVIDER_FRAME_BYTES = 512 * 1024
const MAX_BODY_BYTES = 256 * 1024
const MAX_AUDIO_BASE64_CHARS = 256 * 1024
const MAX_TEXT_CHARS = 64 * 1024

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Host-side event-flow trace for the Realtime bridge; lands in the process log (web-nohup.log). */
function trace(...args) {
  try { console.log('[realtime-voice:host]', ...args) } catch { /* never break the bridge */ }
}

function string(value, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return undefined
  return value.length <= max ? value : value.slice(0, max)
}

function validPCMBase64(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_AUDIO_BASE64_CHARS) return false
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const decodedBytes = value.length / 4 * 3 - padding
  return decodedBytes > 0 && decodedBytes % 2 === 0
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > maxBytes) throw new Error('request body is too large')
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function normalizeOrigins(values, fallback) {
  const input = Array.isArray(values) && values.length ? values : [fallback]
  return new Set(input.map(value => {
    const parsed = new URL(String(value))
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`trusted origin must contain only scheme and authority: ${value}`)
    }
    return parsed.origin
  }))
}

export function transportPolicy(config = {}) {
  return {
    openaiOrigins: normalizeOrigins(config.trustedOpenAIOrigins, OPENAI_API_ORIGIN),
    doubaoOrigins: normalizeOrigins(config.trustedDoubaoOrigins, DOUBAO_DUPLEX_ORIGIN),
  }
}

function endpointURL(value, fallback) {
  try { return new URL(String(value || fallback)) } catch { throw new Error('route endpoint is not a valid absolute URL') }
}

function validateRouteIdentity(route, protocol) {
  if (!route || typeof route !== 'object') throw new Error(`missing ${protocol} route`)
  if (route.protocol !== protocol) throw new Error(`route protocol must be ${protocol}`)
  if (route.adapter !== protocol) throw new Error(`route adapter must be ${protocol}`)
  if (!String(route.model || '').trim()) throw new Error('route model is required')
}

export function validateProviderRoute(route, protocol, policy = transportPolicy()) {
  validateRouteIdentity(route, protocol)
  if (protocol === 'openai-webrtc') {
    if (route.provider !== 'openai') throw new Error('OpenAI Realtime route provider must be openai')
    const url = endpointURL(route.baseURL, `${OPENAI_API_ORIGIN}/v1`)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.openaiOrigins.has(url.origin))) {
      throw new Error('OpenAI Realtime baseURL must use HTTPS')
    }
    if (!policy.openaiOrigins.has(url.origin)) throw new Error(`OpenAI Realtime origin is not trusted: ${url.origin}`)
    return { ...route, baseURL: url.toString().replace(/\/+$/, '') }
  }
  if (protocol === 'doubao-realtime-duplex') {
    if (route.provider !== 'doubao-speech') {
      throw new Error('Doubao Realtime route provider must be doubao-speech')
    }
    const url = endpointURL(route.endpoint, DOUBAO_DUPLEX_ENDPOINT)
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && policy.doubaoOrigins.has(url.origin))) {
      throw new Error('Doubao Realtime endpoint must use WSS')
    }
    if (!policy.doubaoOrigins.has(url.origin)) throw new Error(`Doubao Realtime origin is not trusted: ${url.origin}`)
    return { ...route, endpoint: url.toString() }
  }
  throw new Error(`unsupported Realtime voice protocol: ${protocol}`)
}

export function callsUrl(baseURL = `${OPENAI_API_ORIGIN}/v1`) {
  const base = String(baseURL || '').replace(/\/+$/, '')
  return (base.endsWith('/v1') ? base : `${base}/v1`) + '/realtime/calls'
}

function safetyIdentifier(profileId) {
  return createHash('sha256').update(`dsh-realtime-voice:${profileId}:${homedir()}`).digest('hex')
}

export function isSameOriginRequest(req) {
  const origin = String(req.headers?.origin || '')
  const host = String(req.headers?.host || '')
  if (!origin || !host) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

export const isSameOriginUpgrade = isSameOriginRequest

export function authorizeBrowserRequest(req, marker = REALTIME_MARKER_HEADER) {
  if (req.headers?.[marker] !== '1') return { ok: false, error: 'missing Realtime voice request marker' }
  const fetchSite = req.headers?.['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') return { ok: false, error: 'Realtime voice request must be same-origin' }
  return isSameOriginRequest(req)
    ? { ok: true }
    : { ok: false, error: 'Realtime voice request must be same-origin' }
}

/** Browser WebSocket cannot set custom headers, so use a same-origin subprotocol marker. */
export function authorizeWebSocketRequest(req) {
  const protocols = String(req.headers?.['sec-websocket-protocol'] || '')
    .split(',')
    .map(value => value.trim())
  if (!protocols.includes(REALTIME_WS_PROTOCOL)) return { ok: false, error: 'missing Realtime voice websocket protocol' }
  const fetchSite = req.headers?.['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') return { ok: false, error: 'Realtime voice websocket must be same-origin' }
  return isSameOriginRequest(req)
    ? { ok: true }
    : { ok: false, error: 'Realtime voice websocket must be same-origin' }
}

export function authorizeModelProbe(req) {
  return authorizeBrowserRequest(req, MODEL_PROBE_HEADER)
}

function rejectUpgrade(socket, status = '403 Forbidden', message = 'forbidden') {
  socket.end([
    `HTTP/1.1 ${status}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(message)}`,
    '',
    message,
  ].join('\r\n'))
}

function localError(socket, message, details = {}) {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'error', error: { message: String(message || 'Realtime voice error'), ...details } }))
}

async function describeUnexpectedResponse(response) {
  const status = response.statusCode || 'unknown'
  const logID = String(response.headers?.['x-tt-logid'] || '')
  let raw = ''
  try {
    for await (const chunk of response) {
      if (raw.length >= 8192) break
      raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    }
  } catch {
    // Status and request id remain useful when the response body cannot be read.
  }
  let diagnostic = ''
  try {
    const parsed = JSON.parse(raw)
    const error = object(parsed?.error)
    diagnostic = [error.code, error.message].filter(Boolean).map(String).join(' · ')
  } catch {
    diagnostic = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500)
  }
  return [`HTTP ${status}`, diagnostic, logID ? `X-Tt-Logid ${logID}` : ''].filter(Boolean).join(' · ')
}

export function probeDoubaoDuplex({ endpoint, apiKey, model, voice }, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const upstream = new WebSocket(String(endpoint || DOUBAO_DUPLEX_ENDPOINT), {
      headers: { 'X-Api-Key': String(apiKey || '') },
      handshakeTimeout: timeoutMs,
      maxPayload: MAX_PROVIDER_FRAME_BYTES,
    })
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close()
      if (error) reject(error)
      else resolve({ latencyMs: Math.round(performance.now() - startedAt) })
    }
    const timer = setTimeout(() => finish(new Error('豆包 Realtime 连接测试超时')), timeoutMs)
    upstream.on('open', () => upstream.send(JSON.stringify({
      type: 'session.create',
      event_id: randomUUID(),
      session: {
        type: 'realtime',
        id: randomUUID(),
        model: String(model || '1.2.6.1'),
        instructions: 'Connection test. Do not produce a response.',
        audio: {
          input: { format: { type: 'pcm', rate: 16000 } },
          output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: String(voice || 'zh_female_vv_jupiter_bigtts') },
        },
        tools: [],
      },
    })))
    upstream.on('message', (payload, binary) => {
      if (binary) return finish(new Error('豆包 Realtime 连接测试收到意外二进制响应'))
      let event
      try { event = parseProviderMessage(payload, binary) } catch (error) { return finish(error) }
      if (event.type === 'session.created') finish()
      if (event.type === 'error') finish(new Error(String(event.error?.message || '豆包 Realtime 拒绝了会话')))
    })
    upstream.on('unexpected-response', (_request, response) => {
      void describeUnexpectedResponse(response).then(
        detail => finish(new Error(`豆包 Realtime 鉴权失败：${detail}`)),
        () => finish(new Error(`豆包 Realtime 鉴权失败：HTTP ${response.statusCode || 'unknown'}`)),
      )
    })
    upstream.on('error', error => finish(new Error(`豆包 Realtime 连接失败：${error?.message || error}`)))
    upstream.on('close', (code, reason) => {
      if (!settled) finish(new Error(`豆包 Realtime 在完成测试前关闭：${reason?.toString() || `code ${code}`}`))
    })
  })
}

export function parseLocalMessage(data, isBinary) {
  if (isBinary) throw new Error('Realtime voice transport accepts JSON text frames only')
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  if (Buffer.byteLength(text, 'utf8') > MAX_PROVIDER_FRAME_BYTES) throw new Error('Realtime voice frame is too large')
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid Realtime voice event')
  return parsed
}

export const parseProviderMessage = parseLocalMessage

function functionResultEvent(message) {
  const callID = String(message.call_id || '')
  const output = String(message.output || '')
  if (!callID || callID.length > 240 || output.length > MAX_TEXT_CHARS) throw new Error('invalid tool result')
  return {
    type: 'conversation.item.create',
    event_id: randomUUID(),
    items: [{ call_id: callID, role: 'tool', content: [{ type: 'input_text', text: output }] }],
  }
}

export function safeUpstreamEvent(message, state, service) {
  switch (message.type) {
    case 'input_audio_buffer.append': {
      const audio = String(message.audio || '')
      if (!validPCMBase64(audio)) throw new Error('invalid or oversized PCM audio packet')
      return { type: message.type, event_id: randomUUID(), audio }
    }
    case 'input_audio_buffer.commit':
    case 'response.cancel':
    case 'response.create':
      return { type: message.type, event_id: randomUUID() }
    case 'preview.speak': {
      const preview = string(message.text, 500)
      if (!preview) throw new Error('voice preview text is required')
      const pcm = Buffer.from(DOUBAO_PREVIEW_PROMPT_PCM_BASE64, 'base64')
      const events = []
      for (let offset = 0; offset < pcm.length; offset += 3200) {
        events.push({ type: 'input_audio_buffer.append', event_id: randomUUID(), audio: pcm.subarray(offset, offset + 3200).toString('base64') })
      }
      events.push({ type: 'input_audio_buffer.commit', event_id: randomUUID() })
      return events
    }
    case 'tool.result': {
      const callID = String(message.call_id || '')
      if (!state.pendingToolCalls?.has(callID)) throw new Error('tool result does not match a pending call')
      const event = functionResultEvent(message)
      state.pendingToolCalls.delete(callID)
      return event
    }
    case 'context.update': {
      const next = service.session({ profileId: state.profileId, route: state.route, context: message.context })
      next.session.id = state.id
      return { type: 'session.update', event_id: randomUUID(), ...next }
    }
    case 'session.close':
      return { type: 'session.close', event_id: randomUUID() }
    default:
      throw new Error(`unsupported Realtime voice event: ${String(message.type || '')}`)
  }
}

function toolEvent(message, state) {
  // Doubao Duplex delivers function calls inside an `items` array:
  //   { type: 'response.function_call_arguments.done', items: [{ call_id, name, arguments }] }
  // OpenAI delivers them flat:
  //   { type: 'response.function_call_arguments.done', call_id, name, arguments }
  // Accept both; each item becomes one normalized tool event (or null when empty/duplicate).
  const raw = Array.isArray(message.items) && message.items.length > 0
    ? message.items
    : message.call_id !== undefined ? [message] : []
  const events = []
  for (const item of raw) {
    const callID = string(item.call_id, 240)
    const name = string(item.name, 240)
    const args = string(item.arguments ?? item.arguments_delta ?? '', MAX_TEXT_CHARS)
    if (!callID || !name || args === undefined) continue
    if (state.pendingToolCalls.has(callID)) continue
    state.pendingToolCalls.add(callID)
    events.push({ type: message.type, call_id: callID, name, arguments: args })
  }
  if (events.length === 0) return null
  return events.length === 1 ? events[0] : events
}

export function sanitizeProviderEvent(message, state) {
  if (!message || typeof message.type !== 'string') return null
  switch (message.type) {
    case 'session.created': {
      const id = string(object(message.session).id, 240)
      return { type: message.type, session: id ? { id } : {} }
    }
    case 'input_audio_buffer.speech_started':
    case 'input_audio_buffer.speech_stopped':
    case 'response.created':
    case 'response.done':
    case 'response.audio.done':
    case 'response.output_audio.done':
    case 'response.output_audio.started':
    case 'response.cancelled':
      return { type: message.type }
    case 'response.audio.delta':
    case 'response.output_audio.delta': {
      const delta = string(message.delta, MAX_AUDIO_BASE64_CHARS)
      return delta && validPCMBase64(delta) ? { type: message.type, delta } : null
    }
    case 'conversation.item.input_audio_transcription.started':
    case 'conversation.item.input_audio_transcription.delta':
    case 'conversation.item.input_audio_transcription.completed': {
      const transcript = string(message.delta ?? message.transcript)
      return transcript === undefined || transcript === '' ? null : { type: message.type, ...(message.type.endsWith('.completed') ? { transcript } : { delta: transcript }) }
    }
    case 'response.audio_transcript.delta':
    case 'response.audio_transcript.done':
    case 'response.output_audio_transcript.delta':
    case 'response.output_audio_transcript.done':
    case 'response.output_text.delta':
    case 'response.output_text.done':
    case 'response.text.delta':
    case 'response.text.done': {
      const transcript = string(message.delta ?? message.transcript ?? message.text)
      return transcript === undefined ? null : { type: message.type, ...(message.type.endsWith('.delta') ? { delta: transcript } : { transcript }) }
    }
    case 'response.function_call_arguments.done':
      return toolEvent(message, state)
    case 'error': {
      const error = object(message.error)
      return { type: 'error', error: { code: string(error.code, 240) || 'upstream_error', message: string(error.message, 1000) || 'Doubao Realtime error' } }
    }
    default:
      return null
  }
}

export function createStartupQueue(limit = MAX_STARTUP_EVENTS) {
  const events = []
  return {
    push(event) {
      if (events.length >= limit) throw new Error('Realtime voice startup queue overflow')
      events.push(event)
    },
    flush(consumer) {
      while (events.length) consumer(events.shift())
    },
    get size() { return events.length },
  }
}

function ownRoute(scope, register, label) {
  const dispose = register()
  if (typeof dispose !== 'function') throw new Error(`${label} registration did not return a disposer`)
  if (typeof scope.effect !== 'function') throw new Error(`${label} requires scope.effect lifecycle ownership`)
  scope.effect(() => dispose, label)
}

function registerDoubaoUpgrade(scope, service, path, policy) {
  const acceptor = new WebSocketServer({ noServer: true, maxPayload: MAX_PROVIDER_FRAME_BYTES })
  ownRoute(scope, () => scope.webServer.registerUpgrade({
    path,
    handler(req, socket, head) {
      const auth = authorizeWebSocketRequest(req)
      if (!auth.ok) return rejectUpgrade(socket, '403 Forbidden', auth.error)
      acceptor.handleUpgrade(req, socket, head, browser => {
        let upstream
        let starting = false
        let started = false
        let state
        const queue = createStartupQueue()

        const closeBoth = (code = 1000, reason = 'closed') => {
          if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
            try { upstream.close(code, reason.slice(0, 120)) } catch { upstream.terminate() }
          }
          if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) browser.close(code, reason.slice(0, 120))
        }
        const sendUpstream = message => {
          if (!upstream || upstream.readyState !== WebSocket.OPEN) throw new Error('Doubao Realtime upstream is not connected')
          const outgoing = safeUpstreamEvent(message, state, service)
          if (!Array.isArray(outgoing)) {
            trace('browser→upstream', outgoing.type + (outgoing.call_id ? ':' + outgoing.call_id : ''))
            return upstream.send(JSON.stringify(outgoing))
          }
          outgoing.forEach((event, index) => setTimeout(() => {
            if (upstream?.readyState === WebSocket.OPEN) {
              trace('browser→upstream', event.type)
              upstream.send(JSON.stringify(event))
            }
          }, index * 100))
        }
        const begin = async message => {
          starting = true
          try {
            const profileId = String(message.profileId || '')
            const candidate = await service.model(message.routeId, 'doubao-realtime-duplex')
            const route = validateProviderRoute(candidate, 'doubao-realtime-duplex', policy)
            const credential = await service.credential(route)
            if (!credential.value) throw new Error(`DSH host 未配置 ${credential.credentialRef || 'DOUBAO_API_KEY'}`)
            const initial = service.session({ profileId, route, context: message.context })
            state = { id: initial.session.id, profileId, route, pendingToolCalls: new Set() }
            trace('session.start profile=' + profileId + ' route=' + route.model + ' tools=' + (Array.isArray(initial.session.tools) ? initial.session.tools.length : 0) + ' ext=' + JSON.stringify(initial.extension || null))
            upstream = new WebSocket(route.endpoint, {
              headers: { 'X-Api-Key': credential.value },
              handshakeTimeout: 20_000,
              maxPayload: MAX_PROVIDER_FRAME_BYTES,
            })
            upstream.on('open', () => {
              trace('upstream session.create model=' + route.model)
              upstream.send(JSON.stringify({ type: 'session.create', event_id: randomUUID(), ...initial }))
            })
            upstream.on('message', (payload, binary) => {
              if (browser.readyState !== WebSocket.OPEN) return
              let message
              try { message = parseProviderMessage(payload, binary) } catch (error) {
                localError(browser, error?.message || error, { code: 'invalid_upstream_frame' })
                return closeBoth(1009, 'invalid upstream frame')
              }
              const event = sanitizeProviderEvent(message, state)
              if (!event) {
                trace('upstream→browser dropped', String(message.type || 'unknown'))
                return
              }
              const events = Array.isArray(event) ? event : [event]
              for (const single of events) {
                if (single.type === 'error') trace('upstream→browser error', single.error?.code || 'unknown', String(single.error?.message || '').slice(0, 300))
                else trace('upstream→browser', single.type)
                if (single.type === 'session.created') {
                  started = true
                  starting = false
                  state.id = String(single.session.id || state.id)
                  browser.send(JSON.stringify(single))
                  browser.send(JSON.stringify({ type: 'session.ready', session: { id: state.id } }))
                  try { queue.flush(sendUpstream) } catch (error) {
                    localError(browser, error?.message || error)
                    closeBoth(1011, 'startup queue failed')
                  }
                  return
                }
                browser.send(JSON.stringify(single))
              }
            })
            upstream.on('unexpected-response', (_request, response) => {
              void describeUnexpectedResponse(response).then(
                detail => localError(browser, `豆包 Realtime 初始化失败：${detail}`),
                () => localError(browser, `豆包 Realtime 初始化失败：HTTP ${response.statusCode || 'unknown'}`),
              )
            })
            upstream.on('error', error => localError(browser, `豆包 Realtime 初始化失败：${error?.message || error}`))
            upstream.on('close', (code, reason) => {
              if (browser.readyState !== WebSocket.OPEN) return
              localError(browser, `豆包 Realtime 连接已关闭：${reason?.toString() || `code ${code}`}`, { code })
              browser.close(code === 1000 ? 1000 : 1011, 'Doubao upstream closed')
            })
          } catch (error) {
            starting = false
            localError(browser, error?.message || error)
          }
        }

        browser.on('message', (data, isBinary) => {
          let message
          try { message = parseLocalMessage(data, isBinary) } catch (error) {
            localError(browser, error?.message || error)
            return
          }
          if (!started) {
            if (!starting) {
              if (message.type !== 'session.start') return localError(browser, 'first event must be session.start')
              void begin(message)
              return
            }
            try { queue.push(message) } catch (error) {
              localError(browser, error?.message || error, { code: 'startup_queue_overflow' })
              closeBoth(1009, 'startup queue overflow')
            }
            return
          }
          try { sendUpstream(message) } catch (error) { localError(browser, error?.message || error) }
        })
        browser.on('close', () => closeBoth())
        browser.on('error', () => closeBoth(1011, 'browser websocket error'))
      })
    },
  }), 'dsh-realtime-voice.doubao-upgrade')

  if (typeof scope.effect !== 'function') throw new Error('Doubao websocket server requires scope.effect lifecycle ownership')
  scope.effect(() => () => {
    for (const socket of acceptor.clients) socket.terminate()
    acceptor.close()
  }, 'dsh-realtime-voice.doubao-sockets')
}

function registerOpenAISession(scope, service, path, policy) {
  ownRoute(scope, () => scope.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        return res.end()
      }
      const auth = authorizeBrowserRequest(req)
      if (!auth.ok) return sendJson(res, 403, { ok: false, error: auth.error })
      try {
        const parsed = JSON.parse(await readBody(req) || '{}')
        const sdp = typeof parsed.sdp === 'string' ? parsed.sdp : ''
        if (!sdp.trim() || !sdp.startsWith('v=0')) return sendJson(res, 400, { ok: false, error: 'invalid SDP offer' })
        const candidate = await service.model(parsed.routeId, 'openai-webrtc')
        const route = validateProviderRoute(candidate, 'openai-webrtc', policy)
        const credential = await service.credential(route)
        if (!credential.value) throw new Error(`DSH host 未配置 ${credential.credentialRef || 'OPENAI_API_KEY'}`)
        const session = service.session({ profileId: parsed.profileId, route, context: parsed.context })
        const body = new FormData()
        body.set('sdp', sdp)
        body.set('session', JSON.stringify(session))
        const upstream = await fetch(callsUrl(route.baseURL), {
          method: 'POST',
          headers: { Authorization: `Bearer ${credential.value}`, 'OpenAI-Safety-Identifier': safetyIdentifier(parsed.profileId) },
          body,
          signal: AbortSignal.timeout(20_000),
        })
        const answer = await upstream.text()
        if (!upstream.ok) {
          let detail = answer.slice(0, 800)
          try { detail = JSON.parse(answer)?.error?.message || detail } catch { /* plain text */ }
          return sendJson(res, upstream.status, { ok: false, error: `OpenAI Realtime 初始化失败：${detail}` })
        }
        res.writeHead(200, { 'Content-Type': 'application/sdp' })
        res.end(answer)
      } catch (error) {
        const message = error?.name === 'TimeoutError' ? 'OpenAI Realtime 初始化超时' : String(error?.message || error)
        sendJson(res, 502, { ok: false, error: message })
      }
    },
  }), 'dsh-realtime-voice.openai-session')
}

function registerModelsRoute(scope, service, path) {
  ownRoute(scope, () => scope.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        return res.end()
      }
      try { sendJson(res, 200, { models: await service.publicModels() }) } catch (error) {
        sendJson(res, 500, { models: [], error: String(error?.message || error) })
      }
    },
  }), 'dsh-realtime-voice.models')
}

function registerDoubaoProbe(scope, service, path, policy) {
  ownRoute(scope, () => scope.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        return res.end()
      }
      const auth = authorizeModelProbe(req)
      if (!auth.ok) return sendJson(res, 403, { ok: false, error: auth.error })
      try {
        const candidate = await service.model(undefined, 'doubao-realtime-duplex')
        const route = validateProviderRoute(candidate, 'doubao-realtime-duplex', policy)
        const credential = await service.credential(route)
        if (!credential.value) throw new Error(`未配置 ${credential.credentialRef || 'DOUBAO_API_KEY'}`)
        const result = await probeDoubaoDuplex({ endpoint: route.endpoint, apiKey: credential.value, model: route.model, voice: route.voice })
        sendJson(res, 200, { ok: true, observedAt: new Date().toISOString(), ...result })
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message || error) })
      }
    },
  }), 'dsh-realtime-voice.doubao-probe')
}

export function registerRealtimeTransport(scope, service, config = {}) {
  const configuredPath = String(config.basePath || DEFAULT_BASE_PATH).replace(/\/+$/, '')
  const policy = transportPolicy(config)
  // The packaged Client has no Host composition config channel, so the default
  // path remains a stable alias when a legacy custom basePath is also mounted.
  for (const basePath of new Set([DEFAULT_BASE_PATH, configuredPath])) {
    registerModelsRoute(scope, service, `${basePath}/models`)
    registerOpenAISession(scope, service, `${basePath}/openai/session`, policy)
    registerDoubaoProbe(scope, service, `${basePath}/doubao/probe`, policy)
    if (typeof scope.webServer.registerUpgrade === 'function') registerDoubaoUpgrade(scope, service, `${basePath}/doubao`, policy)
  }
}

export { functionResultEvent }

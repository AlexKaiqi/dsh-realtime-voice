import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import WebSocket, { WebSocketServer } from 'ws'

export const DOUBAO_DUPLEX_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
const MAX_BODY_BYTES = 256 * 1024
const MAX_AUDIO_BASE64_CHARS = 256 * 1024
const MODEL_PROBE_HEADER = 'x-dsh-model-probe'

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
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

function callsUrl(baseURL = 'https://api.openai.com/v1') {
  const base = String(baseURL || '').replace(/\/+$/, '')
  return (base.endsWith('/v1') ? base : `${base}/v1`) + '/realtime/calls'
}

function safetyIdentifier(profileId) {
  return createHash('sha256').update(`dsh-realtime-voice:${profileId}:${homedir()}`).digest('hex')
}

export function isSameOriginUpgrade(req) {
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

export function authorizeModelProbe(req) {
  if (req.headers?.[MODEL_PROBE_HEADER] !== '1') {
    return { ok: false, error: 'missing model probe request marker' }
  }
  const fetchSite = req.headers?.['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') {
    return { ok: false, error: 'model probe must be same-origin' }
  }
  return isSameOriginUpgrade(req)
    ? { ok: true }
    : { ok: false, error: 'model probe must be a same-origin Settings request' }
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
    // HTTP status and request id are still useful diagnostics.
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
    const started = performance.now()
    const upstream = new WebSocket(String(endpoint || DOUBAO_DUPLEX_ENDPOINT), {
      headers: { 'X-Api-Key': String(apiKey || '') },
      handshakeTimeout: timeoutMs,
    })
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close()
      if (error) reject(error)
      else resolve({ latencyMs: Math.round(performance.now() - started) })
    }
    const timer = setTimeout(() => finish(new Error('豆包 Realtime 连接测试超时')), timeoutMs)
    upstream.on('open', () => {
      upstream.send(JSON.stringify({
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
      }))
    })
    upstream.on('message', (payload, binary) => {
      if (binary) {
        finish(new Error('豆包 Realtime 连接测试收到意外二进制响应'))
        return
      }
      let event
      try { event = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)) } catch { event = null }
      if (event?.type === 'session.created') finish()
      if (event?.type === 'error') finish(new Error(String(event.error?.message || '豆包 Realtime 拒绝了会话')))
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

function parseLocalMessage(data, isBinary) {
  if (isBinary) throw new Error('Realtime voice transport accepts JSON text frames only')
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024) throw new Error('Realtime voice frame is too large')
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid Realtime voice event')
  return parsed
}

function functionResultEvent(message) {
  const callID = String(message.call_id || '')
  const output = String(message.output || '')
  if (!callID || callID.length > 240 || output.length > 64_000) throw new Error('invalid tool result')
  return {
    type: 'conversation.item.create',
    event_id: randomUUID(),
    items: [{ call_id: callID, role: 'tool', content: [{ type: 'input_text', text: output }] }],
  }
}

function safeUpstreamEvent(message, state, service) {
  switch (message.type) {
    case 'input_audio_buffer.append': {
      const audio = String(message.audio || '')
      if (!audio || audio.length > MAX_AUDIO_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) {
        throw new Error('invalid or oversized PCM audio packet')
      }
      return { type: message.type, event_id: randomUUID(), audio }
    }
    case 'input_audio_buffer.commit':
    case 'response.cancel':
      return { type: message.type, event_id: randomUUID() }
    case 'tool.result':
      return functionResultEvent(message)
    case 'context.update': {
      const next = service.session({
        profileId: state.profileId,
        route: state.route,
        context: message.context,
      })
      next.session.id = state.id
      return { type: 'session.update', event_id: randomUUID(), ...next }
    }
    case 'session.close':
      return { type: 'session.close', event_id: randomUUID() }
    default:
      throw new Error(`unsupported Realtime voice event: ${String(message.type || '')}`)
  }
}

function registerDoubaoUpgrade(scope, service, path) {
  const acceptor = new WebSocketServer({ noServer: true })
  const disposeRoute = scope.webServer.registerUpgrade({
    path,
    handler(req, socket, head) {
      if (!isSameOriginUpgrade(req)) {
        rejectUpgrade(socket)
        return
      }
      acceptor.handleUpgrade(req, socket, head, browser => {
        let upstream
        let starting = false
        let started = false
        let state

        const closeBoth = (code = 1000, reason = 'closed') => {
          if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
            try { upstream.close(code, reason.slice(0, 120)) } catch { upstream.terminate() }
          }
          if (browser.readyState === WebSocket.OPEN) browser.close(code, reason.slice(0, 120))
        }

        browser.on('message', async (data, isBinary) => {
          let message
          try { message = parseLocalMessage(data, isBinary) } catch (error) {
            localError(browser, error?.message || error)
            return
          }

          if (!started) {
            if (starting || message.type !== 'session.start') {
              localError(browser, starting ? 'Realtime voice session is still starting' : 'first event must be session.start')
              return
            }
            starting = true
            try {
              const profileId = String(message.profileId || '')
              const route = await service.model(message.routeId, 'doubao-realtime-duplex')
              if (!route) throw new Error('模型注册表中没有豆包 Realtime Duplex 路由')
              const credential = await service.credential(route)
              if (!credential.value) throw new Error(`DSH host 未配置 ${credential.credentialRef || 'DOUBAO_API_KEY'}`)
              const initial = service.session({ profileId, route, context: message.context })
              state = { id: initial.session.id, profileId, route }
              upstream = new WebSocket(String(route.endpoint || DOUBAO_DUPLEX_ENDPOINT), {
                headers: { 'X-Api-Key': credential.value },
                handshakeTimeout: 20_000,
              })
              upstream.on('open', () => {
                upstream.send(JSON.stringify({ type: 'session.create', event_id: randomUUID(), ...initial }))
              })
              upstream.on('message', (payload, binary) => {
                if (browser.readyState !== WebSocket.OPEN) return
                if (binary) {
                  localError(browser, 'Doubao Duplex returned an unexpected binary frame')
                  return
                }
                const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
                let event
                try { event = JSON.parse(text) } catch { event = null }
                if (event?.type === 'session.created') {
                  started = true
                  starting = false
                  state.id = String(event.session?.id || state.id)
                }
                browser.send(text)
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
            return
          }

          if (!upstream || upstream.readyState !== WebSocket.OPEN) {
            localError(browser, 'Doubao Realtime upstream is not connected')
            return
          }
          try { upstream.send(JSON.stringify(safeUpstreamEvent(message, state, service))) } catch (error) {
            localError(browser, error?.message || error)
          }
        })
        browser.on('close', () => closeBoth())
        browser.on('error', () => closeBoth(1011, 'browser websocket error'))
      })
    },
  })

  if (typeof scope.effect === 'function') {
    scope.effect(() => () => {
      for (const socket of acceptor.clients) socket.terminate()
      acceptor.close()
      disposeRoute()
    }, 'dsh-realtime-voice.doubao')
  }
}

function registerOpenAISession(scope, service, path) {
  scope.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      if (req.headers['x-dsh-realtime-voice'] !== '1' && req.headers['x-dsh-talk-to-text'] !== '1') {
        sendJson(res, 403, { ok: false, error: 'missing Realtime voice request marker' })
        return
      }
      try {
        const parsed = JSON.parse(await readBody(req) || '{}')
        const sdp = typeof parsed.sdp === 'string' ? parsed.sdp : ''
        if (!sdp.trim() || !sdp.startsWith('v=0')) {
          sendJson(res, 400, { ok: false, error: 'invalid SDP offer' })
          return
        }
        const route = await service.model(parsed.routeId, 'openai-webrtc')
        if (!route) throw new Error('模型注册表中没有可用的 OpenAI Realtime 模型')
        const credential = await service.credential(route)
        if (!credential.value) throw new Error(`DSH host 未配置 ${credential.credentialRef || 'OPENAI_API_KEY'}`)
        const session = service.session({ profileId: parsed.profileId, route, context: parsed.context })
        const body = new FormData()
        body.set('sdp', sdp)
        body.set('session', JSON.stringify(session))
        const upstream = await fetch(callsUrl(route.baseURL), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential.value}`,
            'OpenAI-Safety-Identifier': safetyIdentifier(parsed.profileId),
          },
          body,
          signal: AbortSignal.timeout(20_000),
        })
        const answer = await upstream.text()
        if (!upstream.ok) {
          let detail = answer.slice(0, 800)
          try { detail = JSON.parse(answer)?.error?.message || detail } catch { /* plain text */ }
          sendJson(res, upstream.status, { ok: false, error: `OpenAI Realtime 初始化失败：${detail}` })
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/sdp' })
        res.end(answer)
      } catch (error) {
        const message = error?.name === 'TimeoutError' ? 'OpenAI Realtime 初始化超时' : String(error?.message || error)
        sendJson(res, 502, { ok: false, error: message })
      }
    },
  })
}

function registerModelsRoute(scope, service, path) {
  scope.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      try { sendJson(res, 200, { models: await service.publicModels() }) } catch (error) {
        sendJson(res, 500, { models: [], error: String(error?.message || error) })
      }
    },
  })
}

function registerDoubaoProbe(scope, service, path) {
  scope.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const auth = authorizeModelProbe(req)
      if (!auth.ok) {
        sendJson(res, 403, { ok: false, error: auth.error })
        return
      }
      try {
        const route = await service.model(undefined, 'doubao-realtime-duplex')
        if (!route) throw new Error('模型注册表中没有已启用的豆包 Realtime Duplex 路由')
        const credential = await service.credential(route)
        if (!credential.value) throw new Error(`未配置 ${credential.credentialRef || 'DOUBAO_API_KEY'}`)
        const result = await probeDoubaoDuplex({
          endpoint: route.endpoint,
          apiKey: credential.value,
          model: route.model,
          voice: route.voice,
        })
        sendJson(res, 200, { ok: true, observedAt: new Date().toISOString(), ...result })
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message || error) })
      }
    },
  })
}

export function registerRealtimeTransport(scope, service, config = {}) {
  const basePath = String(config.basePath || '/dsh-realtime-voice').replace(/\/+$/, '')
  registerModelsRoute(scope, service, `${basePath}/models`)
  registerOpenAISession(scope, service, `${basePath}/openai/session`)
  registerDoubaoProbe(scope, service, `${basePath}/doubao/probe`)
  if (typeof scope.webServer.registerUpgrade === 'function') {
    registerDoubaoUpgrade(scope, service, `${basePath}/doubao`)
  }
}

export { callsUrl, functionResultEvent, parseLocalMessage, safeUpstreamEvent }

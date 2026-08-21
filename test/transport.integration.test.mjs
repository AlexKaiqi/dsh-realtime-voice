import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { connect } from 'node:net'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { registerRealtimeTransport } from '../dsh/transport.js'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server) {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

function nextJson(socket, timeout = 2_000) {
  return Promise.race([
    once(socket, 'message').then(([data]) => JSON.parse(String(data))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for websocket message')), timeout)),
  ])
}

function transportHarness(service) {
  const routes = []
  const upgrades = []
  const cleanups = []
  const scope = {
    webServer: {
      register(route) { routes.push(route); return () => {} },
      registerUpgrade(route) { upgrades.push(route); return () => {} },
    },
    effect(callback) { cleanups.push(callback()) },
  }
  registerRealtimeTransport(scope, service, { basePath: '/voice' })
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const route = routes.find(candidate => candidate.path === path)
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const route = upgrades.find(candidate => candidate.path === path)
    if (!route) {
      socket.destroy()
      return
    }
    route.handler(req, socket, head)
  })
  return {
    server,
    async close() {
      for (const cleanup of cleanups.reverse()) cleanup()
      await closeServer(server)
    },
  }
}

test('OpenAI transport performs a real local SDP exchange and keeps the API key upstream-only', async () => {
  let upstreamRequest
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    upstreamRequest = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      safetyIdentifier: req.headers['openai-safety-identifier'],
      body: Buffer.concat(chunks).toString('utf8'),
    }
    res.writeHead(200, { 'content-type': 'application/sdp' })
    res.end('v=0\r\no=mock-answer')
  })
  const upstreamURL = await listen(upstream)
  const service = {
    async publicModels() { return [{ id: 'openai/gpt-realtime', available: true }] },
    async model(routeId, protocol) {
      assert.equal(protocol, 'openai-webrtc')
      assert.equal(routeId, 'openai/gpt-realtime')
      return { id: routeId, model: 'gpt-realtime', baseURL: `${upstreamURL}/v1`, adapter: 'openai-webrtc' }
    },
    async credential() { return { value: 'server-only-secret', credentialRef: 'OPENAI_API_KEY' } },
    session({ profileId, context }) {
      assert.equal(profileId, 'session-assistant')
      return { type: 'realtime', model: 'gpt-realtime', instructions: context }
    },
  }
  const harness = transportHarness(service)
  const baseURL = await listen(harness.server)
  try {
    const response = await fetch(`${baseURL}/voice/openai/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-realtime-voice': '1' },
      body: JSON.stringify({
        routeId: 'openai/gpt-realtime',
        profileId: 'session-assistant',
        context: 'current draft',
        sdp: 'v=0\r\no=mock-offer',
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/sdp')
    const answer = await response.text()
    assert.equal(answer, 'v=0\r\no=mock-answer')
    assert.deepEqual(upstreamRequest, {
      method: 'POST',
      url: '/v1/realtime/calls',
      authorization: 'Bearer server-only-secret',
      safetyIdentifier: upstreamRequest.safetyIdentifier,
      body: upstreamRequest.body,
    })
    assert.match(upstreamRequest.safetyIdentifier, /^[a-f0-9]{64}$/)
    assert.match(upstreamRequest.body, /mock-offer/)
    assert.match(upstreamRequest.body, /current draft/)
    assert.doesNotMatch(answer, /server-only-secret/)

    const missingMarker = await fetch(`${baseURL}/voice/openai/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdp: 'v=0\r\no=offer' }),
    })
    assert.equal(missingMarker.status, 403)

    const invalidSdp = await fetch(`${baseURL}/voice/openai/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-realtime-voice': '1' },
      body: JSON.stringify({ sdp: 'not-sdp' }),
    })
    assert.equal(invalidSdp.status, 400)
  } finally {
    await harness.close()
    await closeServer(upstream)
  }
})

test('Doubao Settings probe uses the realtime-voice route, enforces same-origin, and completes a minimal upstream session', async () => {
  const upstreamHTTP = createServer()
  const upstreamWSS = new WebSocketServer({ server: upstreamHTTP })
  const upstreamURL = (await listen(upstreamHTTP)).replace(/^http/, 'ws')
  let upstreamHeaders
  let sessionCreate
  upstreamWSS.on('connection', (socket, request) => {
    upstreamHeaders = request.headers
    socket.once('message', data => {
      sessionCreate = JSON.parse(String(data))
      socket.send(JSON.stringify({ type: 'session.created', session: { id: 'probe-session' } }))
    })
  })
  let modelCalls = 0
  const service = {
    async publicModels() { return [] },
    async model(routeId, protocol) {
      modelCalls += 1
      assert.equal(routeId, undefined)
      assert.equal(protocol, 'doubao-realtime-duplex')
      return { id: 'doubao/ready', model: '1.2.6.1', endpoint: upstreamURL, voice: 'probe-voice' }
    },
    async credential() { return { value: 'probe-secret', credentialRef: 'DOUBAO_API_KEY' } },
  }
  const harness = transportHarness(service)
  const baseURL = await listen(harness.server)
  try {
    const response = await fetch(`${baseURL}/voice/doubao/probe`, {
      method: 'POST',
      headers: {
        origin: baseURL,
        'sec-fetch-site': 'same-origin',
        'x-dsh-model-probe': '1',
      },
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.ok, true)
    assert.match(result.observedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(Number.isFinite(result.latencyMs), true)
    assert.equal(upstreamHeaders['x-api-key'], 'probe-secret')
    assert.equal(sessionCreate.type, 'session.create')
    assert.equal(sessionCreate.session.model, '1.2.6.1')
    assert.equal(sessionCreate.session.audio.output.voice, 'probe-voice')
    assert.deepEqual(sessionCreate.session.tools, [])

    const missingMarker = await fetch(`${baseURL}/voice/doubao/probe`, {
      method: 'POST', headers: { origin: baseURL },
    })
    assert.equal(missingMarker.status, 403)
    const crossOrigin = await fetch(`${baseURL}/voice/doubao/probe`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'x-dsh-model-probe': '1' },
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal(modelCalls, 1)
  } finally {
    for (const socket of upstreamWSS.clients) socket.terminate()
    upstreamWSS.close()
    await once(upstreamWSS, 'close').catch(() => {})
    await harness.close()
    await closeServer(upstreamHTTP)
  }
})

test('Doubao transport bridges a real local websocket session, audio, context, tools, and cancellation', async () => {
  const upstreamHTTP = createServer()
  const upstreamWSS = new WebSocketServer({ server: upstreamHTTP })
  const upstreamURL = (await listen(upstreamHTTP)).replace(/^http/, 'ws')
  let upstreamHeaders
  const upstreamConnected = new Promise(resolve => {
    upstreamWSS.once('connection', (socket, request) => {
      upstreamHeaders = request.headers
      resolve(socket)
    })
  })
  const sessions = []
  const service = {
    async publicModels() { return [{ id: 'doubao/realtime', available: true }] },
    async model(routeId, protocol) {
      assert.equal(protocol, 'doubao-realtime-duplex')
      return { id: routeId, model: '1.2.6.1', endpoint: upstreamURL, adapter: protocol }
    },
    async credential() { return { value: 'doubao-server-secret', credentialRef: 'DOUBAO_API_KEY' } },
    session({ profileId, route, context }) {
      const built = {
        session: {
          id: `session-${sessions.length + 1}`,
          type: 'realtime',
          model: route.model,
          instructions: `${profileId}:${context}`,
          tools: [{ name: 'submit_to_agent' }],
        },
      }
      sessions.push(built)
      return built
    },
  }
  const harness = transportHarness(service)
  const baseURL = await listen(harness.server)
  const wsURL = baseURL.replace(/^http/, 'ws')
  const browser = new WebSocket(`${wsURL}/voice/doubao`, {
    headers: { origin: baseURL },
  })
  try {
    await once(browser, 'open')
    browser.send(JSON.stringify({
      type: 'session.start',
      routeId: 'doubao/realtime',
      profileId: 'session-assistant',
      context: 'initial draft',
    }))
    const upstreamSocket = await upstreamConnected
    assert.equal(upstreamHeaders['x-api-key'], 'doubao-server-secret')
    const create = await nextJson(upstreamSocket)
    assert.equal(create.type, 'session.create')
    assert.equal(create.session.instructions, 'session-assistant:initial draft')
    upstreamSocket.send(JSON.stringify({ type: 'session.created', session: { id: 'upstream-session' } }))
    assert.equal((await nextJson(browser)).session.id, 'upstream-session')

    browser.send(JSON.stringify({ type: 'context.update', context: 'updated draft' }))
    const update = await nextJson(upstreamSocket)
    assert.equal(update.type, 'session.update')
    assert.equal(update.session.id, 'upstream-session')
    assert.equal(update.session.instructions, 'session-assistant:updated draft')

    browser.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from('pcm').toString('base64') }))
    assert.equal((await nextJson(upstreamSocket)).type, 'input_audio_buffer.append')
    browser.send(JSON.stringify({ type: 'tool.result', call_id: 'call-1', output: 'draft submitted' }))
    const tool = await nextJson(upstreamSocket)
    assert.equal(tool.type, 'conversation.item.create')
    assert.equal(tool.items[0].call_id, 'call-1')
    browser.send(JSON.stringify({ type: 'response.cancel' }))
    assert.equal((await nextJson(upstreamSocket)).type, 'response.cancel')

    upstreamSocket.send(JSON.stringify({ type: 'response.audio.delta', delta: 'AAAA' }))
    assert.deepEqual(await nextJson(browser), { type: 'response.audio.delta', delta: 'AAAA' })
  } finally {
    if (browser.readyState !== WebSocket.CLOSED) {
      const closed = once(browser, 'close')
      browser.close()
      await closed
    }
    for (const socket of upstreamWSS.clients) socket.terminate()
    upstreamWSS.close()
    await once(upstreamWSS, 'close').catch(() => {})
    await harness.close()
    await closeServer(upstreamHTTP)
  }
})

test('Doubao websocket rejects cross-origin browser upgrades before contacting upstream', async () => {
  let modelCalls = 0
  const harness = transportHarness({
    async publicModels() { return [] },
    async model() { modelCalls += 1 },
  })
  const baseURL = await listen(harness.server)
  const target = new URL(baseURL)
  const browser = connect({ host: target.hostname, port: Number(target.port) })
  try {
    await once(browser, 'connect')
    browser.write([
      'GET /voice/doubao HTTP/1.1',
      `Host: ${target.host}`,
      'Origin: https://evil.example',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'))
    const [response] = await once(browser, 'data')
    assert.match(String(response), /^HTTP\/1\.1 403 Forbidden\r\n/)
    assert.equal(modelCalls, 0)
  } finally {
    browser.destroy()
    await harness.close()
  }
})

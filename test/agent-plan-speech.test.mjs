import { gzipSync } from 'node:zlib'
import { createServer } from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { doubaoAgentPlanSpeechAdapter } from '../dsh/agent-plan-speech.js'

function finalResponse(text) {
  const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text } })))
  const frame = Buffer.alloc(12 + payload.length)
  frame.set([0x11, 0x93, 0x11, 0x00], 0)
  frame.writeInt32BE(-3, 4)
  frame.writeUInt32BE(payload.length, 8)
  payload.copy(frame, 12)
  return frame
}

test('Agent Plan task adapter frames PCM for Seed ASR and returns final text', async t => {
  const server = new WebSocketServer({ port: 0 })
  t.after(() => new Promise(resolve => server.close(resolve)))
  await new Promise(resolve => server.once('listening', resolve))
  server.on('headers', headers => headers.push('X-Tt-Logid: test-log-id'))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  let headers = {}
  let fullRequestSeen = false
  server.on('connection', (socket, request) => {
    headers = request.headers
    socket.on('message', raw => {
      const frame = Buffer.from(raw)
      const messageType = frame[1] >> 4
      const flags = frame[1] & 0x0f
      if (messageType === 0x1) fullRequestSeen = true
      if (messageType === 0x2 && (flags & 0x02) !== 0) socket.send(finalResponse('最终识别文本'))
    })
  })
  const endpoint = `ws://127.0.0.1:${address.port}`
  const adapter = doubaoAgentPlanSpeechAdapter({ asrFinalEndpoint: endpoint })
  const result = await adapter.invoke({
    route: {
      id: 'doubao-agent-plan/seed-asr-2.0-stream',
      connection: { provider: 'doubao-speech' },
      registration: { model: 'volc.seedasr.sauc.duration', task: 'transcription' },
    },
    operation: 'transcribe-file',
    request: { pcm16Base64: Buffer.alloc(640).toString('base64'), sampleRate: 16_000, channels: 1 },
    credentials: { apiKey: 'test-only' },
  }, new AbortController().signal)
  assert.equal(fullRequestSeen, true)
  assert.equal(headers['x-api-key'], 'test-only')
  assert.equal(headers['x-api-resource-id'], 'volc.seedasr.sauc.duration')
  assert.deepEqual(result.output, { text: '最终识别文本' })
  assert.equal(result.metrics.providerRequestId, 'test-log-id')
})

test('Agent Plan task adapter aggregates Seed TTS HTTP chunks into a trusted audio artifact', async t => {
  let requestHeaders = {}
  let requestBody = ''
  const server = createServer(async (req, res) => {
    requestHeaders = req.headers
    for await (const chunk of req) requestBody += chunk
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Tt-Logid': 'tts-log-id' })
    res.write(`${JSON.stringify({ code: 0, data: Buffer.from([1, 2]).toString('base64') })}\n`)
    res.write(`${JSON.stringify({ code: 0, data: Buffer.from([3, 4]).toString('base64') })}\n`)
    res.end(`${JSON.stringify({ code: 20000000 })}\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  let stored
  const adapter = doubaoAgentPlanSpeechAdapter({
    ttsEndpoint: `http://127.0.0.1:${address.port}/tts`,
    audioArtifacts: { put(bytes, mediaType) { stored = { bytes: Buffer.from(bytes), mediaType }; return '/voice/artifacts/audio/id' } },
  })
  const result = await adapter.invoke({
    route: {
      id: 'doubao-agent-plan/seed-tts-2.0-http',
      connection: { provider: 'doubao-speech' },
      registration: { model: 'seed-tts-2.0', task: 'speech-synthesis', execution: 'request-response' },
    },
    operation: 'synthesize',
    request: { text: '你好' },
    credentials: { apiKey: 'test-only' },
  }, new AbortController().signal)
  assert.equal(requestHeaders['x-api-key'], 'test-only')
  assert.equal(requestHeaders['x-api-resource-id'], 'seed-tts-2.0')
  assert.deepEqual(JSON.parse(requestBody), { req_params: { text: '你好', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24000 } } })
  assert.deepEqual(stored, { bytes: Buffer.from([1, 2, 3, 4]), mediaType: 'audio/mpeg' })
  assert.deepEqual(result.output, { uri: '/voice/artifacts/audio/id', mediaType: 'audio/mpeg' })
  assert.equal(result.metrics.providerRequestId, 'tts-log-id')
})

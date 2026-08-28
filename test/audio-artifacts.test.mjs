import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { createAudioArtifactStore } from '../dsh/audio-artifacts.js'

function response() {
  const state = { status: 0, headers: {}, body: Buffer.alloc(0) }
  return {
    state,
    writeHead(status, headers = {}) { state.status = status; state.headers = headers },
    end(body = '') { state.body = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body)) },
  }
}

test('serves only opaque same-origin ephemeral audio artifacts with range support', () => {
  const store = createAudioArtifactStore('/voice-test')
  const uri = store.put(Buffer.from([1, 2, 3, 4]), 'audio/mpeg')
  assert.match(uri, /^\/voice-test\/artifacts\/audio\/[0-9a-f-]{36}$/)
  const full = response()
  store.outputHandler({ method: 'GET', url: uri, headers: { 'sec-fetch-site': 'same-origin' } }, full)
  assert.equal(full.state.status, 200)
  assert.deepEqual(full.state.body, Buffer.from([1, 2, 3, 4]))
  assert.equal(full.state.headers['Cross-Origin-Resource-Policy'], 'same-origin')
  const partial = response()
  store.outputHandler({ method: 'GET', url: uri, headers: { range: 'bytes=1-2', 'sec-fetch-site': 'same-origin' } }, partial)
  assert.equal(partial.state.status, 206)
  assert.deepEqual(partial.state.body, Buffer.from([2, 3]))
  const crossSite = response()
  store.outputHandler({ method: 'GET', url: uri, headers: { 'sec-fetch-site': 'cross-site' } }, crossSite)
  assert.equal(crossSite.state.status, 403)
  store.clear()
})

test('accepts bounded same-origin PCM uploads and exposes them once to the ASR adapter', async () => {
  const store = createAudioArtifactStore('/voice-test')
  const req = Readable.from([Buffer.from([1, 0, 2, 0])])
  req.method = 'POST'
  req.url = '/voice-test/artifacts/input'
  req.headers = {
    host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081', 'sec-fetch-site': 'same-origin',
    'x-dsh-voice-artifact': '1', 'content-type': 'application/octet-stream', 'x-dsh-audio-sample-rate': '16000',
  }
  const uploaded = response()
  await store.uploadHandler(req, uploaded)
  assert.equal(uploaded.state.status, 201)
  const body = JSON.parse(uploaded.state.body.toString('utf8'))
  const artifact = store.takeInput(body.id)
  assert.deepEqual(artifact.pcm, Buffer.from([1, 0, 2, 0]))
  assert.equal(artifact.sampleRate, 16000)
  assert.throws(() => store.takeInput(body.id), /missing or expired/)
  store.clear()
})

test('rejects inline-unsafe media types and oversized artifacts', () => {
  const store = createAudioArtifactStore('/voice-test')
  assert.throws(() => store.put(Buffer.from('x'), 'text/html'), /unsupported audio media type/)
  assert.throws(() => store.put(Buffer.alloc(12 * 1024 * 1024 + 1), 'audio/mpeg'), /12 MiB/)
  store.clear()
})

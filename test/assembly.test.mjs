import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, validateConfig } from '../dsh/index.js'

function assemblyHarness() {
  const adapters = []
  const routes = []
  const upgrades = []
  const disposed = []
  const cleanups = []
  const scope = {
    realtimeModelRuntime: {
      registerAdapter(adapter) { adapters.push(adapter); return () => disposed.push(`adapter:${adapter.id}`) },
      publicModels: async () => [],
    },
    webServer: {
      register(route) { routes.push(route); return () => disposed.push(`route:${route.path}`) },
      registerUpgrade(route) { upgrades.push(route); return () => disposed.push(`upgrade:${route.path}`) },
    },
    effect(callback) { cleanups.push(callback()) },
  }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer', 'realtimeModelRuntime'])
      callback(scope)
    },
  }
  return { adapters, routes, upgrades, disposed, cleanups, ctx }
}

test('registers provider adapters and every existing transport route', () => {
  const harness = assemblyHarness()
  apply(harness.ctx, { enabled: true, basePath: '/dsh-realtime-voice' })
  assert.deepEqual(harness.adapters.map(adapter => adapter.id), ['openai-webrtc', 'doubao-realtime-duplex'])
  assert.deepEqual(harness.routes.map(route => route.path), [
    '/dsh-realtime-voice/client.js',
    '/dsh-realtime-voice/audio-input-worklet.js',
    '/dsh-realtime-voice/models',
    '/dsh-realtime-voice/openai/session',
    '/dsh-realtime-voice/doubao/probe',
    '/dsh-voice-agent/audio-input-worklet.js',
    '/dsh-voice-agent/models',
    '/dsh-voice-agent/openai/session',
    '/dsh-voice-agent/doubao/probe',
  ])
  assert.deepEqual(harness.upgrades.map(route => route.path), ['/dsh-realtime-voice/doubao', '/dsh-voice-agent/doubao'])
})

test('unload disposes adapters, routes, upgrades, and supports a clean reload', () => {
  const first = assemblyHarness()
  apply(first.ctx, { enabled: true, basePath: '/dsh-realtime-voice' })
  for (const cleanup of first.cleanups.reverse()) cleanup()
  assert.equal(first.disposed.filter(value => value.startsWith('adapter:')).length, 2)
  assert.equal(first.disposed.filter(value => value.startsWith('route:')).length, 9)
  assert.equal(first.disposed.filter(value => value.startsWith('upgrade:')).length, 2)

  const second = assemblyHarness()
  apply(second.ctx, { enabled: true, basePath: '/dsh-realtime-voice' })
  assert.equal(second.routes.length, 9)
  assert.equal(second.upgrades.length, 2)
  for (const cleanup of second.cleanups.reverse()) cleanup()
})

test('keeps the short-lived voice-agent path as an alias for a custom base path', () => {
  const harness = assemblyHarness()
  apply(harness.ctx, { enabled: true, basePath: '/voice' })
  assert.equal(harness.routes.length, 13)
  assert.equal(harness.upgrades.length, 3)
  assert.equal(harness.routes.some(route => route.path === '/dsh-voice-agent/models'), true)
  assert.equal(harness.routes.some(route => route.path === '/dsh-realtime-voice/models'), true)
  assert.equal(harness.routes.some(route => route.path === '/voice/models'), true)
  assert.equal(harness.routes.some(route => route.path === '/voice/audio-input-worklet.js'), true)
  assert.equal(harness.upgrades.some(route => route.path === '/dsh-voice-agent/doubao'), true)
  assert.equal(harness.upgrades.some(route => route.path === '/dsh-realtime-voice/doubao'), true)
  assert.equal(harness.upgrades.some(route => route.path === '/voice/doubao'), true)
})

test('serves the AudioWorklet module as same-origin JavaScript and rejects writes', () => {
  const harness = assemblyHarness()
  apply(harness.ctx, { enabled: true, basePath: '/dsh-realtime-voice' })
  const route = harness.routes.find(candidate => candidate.path === '/dsh-realtime-voice/audio-input-worklet.js')
  const response = () => {
    const state = { status: 0, headers: {}, body: Buffer.alloc(0) }
    return {
      state,
      writeHead(status, headers = {}) { state.status = status; state.headers = headers },
      end(body = '') { state.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body)) },
    }
  }
  const get = response()
  route.handler({ method: 'GET' }, get)
  assert.equal(get.state.status, 200)
  assert.equal(get.state.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.match(get.state.body.toString('utf8'), /registerProcessor\('dsh-realtime-voice-input'/)
  const post = response()
  route.handler({ method: 'POST' }, post)
  assert.equal(post.state.status, 405)
  assert.equal(post.state.headers.allow, 'GET')
})

test('validates base path and trusted origin configuration', () => {
  assert.throws(() => validateConfig({ enabled: true, basePath: 'relative' }), /absolute URL path/)
  assert.throws(() => validateConfig({ enabled: true, basePath: '/voice', trustedOpenAIOrigins: ['ftp://example.com'] }), /scheme and authority/)
  assert.throws(() => validateConfig({ enabled: true, basePath: '/voice', trustedDoubaoOrigins: [] }), /at least one/)
  assert.doesNotThrow(() => validateConfig({ enabled: true, basePath: '/voice', trustedOpenAIOrigins: ['https://api.openai.com'], trustedDoubaoOrigins: ['wss://openspeech.bytedance.com'] }))
})

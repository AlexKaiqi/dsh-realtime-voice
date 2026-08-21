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
    '/dsh-realtime-voice/models',
    '/dsh-realtime-voice/openai/session',
    '/dsh-realtime-voice/doubao/probe',
  ])
  assert.deepEqual(harness.upgrades.map(route => route.path), ['/dsh-realtime-voice/doubao'])
})

test('unload disposes adapters, routes, upgrades, and supports a clean reload', () => {
  const first = assemblyHarness()
  apply(first.ctx, { enabled: true, basePath: '/dsh-realtime-voice' })
  for (const cleanup of first.cleanups.reverse()) cleanup()
  assert.equal(first.disposed.filter(value => value.startsWith('adapter:')).length, 2)
  assert.equal(first.disposed.filter(value => value.startsWith('route:')).length, 3)
  assert.equal(first.disposed.filter(value => value.startsWith('upgrade:')).length, 1)

  const second = assemblyHarness()
  apply(second.ctx, { enabled: true, basePath: '/dsh-realtime-voice' })
  assert.equal(second.routes.length, 3)
  assert.equal(second.upgrades.length, 1)
  for (const cleanup of second.cleanups.reverse()) cleanup()
})

test('keeps the packaged Client path as an alias for a custom base path', () => {
  const harness = assemblyHarness()
  apply(harness.ctx, { enabled: true, basePath: '/voice' })
  assert.equal(harness.routes.length, 6)
  assert.equal(harness.upgrades.length, 2)
  assert.equal(harness.routes.some(route => route.path === '/dsh-realtime-voice/models'), true)
  assert.equal(harness.routes.some(route => route.path === '/voice/models'), true)
  assert.equal(harness.upgrades.some(route => route.path === '/dsh-realtime-voice/doubao'), true)
  assert.equal(harness.upgrades.some(route => route.path === '/voice/doubao'), true)
})

test('validates base path and trusted origin configuration', () => {
  assert.throws(() => validateConfig({ enabled: true, basePath: 'relative' }), /absolute URL path/)
  assert.throws(() => validateConfig({ enabled: true, basePath: '/voice', trustedOpenAIOrigins: ['ftp://example.com'] }), /scheme and authority/)
  assert.throws(() => validateConfig({ enabled: true, basePath: '/voice', trustedDoubaoOrigins: [] }), /at least one/)
  assert.doesNotThrow(() => validateConfig({ enabled: true, basePath: '/voice', trustedOpenAIOrigins: ['https://api.openai.com'], trustedDoubaoOrigins: ['wss://openspeech.bytedance.com'] }))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../dsh/index.js'

test('registers provider adapters only after the multi-model runtime exists', () => {
  const adapters = []
  const scope = {
    realtimeModelRuntime: {
      registerAdapter(adapter) { adapters.push(adapter); return () => {} },
      publicModels: async () => [],
    },
    webServer: {
      register() {},
      registerUpgrade() { return () => {} },
    },
  }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer', 'realtimeModelRuntime'])
      callback(scope)
    },
  }
  apply(ctx, { enabled: true, basePath: '/dsh-realtime-voice' })
  assert.deepEqual(adapters.map(adapter => adapter.id), ['openai-webrtc', 'doubao-realtime-duplex'])
})

test('invalid config registers nothing', () => {
  let registrations = 0
  const ctx = { inject() { registrations += 1 }, provide() { registrations += 1 } }
  assert.throws(() => apply(ctx, { enabled: true, basePath: 'relative' }), /absolute URL path/)
  assert.equal(registrations, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../dsh/index.js'

test('provides the runtime only after registered model dependencies exist', () => {
  const provided = []
  const scope = {
    settings: { describe: () => [] },
    llm: { listProviders: () => [], listModels: async () => [] },
    credentials: { resolve: async () => undefined },
    webServer: {
      register() {},
      registerUpgrade() { return () => {} },
    },
  }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer', 'settings', 'credentials', 'llm'])
      callback(scope)
    },
    provide(name, service) { provided.push({ name, service }) },
  }
  apply(ctx, { enabled: true, maxContextChars: 12000 })
  assert.deepEqual(provided.map(row => row.name), ['realtimeVoice'])
})

test('invalid config registers nothing', () => {
  let registrations = 0
  const ctx = { inject() { registrations += 1 }, provide() { registrations += 1 } }
  assert.throws(() => apply(ctx, { enabled: true, maxContextChars: 10 }), /between/)
  assert.equal(registrations, 0)
})

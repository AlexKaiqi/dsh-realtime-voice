import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { chromium } from 'playwright'
import WebSocket, { WebSocketServer } from 'ws'

const run = promisify(execFile)
const LIVE = process.env.DSH_VOICE_E2E_LIVE === '1'
const TARGET = new URL(process.env.DSH_VOICE_E2E_BASE_URL || 'http://127.0.0.1:3080')
const ROUTE_ID = process.env.DSH_VOICE_E2E_ROUTE_ID || 'doubao/realtime/zh_female_vv_jupiter_bigtts'
const PROFILE_ID = process.env.DSH_VOICE_E2E_PROFILE_ID || 'session-assistant'
const EXPECTED_ACTION = process.env.DSH_VOICE_E2E_EXPECTED_ACTION || 'update_working_draft'
const PROBE_TOKEN = process.env.DSH_VOICE_E2E_PROBE_TOKEN || '语音端到端验证七三一九'
const UTTERANCE = process.env.DSH_VOICE_E2E_UTTERANCE || `请把当前草稿改成：${PROBE_TOKEN}。不要提交。`
const TIMEOUT_MS = Math.max(20_000, Number(process.env.DSH_VOICE_E2E_TIMEOUT_MS) || 90_000)
const CLIENT_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url))
const WS_PROTOCOL = 'dsh-realtime-voice-v1'

const TEST_PAGE = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>DSH Realtime Voice Live E2E</title>
<body><main id="status">loading</main></body>
<script>
  window.__voiceExports = null
  window.__ModuleLoader__ = {
    load(definition) {
      window.__voiceExports = definition.factory(function require(name) {
        if (name !== '@deepseek-ai/cordis') throw new Error('Unexpected browser dependency: ' + name)
        return {
          Service: class Service {
            constructor(ctx, name) {
              this.ctx = ctx
              this.name = name
              if (ctx && ctx.reflect && typeof ctx.reflect.provide === 'function') ctx.reflect.provide(name, this)
            }
          },
        }
      })
    },
  }
</script>
<script src="/client.js"></script>
<script>
  (function installHarness() {
    const state = {
      actions: [],
      events: [],
      inputDuration: 0,
      inputSources: [],
      conversation: null,
      registry: null,
      service: null,
      context: null,
      destination: null,
    }

    function serializable(value) {
      try { return JSON.parse(JSON.stringify(value)) } catch (_) { return String(value) }
    }

    async function microphone() {
      if (!state.context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext
        state.context = new AudioContext()
        state.destination = state.context.createMediaStreamDestination()
      }
      await state.context.resume()
      return new MediaStream(state.destination.stream.getAudioTracks().map(track => track.clone()))
    }

    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: microphone,
    })

    window.__voiceE2E = {
      async start(options) {
        if (!window.__voiceExports) throw new Error('Realtime voice client did not load')
        const provided = new Map()
        const ctx = { reflect: { provide(name, value) { provided.set(name, value) } } }
        state.service = new window.__voiceExports.VoiceAgentService(ctx, { root: window, basePath: '/dsh-realtime-voice' })
        const executors = {}
        ;[
          'update_working_draft', 'submit_to_agent', 'end_voice_session', 'organize_notes',
          'personal_knowledge', 'delegate_to_agent', 'end_pet_assistant',
        ].forEach(name => {
          executors[name] = {
            execute(args) {
              state.actions.push({ name, args: serializable(args) })
              return { ok: true, recordedBy: 'live-voice-e2e', action: name }
            },
          }
        })
        state.registry = state.service.registerActions('voice-e2e:', executors)
        state.conversation = await state.service.startConversation({
          routeId: options.routeId,
          profileId: options.profileId,
          context: options.context,
          ownerId: 'voice-e2e:active',
        })
        state.conversation.subscribe(event => state.events.push(serializable(event)))
        document.getElementById('status').textContent = 'started'
      },

      async feed(base64) {
        if (!state.context || !state.destination) throw new Error('Microphone was not opened')
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        const buffer = await state.context.decodeAudioData(bytes.buffer)
        const source = state.context.createBufferSource()
        source.buffer = buffer
        source.connect(state.destination)
        state.inputSources.push(source)
        state.inputDuration += buffer.duration
        source.start()
        await new Promise(resolve => { source.onended = resolve })
      },

      snapshot() {
        return {
          actions: serializable(state.actions),
          events: serializable(state.events),
          inputDuration: state.inputDuration,
          audioInput: state.service ? serializable(state.service.capabilities().audioInput) : null,
        }
      },

      async stop() {
        if (state.conversation) await state.conversation.end()
        if (state.registry) state.registry.dispose()
        const audioInput = state.service ? serializable(state.service.capabilities().audioInput) : null
        if (state.service) state.service.dispose()
        if (state.context && state.context.state !== 'closed') await state.context.close()
        return { audioInput, actions: serializable(state.actions), events: serializable(state.events) }
      },
    }
  })()
</script>
</html>`

function loopbackTarget(target) {
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('DSH_VOICE_E2E_BASE_URL must use http or https')
  if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) {
    throw new Error('Live voice E2E only proxies a loopback DSH server')
  }
}

async function waitFor(check, message, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = await check()
      if (last) return last
    } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`${message}${last instanceof Error ? `: ${last.message}` : ''}`)
}

async function generateInputAudio(directory) {
  const supplied = process.env.DSH_VOICE_E2E_WAV
  if (supplied) return { path: supplied, generated: false }
  if (process.platform !== 'darwin') {
    throw new Error('Set DSH_VOICE_E2E_WAV to a WAV generated by the speech model under test')
  }
  const aiff = join(directory, 'voice-e2e-input.aiff')
  const wav = join(directory, 'voice-e2e-input.wav')
  await run('/usr/bin/say', ['-v', process.env.DSH_VOICE_E2E_MACOS_VOICE || 'Tingting', '-r', '150', '-o', aiff, UTTERANCE])
  await run('/usr/bin/afconvert', [aiff, wav, '-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1'])
  return { path: wav, generated: true }
}

async function publicModels() {
  const response = await fetch(new URL('/dsh-realtime-voice/models', TARGET))
  assert.equal(response.ok, true, `model catalog returned HTTP ${response.status}`)
  const body = await response.json()
  return body.models || []
}

async function createHarnessServer(clientSource, stats) {
  const downstreamServer = new WebSocketServer({ noServer: true })
  const sockets = new Set()
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://voice-e2e.invalid').pathname
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(TEST_PAGE)
      return
    }
    if (path === '/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(clientSource)
      return
    }
    if (!path.startsWith('/dsh-realtime-voice/')) {
      res.writeHead(404)
      res.end()
      return
    }
    const upstreamURL = new URL(req.url, TARGET)
    const forward = upstreamURL.protocol === 'https:' ? httpsRequest : httpRequest
    const headers = { ...req.headers, host: TARGET.host, origin: TARGET.origin, 'sec-fetch-site': 'same-origin' }
    const upstream = forward(upstreamURL, { method: req.method, headers }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(error.message)
    })
    req.pipe(upstream)
  })

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://voice-e2e.invalid').pathname
    if (path !== '/dsh-realtime-voice/doubao') {
      socket.destroy()
      return
    }
    downstreamServer.handleUpgrade(req, socket, head, downstream => {
      sockets.add(downstream)
      const upstreamURL = new URL(path, TARGET)
      upstreamURL.protocol = TARGET.protocol === 'https:' ? 'wss:' : 'ws:'
      const upstream = new WebSocket(upstreamURL, WS_PROTOCOL, {
        headers: { origin: TARGET.origin, 'sec-fetch-site': 'same-origin' },
      })
      sockets.add(upstream)
      const pending = []
      downstream.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
        else pending.push([data, isBinary])
      })
      upstream.on('open', () => {
        for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary })
      })
      upstream.on('message', (data, isBinary) => {
        if (!isBinary) {
          try {
            const event = JSON.parse(String(data))
            stats.upstreamEventTypes.push(String(event.type || ''))
            if (event.type === 'response.audio.delta' || event.type === 'response.output_audio.delta') {
              const encoded = String(event.delta || '')
              stats.outputAudioFrames += 1
              stats.outputAudioBytes += Buffer.from(encoded, 'base64').length
            }
            if (event.type && String(event.type).includes('transcription')) stats.transcriptionEvents.push(event)
          } catch { /* malformed upstream data is asserted by the client path */ }
        }
        if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary })
      })
      const closePeer = peer => { if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) peer.close() }
      downstream.on('close', () => closePeer(upstream))
      upstream.on('close', () => closePeer(downstream))
      downstream.on('error', () => closePeer(upstream))
      upstream.on('error', error => {
        stats.errors.push(error.message)
        closePeer(downstream)
      })
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.terminate()
      downstreamServer.close()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test('generated speech crosses the real browser, Doubao, normalized event, action, and cleanup boundaries', {
  skip: LIVE ? false : 'set DSH_VOICE_E2E_LIVE=1 to authorize a billable live Realtime call',
  timeout: TIMEOUT_MS + 30_000,
}, async t => {
  loopbackTarget(TARGET)
  assert.equal(new URL(TARGET).pathname === '/' || new URL(TARGET).pathname === '', true, 'base URL must not contain a path')
  const route = (await publicModels()).find(model => model.id === ROUTE_ID)
  assert.ok(route, `Realtime route '${ROUTE_ID}' is not registered`)
  assert.equal(route.protocol, 'doubao-realtime-duplex', 'this maintained live case currently exercises the Doubao browser path')
  assert.equal(route.available, true, `Realtime route is missing credential '${route.missingCredential || ''}'`)

  const temporary = await mkdtemp(join(tmpdir(), 'dsh-voice-e2e-'))
  const audio = await generateInputAudio(temporary)
  const wav = await readFile(audio.path)
  assert.ok(wav.length > 44, 'input WAV is empty')
  t.diagnostic(`input=${audio.generated ? 'macOS generated fixture' : audio.path}`)
  t.diagnostic(`utterance=${UTTERANCE}`)

  const stats = { outputAudioFrames: 0, outputAudioBytes: 0, upstreamEventTypes: [], transcriptionEvents: [], errors: [] }
  const server = await createHarnessServer(await readFile(CLIENT_PATH, 'utf8'), stats)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const browserMessages = []
  page.on('console', message => {
    const entry = `${message.type()}: ${message.text()}`
    browserMessages.push(entry)
    t.diagnostic(`browser:${entry}`)
  })
  try {
    await page.goto(server.url, { waitUntil: 'load' })
    await page.evaluate(({ routeId, profileId, context }) => window.__voiceE2E.start({ routeId, profileId, context }), {
      routeId: ROUTE_ID,
      profileId: PROFILE_ID,
      context: `Live voice E2E. The editable draft is empty. Probe token: ${PROBE_TOKEN}`,
    })
    await page.waitForFunction(() => window.__voiceE2E.snapshot().events.some(event => event.type === 'status' && event.connected), null, { timeout: TIMEOUT_MS })
    await page.evaluate(base64 => window.__voiceE2E.feed(base64), wav.toString('base64'))
    await page.waitForFunction(expected => window.__voiceE2E.snapshot().actions.some(action => action.name === expected), EXPECTED_ACTION, { timeout: TIMEOUT_MS })
    await waitFor(() => stats.outputAudioFrames > 0, 'provider returned no output audio')

    const beforeStop = await page.evaluate(() => window.__voiceE2E.snapshot())
    const stopped = await page.evaluate(() => window.__voiceE2E.stop())
    const expected = beforeStop.actions.find(action => action.name === EXPECTED_ACTION)
    const serializedArguments = JSON.stringify(expected?.args || {})
    const inputTranscript = beforeStop.events
      .filter(event => event.type === 'transcript' && event.role === 'input')
      .map(event => event.text)
      .join(' ')
    const outputTranscript = beforeStop.events
      .filter(event => event.type === 'transcript' && event.role === 'output')
      .map(event => event.text)
      .join(' ')

    assert.ok(beforeStop.inputDuration > 1, 'virtual microphone did not decode a meaningful audio duration')
    assert.match(inputTranscript, /端到端|验证|七三一九|7319/, 'normalized input transcript did not contain the spoken probe')
    assert.ok(serializedArguments.includes(PROBE_TOKEN) || /端到端|七三一九|7319/.test(serializedArguments), 'action arguments lost the probe token')
    assert.equal(beforeStop.actions.some(action => action.name === 'submit_to_agent' || action.name === 'delegate_to_agent'), EXPECTED_ACTION === 'submit_to_agent' || EXPECTED_ACTION === 'delegate_to_agent', 'speech without explicit submission authorization must not submit')
    assert.ok(stats.outputAudioFrames > 0, 'no provider audio frames crossed the websocket proxy')
    assert.ok(stats.outputAudioBytes > 1_000, 'provider output audio was unexpectedly small')
    assert.ok(outputTranscript.length > 0 || beforeStop.events.some(event => event.type === 'phase' && event.phase === 'speaking'), 'assistant produced neither normalized output text nor a speaking phase')
    assert.equal(stopped.audioInput.busy, false, 'ending the conversation did not release the microphone lease')
    assert.equal(browserMessages.some(message => /ScriptProcessorNode|createScriptProcessor|onaudioprocess/i.test(message)), false, 'browser used the deprecated microphone capture path')
    assert.deepEqual(stats.errors, [])

    t.diagnostic(`action=${EXPECTED_ACTION}`)
    t.diagnostic(`inputTranscript=${inputTranscript}`)
    t.diagnostic(`outputTranscript=${outputTranscript}`)
    t.diagnostic(`outputAudioFrames=${stats.outputAudioFrames} outputAudioBytes=${stats.outputAudioBytes}`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
    await rm(temporary, { recursive: true, force: true })
  }
})

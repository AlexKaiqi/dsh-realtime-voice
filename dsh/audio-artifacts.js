import { randomUUID } from 'node:crypto'

export const AUDIO_ARTIFACT_MARKER_HEADER = 'x-dsh-voice-artifact'
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024
const MAX_INPUT_BYTES = 16_000 * 15 * 2
const OUTPUT_TTL_MS = 5 * 60_000
const INPUT_TTL_MS = 2 * 60_000
const MEDIA_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/aac'])

function rangeOf(value, length) {
  if (typeof value !== 'string') return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return undefined
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined
    start = Math.max(0, length - suffix)
    end = length - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : length - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= length) return undefined
  return { start, end: Math.min(end, length - 1) }
}

function sameOrigin(req) {
  const origin = String(req.headers?.origin || '')
  const host = String(req.headers?.host || '')
  const fetchSite = req.headers?.['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') return false
  try { return Boolean(origin && host && new URL(origin).host === host) } catch { return false }
}

async function boundedBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > maxBytes) throw new Error('audio upload is too large')
    chunks.push(value)
  }
  return Buffer.concat(chunks, size)
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(body)
}

function responseHeaders(mediaType) {
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': mediaType,
    'Accept-Ranges': 'bytes',
  }
}

/** Ephemeral same-origin input/output artifacts; no caller-selected paths, URLs, or media types. */
export function createAudioArtifactStore(basePath = '/dsh-realtime-voice', options = {}) {
  const base = String(basePath).replace(/\/+$/, '')
  const outputPrefix = `${base}/artifacts/audio`
  const inputPath = `${base}/artifacts/input`
  const outputTtlMs = options.outputTtlMs ?? OUTPUT_TTL_MS
  const inputTtlMs = options.inputTtlMs ?? INPUT_TTL_MS
  const outputs = new Map()
  const inputs = new Map()
  function remove(map, id) {
    const artifact = map.get(id)
    if (!artifact) return
    clearTimeout(artifact.timer)
    map.delete(id)
  }
  function clear() {
    for (const id of outputs.keys()) remove(outputs, id)
    for (const id of inputs.keys()) remove(inputs, id)
  }
  function put(bytes, mediaType) {
    const body = Buffer.from(bytes)
    if (!MEDIA_TYPES.has(mediaType)) throw new Error(`unsupported audio media type '${mediaType}'`)
    if (!body.length || body.length > MAX_OUTPUT_BYTES) throw new Error('audio artifact must be between 1 byte and 12 MiB')
    const id = randomUUID()
    const timer = setTimeout(() => remove(outputs, id), outputTtlMs)
    timer.unref?.()
    outputs.set(id, { body, mediaType, expiresAt: Date.now() + outputTtlMs, timer })
    return `${outputPrefix}/${id}`
  }
  function takeInput(id) {
    const artifact = /^[0-9a-f-]{36}$/.test(String(id)) ? inputs.get(id) : undefined
    if (!artifact || artifact.expiresAt <= Date.now()) {
      if (artifact) remove(inputs, id)
      throw new Error('captured audio artifact is missing or expired')
    }
    remove(inputs, id)
    return { pcm: artifact.body, sampleRate: artifact.sampleRate, channels: 1, format: 'pcm_s16le' }
  }
  async function uploadHandler(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' })
    if (req.headers?.[AUDIO_ARTIFACT_MARKER_HEADER] !== '1' || !sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden' })
    if (String(req.headers?.['content-type'] || '').split(';')[0].trim() !== 'application/octet-stream') return sendJson(res, 415, { error: 'Expected application/octet-stream' })
    const sampleRate = Number(req.headers?.['x-dsh-audio-sample-rate'])
    if (sampleRate !== 16_000) return sendJson(res, 400, { error: 'Only 16kHz mono pcm_s16le is accepted' })
    try {
      const body = await boundedBody(req, MAX_INPUT_BYTES)
      if (!body.length || body.length % 2 !== 0) return sendJson(res, 400, { error: 'PCM payload is empty or misaligned' })
      const id = randomUUID()
      const timer = setTimeout(() => remove(inputs, id), inputTtlMs)
      timer.unref?.()
      inputs.set(id, { body, sampleRate, expiresAt: Date.now() + inputTtlMs, timer })
      return sendJson(res, 201, { id, sampleRate, channels: 1, format: 'pcm_s16le' })
    } catch (error) {
      return sendJson(res, 413, { error: error instanceof Error ? error.message : 'Audio upload failed' })
    }
  }
  function outputHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' })
      return res.end('Method Not Allowed')
    }
    const fetchSite = req.headers?.['sec-fetch-site']
    if (typeof fetchSite === 'string' && !['same-origin', 'none'].includes(fetchSite)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' })
      return res.end('Forbidden')
    }
    const pathname = new URL(req.url || '/', 'http://localhost').pathname
    const id = pathname.startsWith(`${outputPrefix}/`) ? pathname.slice(outputPrefix.length + 1) : ''
    const artifact = /^[0-9a-f-]{36}$/.test(id) ? outputs.get(id) : undefined
    if (!artifact || artifact.expiresAt <= Date.now()) {
      if (artifact) remove(outputs, id)
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      return res.end('Not Found')
    }
    const range = rangeOf(req.headers?.range, artifact.body.length)
    const headers = responseHeaders(artifact.mediaType)
    if (range) {
      const body = artifact.body.subarray(range.start, range.end + 1)
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${artifact.body.length}`, 'Content-Length': body.length })
      return res.end(req.method === 'HEAD' ? undefined : body)
    }
    res.writeHead(200, { ...headers, 'Content-Length': artifact.body.length })
    res.end(req.method === 'HEAD' ? undefined : artifact.body)
  }
  function register(scope) {
    const disposeInput = scope.webServer.register({ kind: 'exact', path: inputPath, handler: uploadHandler })
    const disposeOutput = scope.webServer.register({ kind: 'prefix', path: outputPrefix, handler: outputHandler })
    return () => { disposeOutput(); disposeInput(); clear() }
  }
  return { inputPath, outputPrefix, put, takeInput, uploadHandler, outputHandler, register, clear }
}

import { randomUUID } from 'node:crypto'

const DOUBAO_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizedTools(value) {
  if (!Array.isArray(value)) return []
  return value.map(tool => object(tool)).filter(tool => typeof tool.name === 'string' && tool.name.trim())
}

function addUnique(routes, seen, route) {
  if (!route.id || !route.model || seen.has(route.id)) return
  seen.add(route.id)
  routes.push(route)
}

export function registeredRealtimeModels(descriptors = []) {
  const routes = []
  const seen = new Set()
  const multi = descriptors.find(entry => String(entry?.ns || '') === 'multi-model-provider')
  const root = object(multi?.value)
  const connections = object(root.connections)
  for (const [id, raw] of Object.entries(object(root.models))) {
    const model = object(raw)
    const connection = object(connections[model.connection])
    const capabilities = Array.isArray(model.capabilities) ? model.capabilities : []
    const profile = object(model.profile)
    const protocol = String(profile.protocol || model.runtimeAdapter || '')
    const isDoubao = protocol === 'doubao-realtime-duplex'
    const configuredModels = Array.isArray(connection.models) ? connection.models.map(object) : []
    const selectedByProvider = isDoubao && configuredModels.some(candidate => {
      const candidateID = String(candidate.id || '')
      return candidateID === String(profile.voice || '') || candidateID === id
    })
    if (model.enabled === false && !selectedByProvider) continue
    if (model.task !== 'realtime-speech' && !capabilities.includes('speech.realtime_session')) continue
    if (connection.provider !== 'openai' && !isDoubao) continue
    addUnique(routes, seen, {
      id,
      model: String(model.model || profile.voice || ''),
      displayName: String(model.displayName || model.model || id),
      provider: String(connection.provider || ''),
      protocol: isDoubao ? 'doubao-realtime-duplex' : 'openai-webrtc',
      baseURL: String(connection.baseURL || 'https://api.openai.com/v1'),
      endpoint: String(profile.endpoint || (isDoubao ? DOUBAO_ENDPOINT : '')),
      voice: String(profile.voice || ''),
      credentialRef: String(connection.credentialRef || object(connection.credentialRefs).apiKey || (isDoubao ? 'DOUBAO_API_KEY' : 'OPENAI_API_KEY')),
      credentialRefs: object(connection.credentialRefs),
      source: 'task-model',
    })
  }

  const llm = descriptors.find(entry => String(entry?.ns || '') === 'llm-pi-ai')
  for (const [provider, raw] of Object.entries(object(object(llm?.value).providers))) {
    const providerProfile = object(raw)
    for (const candidate of Array.isArray(providerProfile.models) ? providerProfile.models : []) {
      const model = object(candidate)
      const modelId = String(model.id || '')
      if (!/^gpt-(?:4o(?:-mini)?-)?realtime(?:-|$)/.test(modelId)) continue
      addUnique(routes, seen, {
        id: `llm:${provider}/${modelId}`,
        model: modelId,
        displayName: String(model.name || modelId),
        provider,
        protocol: 'openai-webrtc',
        baseURL: String(providerProfile.baseURL || 'https://api.openai.com/v1'),
        endpoint: '',
        voice: '',
        credentialRef: String(providerProfile.apiKeyEnv || 'OPENAI_API_KEY'),
        credentialRefs: {},
        source: 'llm-settings',
      })
    }
  }
  return routes
}

export class RealtimeVoiceService {
  constructor(scope, options = {}) {
    this.scope = scope
    this.maxContextChars = Math.max(1000, Math.min(50000, Number(options.maxContextChars || 12000)))
    this.profiles = new Map()
  }

  registerProfile(profile) {
    const id = String(profile?.id || '').trim()
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new Error('Realtime voice profile id must be lower-case hyphen-case')
    if (this.profiles.has(id)) throw new Error(`Realtime voice profile already registered: ${id}`)
    if (typeof profile.instructions !== 'function' && typeof profile.instructions !== 'string') throw new Error('Realtime voice profile instructions are required')
    const stored = { id, instructions: profile.instructions, tools: normalizedTools(profile.tools), voice: object(profile.voice) }
    this.profiles.set(id, stored)
    return () => this.profiles.delete(id)
  }

  profile(id) {
    const value = this.profiles.get(String(id || ''))
    if (!value) throw new Error(`Unknown Realtime voice profile: ${String(id || '')}`)
    return value
  }

  async models() {
    const descriptors = this.scope.settings.describe({ redactSecrets: true })
    const routes = registeredRealtimeModels(descriptors)
    const seen = new Set(routes.map(route => route.id))
    for (const providerInfo of this.scope.llm.listProviders()) {
      const provider = String(providerInfo?.id || '')
      if (!provider) continue
      let models
      try { models = await this.scope.llm.listModels(provider) } catch { continue }
      for (const raw of Array.isArray(models) ? models : []) {
        const model = object(raw)
        const modelId = String(model.id || '')
        const id = `llm:${provider}/${modelId}`
        if (!/^gpt-(?:4o(?:-mini)?-)?realtime(?:-|$)/.test(modelId) || seen.has(id)) continue
        addUnique(routes, seen, {
          id,
          model: modelId,
          displayName: String(model.name || modelId),
          provider,
          protocol: 'openai-webrtc',
          baseURL: 'https://api.openai.com/v1',
          endpoint: '',
          voice: '',
          credentialRef: 'OPENAI_API_KEY',
          credentialRefs: {},
          source: 'llm-registry',
        })
      }
    }
    return routes
  }

  async model(routeId, protocol = '') {
    const routes = await this.models()
    const expected = String(protocol || '')
    const candidates = expected ? routes.filter(route => route.protocol === expected) : routes
    const selected = String(routeId || '')
    return candidates.find(route => route.id === selected)
      || candidates.find(route => route.model === selected)
      || candidates[0]
  }

  async resolvedCredential(ref) {
    const key = String(ref || '')
    if (!key) return ''
    try {
      const resolved = await this.scope.credentials.resolve(key)
      return String(resolved?.value || process.env[key] || '')
    } catch {
      return String(process.env[key] || '')
    }
  }

  async credential(route = {}) {
    const refs = object(route.credentialRefs)
    const candidates = route.protocol === 'doubao-realtime-duplex'
      ? [route.credentialRef, refs.apiKey, refs.realtimeApiKey, 'DOUBAO_API_KEY', 'DOUBAO_REALTIME_API_KEY']
      : [route.credentialRef, refs.apiKey, 'OPENAI_API_KEY']
    for (const credentialRef of [...new Set(candidates.filter(Boolean).map(String))]) {
      const value = await this.resolvedCredential(credentialRef)
      if (value) return { value, credentialRef }
    }
    return { value: '', credentialRef: String(candidates.find(Boolean) || '') }
  }

  async publicModels() {
    const rows = []
    for (const route of await this.models()) {
      const credential = await this.credential(route)
      rows.push({
        id: route.id,
        model: route.model,
        displayName: route.displayName,
        provider: route.provider,
        source: route.source,
        protocol: route.protocol,
        available: Boolean(credential.value),
        missingCredential: credential.value ? '' : credential.credentialRef,
      })
    }
    return rows
  }

  boundedContext(value) {
    return String(value || '').replaceAll('\0', '').trim().slice(0, this.maxContextChars)
  }

  instructions(profile, context) {
    const bounded = this.boundedContext(context)
    return typeof profile.instructions === 'function'
      ? String(profile.instructions(bounded) || '')
      : [String(profile.instructions || ''), bounded].filter(Boolean).join('\n\n')
  }

  session({ profileId, route, context }) {
    const profile = this.profile(profileId)
    const instructions = this.instructions(profile, context)
    if (route.protocol === 'doubao-realtime-duplex') {
      return {
        session: {
          type: 'realtime',
          id: randomUUID(),
          model: route.model,
          instructions,
          audio: {
            input: { format: { type: 'pcm', rate: 16000 } },
            output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: profile.voice.doubao || route.voice || 'zh_female_vv_jupiter_bigtts' },
          },
          tools: profile.tools,
        },
      }
    }
    if (route.protocol !== 'openai-webrtc') throw new Error(`Unsupported Realtime voice protocol: ${route.protocol}`)
    return {
      type: 'realtime',
      model: route.model,
      output_modalities: ['audio'],
      instructions,
      max_output_tokens: 4096,
      tools: profile.tools,
      tool_choice: profile.tools.length ? 'auto' : 'none',
      audio: {
        input: { turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600, create_response: true, interrupt_response: true } },
        output: { voice: profile.voice.openai || 'marin' },
      },
    }
  }
}

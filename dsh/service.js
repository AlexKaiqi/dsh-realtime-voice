import { randomUUID } from 'node:crypto'

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export const openAIRealtimeAdapter = {
  id: 'openai-webrtc',
  protocol: 'openai-webrtc',
  session({ route, profile, instructions }) {
    return {
      type: 'realtime',
      model: route.model,
      output_modalities: ['audio'],
      instructions,
      max_output_tokens: 4096,
      tools: Array.isArray(profile.tools) ? profile.tools : [],
      tool_choice: Array.isArray(profile.tools) && profile.tools.length ? 'auto' : 'none',
      audio: {
        input: { turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600, create_response: true, interrupt_response: true } },
        output: { voice: object(profile.voice).openai || route.voice || 'marin' },
      },
    }
  },
}

export const doubaoRealtimeAdapter = {
  id: 'doubao-realtime-duplex',
  protocol: 'doubao-realtime-duplex',
  session({ route, profile, instructions }) {
    return {
      session: {
        type: 'realtime',
        id: randomUUID(),
        model: route.model,
        instructions,
        audio: {
          input: { format: { type: 'pcm', rate: 16000 } },
          output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: object(profile.voice).doubao || route.voice || 'zh_female_vv_jupiter_bigtts' },
        },
        tools: Array.isArray(profile.tools) ? profile.tools : [],
      },
      // extension is a TOP-LEVEL field of session.create/update (per the
      // official duplex SDK), not a session member. Enables input ASR so the
      // browser receives streaming input_audio_transcription events.
      extension: {
        asr: {
          audio_info: { format: 'pcm', sample_rate: 16000, channel: 1 },
        },
      },
    }
  },
}

export function realtimeVoiceAdapters() {
  return [openAIRealtimeAdapter, doubaoRealtimeAdapter]
}

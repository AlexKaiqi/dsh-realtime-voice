const DEFAULT_CHUNK_FRAMES = 2048

class DSHRealtimeVoiceInputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const requested = Number(options?.processorOptions?.chunkFrames)
    this.chunkFrames = Number.isSafeInteger(requested) && requested >= 128 && requested <= 16384
      ? requested
      : DEFAULT_CHUNK_FRAMES
    this.buffer = new Float32Array(this.chunkFrames)
    this.offset = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel?.length) return true
    let consumed = 0
    while (consumed < channel.length) {
      const count = Math.min(channel.length - consumed, this.chunkFrames - this.offset)
      this.buffer.set(channel.subarray(consumed, consumed + count), this.offset)
      consumed += count
      this.offset += count
      if (this.offset === this.chunkFrames) {
        const samples = this.buffer
        this.port.postMessage({ samples, sampleRate }, [samples.buffer])
        this.buffer = new Float32Array(this.chunkFrames)
        this.offset = 0
      }
    }
    return true
  }
}

registerProcessor('dsh-realtime-voice-input', DSHRealtimeVoiceInputProcessor)

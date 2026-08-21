# dsh-realtime-voice

Provider-neutral Realtime voice transport for DeepSeek Harness. `dsh-multi-model-provider` owns the model catalog, route selection, credential references, and profile registry. Product plugins own role profiles, context shaping, and tool policy. This plugin owns OpenAI Realtime and Doubao Duplex wire protocols plus browser media lifecycle.

## Host responsibilities

- Registers the unchanged `openai-webrtc` and `doubao-realtime-duplex` adapters.
- Validates protocol, adapter, provider, scheme, endpoint, and trusted origin before credential resolution.
- Defaults to official upstream origins: `https://api.openai.com` and `wss://openspeech.bytedance.com`.
- Allows custom upstream origins only when explicitly listed in `trustedOpenAIOrigins` or `trustedDoubaoOrigins`.
- Keeps long-lived credentials on the host and sends them only to validated upstreams.
- Requires browser same-origin `Origin`/`Host`; billable POST routes use explicit marker headers, while the Doubao WebSocket uses the browser-compatible `dsh-realtime-voice-v1` subprotocol. `Sec-Fetch-Site` must be `same-origin` when supplied.
- Bounds and sanitizes Doubao frames, buffers a small startup event queue, emits `session.ready`, and accepts one result for each pending tool call.
- Owns every HTTP route, upgrade route, and WebSocket through Cordis lifecycle disposers.

Host endpoints retain their existing paths. When `basePath` is customized for legacy consumers, these default paths remain mounted as stable aliases for the packaged Client:

- `GET /dsh-realtime-voice/models`: public, non-billable model metadata.
- `POST /dsh-realtime-voice/openai/session`: same-origin OpenAI WebRTC SDP exchange; requires `x-dsh-realtime-voice: 1`.
- `POST /dsh-realtime-voice/doubao/probe`: same-origin Doubao connection probe; requires `x-dsh-model-probe: 1`.
- `WS /dsh-realtime-voice/doubao`: same-origin Doubao Duplex proxy; requires WebSocket subprotocol `dsh-realtime-voice-v1`.

## Client service

The packaged web Client publishes the Cordis service `realtimeVoice`:

```js
const service = ctx.get('realtimeVoice')
const models = await service.models()
const session = await service.open({
  protocol: 'openai-webrtc',
  routeId: 'openai/gpt-realtime',
  profileId: 'my-profile',
  context: 'provider-neutral context',
})
const dispose = session.subscribe(event => {
  // status, phase, transcript, tool, interrupted, error, or closed
})
```

Service contract:

- `capabilities()` returns secure-context state, per-protocol browser support, recognition/read-aloud support, and installed browser voices.
- `models()`
- `open({ protocol, routeId, profileId, context })`
- `recognize({ lang, continuous, interim, onTranscript, onError })`
- `readAloud({ text, voiceName, lang, rate, onEnd, onError })`

For a settings-page voice preview, `open()` also accepts `outputOnly: true` and a bounded `previewText`. This establishes a receive-only session and never opens the microphone. OpenAI receives a one-turn text request. The deployed Doubao Dialogue dialect does not accept that text event, so the Host streams a short bundled 16 kHz PCM prompt at realtime cadence and commits it; the selected model then answers with its actual configured voice. The caller must subscribe immediately and close the handle after the response completes, fails, or times out.

Realtime handle contract:

- `id`
- `subscribe(listener)`
- `updateContext(context)`
- `resolveTool(callId, result, { continueResponse? })`
- `interrupt()`
- `close()`

The Client service owns `RTCPeerConnection`, data channels, microphone tracks, media/audio elements, WebSockets, `AudioContext`, PCM capture and playback, `SpeechRecognition`, `speechSynthesis`, listeners, and late-callback guards. It does not know drafts, Agent submission, or any session-assistant business semantics.

## Runtime integration

Business plugins register profiles with `realtimeModelRuntime` and pass only their profile id, selected route id, and provider-neutral context to `realtimeVoice`. They must resolve normalized `tool` events through the handle; they never supply credentials or arbitrary provider events.

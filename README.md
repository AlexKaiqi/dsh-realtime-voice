# dsh-realtime-voice

Provider-neutral full-duplex voice Agent capability for DeepSeek Harness.

The public product abstraction is deliberately small: a consumer starts a **voice conversation with an Agent**, observes the conversation, lets the user interrupt naturally, supplies product-owned actions, and ends the conversation. Provider sessions, wire events, audio buffers, VAD, WebRTC, WebSocket, STT, LLM, and TTS are implementation details behind that boundary.

`dsh-multi-model-provider` owns model routes, credential references, and provider profiles. Product plugins own Agent identity, context, durable history, action policy, and authorization. This plugin owns only the live voice conversation: simultaneous listening and speaking, interruption, browser media lifetime, provider adaptation, normalized conversation events, and the neutral action-execution loop.

## Product boundary

```text
Agent (owned by the product)
└── Voice conversation (owned here)
    ├── start / observe / interrupt / end
    └── action requests delegated back to the product
```

The plugin does not create a second Agent, own long-term memory, or decide whether an action is authorized. A Realtime provider session is strictly internal and must not become the consumer-facing object.

## Host responsibilities

- Registers the unchanged `openai-webrtc` and `doubao-realtime-duplex` adapters.
- Validates protocol, adapter, provider, scheme, endpoint, and trusted origin before credential resolution.
- Defaults to official upstream origins: `https://api.openai.com` and `wss://openspeech.bytedance.com`.
- Allows custom upstream origins only when explicitly listed in `trustedOpenAIOrigins` or `trustedDoubaoOrigins`.
- Keeps long-lived credentials on the host and sends them only to validated upstreams.
- Requires browser same-origin `Origin`/`Host`; billable POST routes use explicit marker headers, while the Doubao WebSocket uses the browser-compatible `dsh-realtime-voice-v1` subprotocol. `Sec-Fetch-Site` must be `same-origin` when supplied.
- Bounds and sanitizes Doubao frames, buffers a small startup event queue, emits `session.ready`, and accepts one result for each pending tool call.
- Owns every HTTP route, upgrade route, and WebSocket through Cordis lifecycle disposers.

The package and canonical Host endpoints retain the stable realtime-voice name. The short-lived `/dsh-voice-agent` paths, marker, and WebSocket subprotocol remain temporary compatibility aliases for the 0.3 development migration:

- `GET /dsh-realtime-voice/models`: public, non-billable model metadata.
- `POST /dsh-realtime-voice/openai/session`: same-origin OpenAI WebRTC SDP exchange; requires `x-dsh-realtime-voice: 1`.
- `POST /dsh-realtime-voice/doubao/probe`: same-origin Doubao connection probe; requires `x-dsh-model-probe: 1`.
- `WS /dsh-realtime-voice/doubao`: same-origin Doubao Duplex proxy; requires WebSocket subprotocol `dsh-realtime-voice-v1`.

## Client service

The packaged web Client publishes the Cordis service `voiceAgent`:

```js
const service = ctx.get('voiceAgent')
const conversation = await service.startConversation({
  routeId: 'openai/gpt-realtime',
  profileId: 'my-profile',
  context: 'provider-neutral context',
  ownerId: 'my-product:active',
})
const dispose = conversation.subscribe(event => {
  // connection/activity, transcript, action, interruption, error, or end
})
```

Primary service contract:

- `capabilities()` reports whether a duplex conversation can start and whether audio input is already owned.
- `startConversation({ routeId, profileId, context, ownerId })` returns a `VoiceConversation`. The provider protocol is inferred from the selected route; callers do not need to model OpenAI or Doubao sessions.
- `registerActions(ownerPrefix, actions)` connects model-requested actions to product-owned executors. The product remains responsible for authorization and side-effect policy.

During the 0.3 migration, `open`, `registerTools`, `resolveTool`, `close`, `models`, `recognize`, and `readAloud` remain compatibility APIs. New product code should use the conversation vocabulary above.

`VoiceConversation` contract:

- `id`
- `subscribe(listener)`
- `updateContext(context)`
- `resolveAction(callId, result, { continueResponse? })`
- `interrupt()`
- `end()`

The Host also serves the same implementation at `/dsh-realtime-voice/client.js` for product-owned standalone pages. It publishes `window.DSHRealtimeVoice`; a product may pass a bounded same-origin `gateway` to `startConversation` so its own short-lived authorization, versioned start event, and readiness event remain on the product route. The shared Client still owns microphone capture, playback, interruption, cleanup, and normalized events. Doubao output additionally emits bounded `{ type: "audio-level", source: "output", level: 0..1 }` events for avatar animation without exposing raw PCM to the consumer.

The Client service owns `RTCPeerConnection`, data channels, microphone tracks, media/audio elements, WebSockets, `AudioContext`, `AudioWorklet` PCM capture and playback, `SpeechRecognition`, `speechSynthesis`, listeners, late-callback guards, and the neutral tool-execution loop. It does not know drafts, Agent submission, knowledge bases, pets, or any product business semantics. The Doubao input worklet is loaded from the same Host base path; no deprecated `ScriptProcessorNode`, Blob module, or production microphone bypass is retained.

Every microphone consumer supplies a bounded `ownerId`. Audio input is an exclusive lease: a competing conversation fails with `code: "audio_input_busy"` and the current owner id. Ending a conversation or failing during startup releases the lease.

`voiceAgent.recognize()` is the low-cost standby primitive used by product plugins. It never opens a Realtime Provider session itself. Products remain responsible for matching a wake phrase and calling `startConversation()` only after a match. Browser speech recognition is not described as on-device unless the user agent explicitly guarantees local processing.

For same-utterance wake-up, a product calls `recognize({ captureAudio: true })`. The runtime keeps at most 30 seconds of PCM audio in browser memory; the product discards that buffer after every finalized non-match. On a match it passes both the complete original transcript as bounded `initialUserText` and the captured PCM as `initialAudio`. After Provider readiness, the runtime replays the full audio as the first real user turn, including the wake phrase. The buffer is never persisted, and unmatched audio never reaches a Realtime Provider.

Browser media failures are normalized to stable, consumer-localizable codes on the rejected error (and on `recognize()` error events): `mic_not_found` (no input device), `mic_permission_denied`, `mic_unreadable`, and `mic_aborted`. The raw DOMException message is replaced with one canonical English sentence per code; consumers translate `error.code` into their own language and fall back to the message for unknown codes.

## Runtime integration

Business plugins register profiles with `realtimeModelRuntime`, then pass only the selected route, profile, Agent context, and owner identity to `voiceAgent.startConversation`. They register product actions under the same owner prefix. They never supply credentials or provider events, and this plugin never sees drafts, knowledge policy, submission policy, or delegation authorization.

## Live browser voice verification

The maintained live E2E case sends generated speech through a browser-owned virtual microphone, the real packaged Client, the local DSH Host, a real Doubao Realtime route, normalized conversation events, the automatic action-execution loop, response audio, and microphone-lease cleanup. Product actions are recorded by an isolated executor, so the case does not submit to or mutate a real Session.

Live Realtime calls may incur Provider charges and are skipped by the normal test suite. Install the Playwright browser once, start the configured DSH Web profile, and opt in explicitly:

```sh
pnpm exec playwright install chromium
pnpm test:e2e:live
```

On macOS the case creates a deterministic Chinese WAV with `say` and `afconvert`. To exercise a separate speech-generation model, generate the same utterance as a WAV and pass its path without putting credentials in the command or repository:

```sh
DSH_VOICE_E2E_WAV=/absolute/path/from-speech-model.wav pnpm test:e2e:live
```

Defaults target `http://127.0.0.1:3080`, the first built-in Doubao voice route, and the `session-assistant` profile. The maintained case can be pointed at another installed product profile without changing source:

```sh
DSH_VOICE_E2E_PROFILE_ID=pet-assistant \
DSH_VOICE_E2E_EXPECTED_ACTION=delegate_to_agent \
DSH_VOICE_E2E_UTTERANCE='请把语音端到端验证七三一九明确提交给当前 Agent。' \
pnpm test:e2e:live
```

Supported overrides are `DSH_VOICE_E2E_BASE_URL`, `DSH_VOICE_E2E_ROUTE_ID`, `DSH_VOICE_E2E_PROFILE_ID`, `DSH_VOICE_E2E_EXPECTED_ACTION`, `DSH_VOICE_E2E_PROBE_TOKEN`, `DSH_VOICE_E2E_UTTERANCE`, `DSH_VOICE_E2E_WAV`, and `DSH_VOICE_E2E_TIMEOUT_MS`. The proxy refuses non-loopback targets, and the test never reads or forwards a credential value itself.

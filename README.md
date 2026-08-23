# dsh-voice-agent

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
- Requires browser same-origin `Origin`/`Host`; billable POST routes use explicit marker headers, while the Doubao WebSocket uses the browser-compatible `dsh-voice-agent-v1` subprotocol. `Sec-Fetch-Site` must be `same-origin` when supplied.
- Bounds and sanitizes Doubao frames, buffers a small startup event queue, emits `session.ready`, and accepts one result for each pending tool call.
- Owns every HTTP route, upgrade route, and WebSocket through Cordis lifecycle disposers.

Host endpoints use the new product name. The old `/dsh-realtime-voice` paths, marker, and WebSocket subprotocol remain temporary compatibility aliases:

- `GET /dsh-voice-agent/models`: public, non-billable model metadata.
- `POST /dsh-voice-agent/openai/session`: same-origin OpenAI WebRTC SDP exchange; requires `x-dsh-voice-agent: 1`.
- `POST /dsh-voice-agent/doubao/probe`: same-origin Doubao connection probe; requires `x-dsh-model-probe: 1`.
- `WS /dsh-voice-agent/doubao`: same-origin Doubao Duplex proxy; requires WebSocket subprotocol `dsh-voice-agent-v1`.

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

The Client service owns `RTCPeerConnection`, data channels, microphone tracks, media/audio elements, WebSockets, `AudioContext`, PCM capture and playback, `SpeechRecognition`, `speechSynthesis`, listeners, late-callback guards, and the neutral tool-execution loop. It does not know drafts, Agent submission, knowledge bases, pets, or any product business semantics.

Every microphone consumer supplies a bounded `ownerId`. Audio input is an exclusive lease: a competing conversation fails with `code: "audio_input_busy"` and the current owner id. Ending a conversation or failing during startup releases the lease.

Browser media failures are normalized to stable, consumer-localizable codes on the rejected error (and on `recognize()` error events): `mic_not_found` (no input device), `mic_permission_denied`, `mic_unreadable`, and `mic_aborted`. The raw DOMException message is replaced with one canonical English sentence per code; consumers translate `error.code` into their own language and fall back to the message for unknown codes.

## Runtime integration

Business plugins register profiles with `realtimeModelRuntime`, then pass only the selected route, profile, Agent context, and owner identity to `voiceAgent.startConversation`. They register product actions under the same owner prefix. They never supply credentials or provider events, and this plugin never sees drafts, knowledge policy, submission policy, or delegation authorization.

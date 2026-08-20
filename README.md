# dsh-realtime-voice

多模型运行时的 Realtime 语音适配层。`dsh-multi-model-provider` 负责模型目录、路由、凭据解析和角色 profile；本插件只注册 GPT Realtime 与豆包 Duplex adapter，并提供浏览器音频传输。

业务插件不直接判断 OpenAI/豆包，而是向多模型运行时注册 profile：

```js
const dispose = ctx.realtimeModelRuntime.registerProfile({
  id: 'session-assistant',
  instructions: context => `...${context}`,
  tools: [/* 仅该角色允许的工具 */],
})
```

然后按注册路由装配 Provider session：

```js
const route = await ctx.realtimeModelRuntime.model(routeId, protocol)
ctx.realtimeModelRuntime.session({ profileId, route, context })
```

本插件负责：

- 向 `realtimeModelRuntime` 注册 `openai-webrtc` 与 `doubao-realtime-duplex` adapter。
- OpenAI Realtime WebRTC 的服务端初始化与长期 Key 隔离。
- 豆包 Duplex 同源 WebSocket 代理、音频事件白名单和鉴权诊断。

模型发现、选择、凭据解析、上下文裁剪、Profile 与工具白名单均由 `dsh-multi-model-provider` 的 `realtimeModelRuntime` 管理。本插件不解析 Settings schema。

浏览器入口为：

- `GET /dsh-realtime-voice/models`
- `POST /dsh-realtime-voice/openai/session`
- `WS /dsh-realtime-voice/doubao`

业务插件必须提交自己注册的 `profileId` 和所选 `routeId`；浏览器不能指定凭据、任意上游事件或未登记的工具。

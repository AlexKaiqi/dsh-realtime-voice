# dsh-realtime-voice

独立的 Realtime 语音运行时。模型注册插件负责登记模型、能力、Provider 路由与凭据引用；本插件负责把这些注册结果变成可使用的语音会话。

业务插件不再直接判断 OpenAI/豆包，也不各自维护工具定义，而是注册 profile：

```js
const dispose = ctx.realtimeVoice.registerProfile({
  id: 'session-assistant',
  instructions: context => `...${context}`,
  tools: [/* 仅该角色允许的工具 */],
})
```

然后按注册路由装配 Provider session：

```js
const route = await ctx.realtimeVoice.model(routeId, protocol)
ctx.realtimeVoice.session({ profileId, route, context })
```

当前已独立负责：

- 模型注册表解析与规范化。
- Profile 注册和权限边界。
- OpenAI Realtime WebRTC 的服务端初始化与长期 Key 隔离。
- 豆包 Duplex 同源 WebSocket 代理、音频事件白名单和鉴权诊断。
- 稳定、受限的上下文裁剪。

浏览器入口为：

- `GET /dsh-realtime-voice/models`
- `POST /dsh-realtime-voice/openai/session`
- `WS /dsh-realtime-voice/doubao`

业务插件必须提交自己注册的 `profileId` 和所选 `routeId`；浏览器不能指定凭据、任意上游事件或未登记的工具。

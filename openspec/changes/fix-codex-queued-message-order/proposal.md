## Why

Codex queued follow-up 在上一轮结束后自动发送时，可能出现 realtime assistant item 先于 authoritative user item 到达的乱序。当前 reducer 会删除 optimistic user item，再将真实 user item 追加到列表末尾，导致同一轮显示为 `assistant → user`，并可能让 queued handoff 的用户消息短暂不可见。

## 目标与边界

- 目标：authoritative user item 接管 optimistic user item 时保持原始 timeline 位置，确保同一轮始终显示为 `user → assistant`。
- 目标：保留既有 generated-image anchor 重定向与去重行为。
- 边界：仅修改前端 thread reducer 的 optimistic user reconciliation 路径及其测试。
- 边界：不新增 Tauri/Rust contract，不调整非 Codex provider 的发送流程。

## What Changes

- 将 matching authoritative user item 原位替换对应的 optimistic user item，而不是删除后通过通用 `upsertItem` 追加。
- 增加 assistant realtime item 已先到达、真实 user item 后到达的回归测试。
- 更新 queued user bubble continuity spec，明确乱序事件不能改变 user/assistant 的 timeline 顺序。

## 非目标

- 不重构 realtime event transport。
- 不修改 history snapshot 的排序协议。
- 不改变 queue fusion、AskUserQuestion 或 generated-image 的独立交互语义。

## 验收标准

- 当 `optimistic user → assistant realtime item → authoritative user item` 依次到达时，最终 timeline MUST 为 `authoritative user → assistant`。
- 最终 timeline MUST 只保留一条等价 user bubble。
- generated-image processing item 在 user id 替换后仍紧跟对应 user bubble。
- 现有 Codex queued follow-up 与非 Codex 相关测试保持通过。

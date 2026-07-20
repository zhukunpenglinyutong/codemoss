## Why

Codex queued follow-up 在上一轮结束后自动发送时，可能出现 realtime assistant item 先于 authoritative user item 到达的乱序。当前 reducer 会删除 optimistic user item，再将真实 user item 追加到列表末尾，导致同一轮显示为 `assistant → user`。

首次修复后，真实手动验证还发现更上游的缺口：消息处于 queue 时只显示在 Composer 的 queue UI；`queued-handoff-*` 仅在出队时作为 timeline 尾部投影插入。该投影没有记录上一轮的 turn boundary，且在真正的 optimistic user item 尚未进入 reducer 时会被新 assistant item 越过，表现为用户消息短暂不显示、或 assistant 输出显示在用户消息上方，直到 history/reconcile 收敛后才恢复正常。

## 目标与边界

- 目标：queued follow-up 在进入 queue 时即可在 timeline 中可见，并在上一轮结束后保持位于对应 successor assistant item 之前。
- 目标：authoritative user item 接管 optimistic user item 时保持原始 timeline 位置，确保同一轮始终显示为 `user → assistant`。
- 目标：保留既有 generated-image anchor 重定向与去重行为。
- 边界：仅修改前端 queue handoff presentation、Codex optimistic user insertion/reconciliation 路径及其测试。
- 边界：不新增 Tauri/Rust contract，不调整非 Codex provider 的发送流程。

## What Changes

- 将 matching authoritative user item 原位替换对应的 optimistic user item，而不是删除后通过通用 `upsertItem` 追加。
- queued head 在仍处于上一轮 processing 时即创建带 turn-boundary anchor 的 handoff bubble；presentation 层按该 anchor 插入，而不是总追加到 timeline 末尾。
- queued Codex message 实际出队时先同步插入/复用 reducer 内的 optimistic user item，再开始可能产生 realtime event 的发送流程。
- 当前 handoff 仅在其 canonical user item 已占据 anchor 后的预期位置时才交接给下一条 queued message，避免连续第三条消息继续被第二条 handoff 占用或被历史同文消息误去重。
- 增加 assistant realtime item 已先到达、真实 user item 后到达，以及 queue 中可见性与 anchored presentation 的回归测试。
- 更新 queued user bubble continuity spec，明确乱序事件不能改变 user/assistant 的 timeline 顺序。

## 非目标

- 不重构 realtime event transport。
- 不修改 history snapshot 的排序协议。
- 不改变 queue fusion、AskUserQuestion 或 generated-image 的独立交互语义。

## 验收标准

- 当 `optimistic user → assistant realtime item → authoritative user item` 依次到达时，最终 timeline MUST 为 `authoritative user → assistant`。
- 当上一轮仍在输出时用户排队 follow-up，用户 bubble MUST 立即可见，且 successor assistant item 到达后 MUST 位于该 bubble 之后。
- 当第二条 follow-up 已成为 canonical user item 后，第三条 follow-up 入队 MUST 立即接管 handoff 展示位置，且不能被更早的同文 user item 隐藏。
- 最终 timeline MUST 只保留一条等价 user bubble。
- generated-image processing item 在 user id 替换后仍紧跟对应 user bubble。
- 现有 Codex queued follow-up 与非 Codex 相关测试保持通过。

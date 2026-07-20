## Context

`useThreadMessaging` 在 Codex 发送时会插入 `optimistic-user-*`。当 backend 的 assistant realtime item 先到达时，assistant 会追加到该 optimistic user 之后。随后 authoritative user item 到达，旧 reducer 会删除 optimistic item，再调用 `upsertItem`。通用 upsert 对新 id 的行为是追加到数组末尾，因此真实 user 被放到 assistant 后面。

同时，`useQueuedSend` 对排队消息只在出队时设置 `queued-handoff-*`，而 `appendQueuedHandoffBubbleIfNeeded` 总是将其追加到 timeline 尾部。排队期间用户没有 timeline bubble；若 successor assistant 的 realtime event 或 history snapshot 先到，尾部投影会显示在 assistant 之后。原 reducer 修复无法覆盖这个窗口，因为 reducer 当时尚未拥有对应 optimistic user item。

## Decision

在 queue handoff 与 optimistic user reconciliation 中建立连续的 position ownership：

1. queued Codex head 在入队时立即创建 handoff bubble，并捕获当时 active timeline 的尾部 item id 作为 `anchorItemId`；
2. presentation 层在 anchor 后插入 handoff bubble，因此 successor assistant 即使先进入 items 也不能越过该 bubble；
3. queued message 实际出队时，在 async prompt preparation / realtime send 之前同步写入或复用稳定 id 的 `optimistic-user-*` item；后续 preparation 只原位更新该 item；
4. 找到等价 authoritative user item 后，直接以它替换 optimistic user item 的数组位置，reducer 跳过后续 user `upsertItem` 追加；
5. 当前 handoff 只在对应 canonical user 已出现在 `anchorItemId` 后的预期位置时才交接给下一 queued head；相同文本但位于更早历史位置的 user item 不得触发去重或交接；
6. 延续现有 generated-image anchor retarget 与 reinsert 逻辑；
7. 非 Codex 或不需要渲染 user message 的发送流程保持当前行为。

## Trade-offs

- anchor 仅服务于 handoff 的短暂 presentation window；canonical state 仍由 optimistic/authoritative item 接管，不引入全局 timestamp 排序。
- 原位替换避免依赖 realtime 事件到达顺序，改动集中且不会影响 tool/reasoning 的既有相对顺序。
- 使用 stable optimistic id 与 anchor-adjacent fallback 确认 canonical ownership，避免仅按全文本去重时把早期同文消息误认为当前 queued follow-up。
- 不采用 timestamp 排序：realtime/history payload 的 timestamp 完整性不一致，且可能影响 tool/reasoning 的既有相对顺序。
- 不延迟 assistant 渲染：会降低流式首段反馈，且不能从根因上保证顺序。

## Verification

- 先添加 queue visibility、handoff anchor、eager optimistic insertion 及 reducer regression tests，确认旧实现失败。
- 修复后运行相关 queued-send / optimistic-render / reducer tests。
- 在应用中按“第一轮运行中连续排队第二、第三条消息”路径手动复现，确认每轮均为 `previous assistant → user → successor assistant`。

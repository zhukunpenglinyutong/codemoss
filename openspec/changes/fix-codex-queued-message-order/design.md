## Context

`useThreadMessaging` 在 Codex 发送时先插入 `optimistic-user-*`。当 backend 的 assistant realtime item 先到达时，assistant 会追加到该 optimistic user 之后。随后 authoritative user item 到达，`useThreadsReducer` 调用 `replaceOptimisticUserAndExtractAnchoredGeneratedImages` 删除 optimistic item，再调用 `upsertItem`。通用 upsert 对新 id 的行为是追加到数组末尾，因此真实 user 被放到 assistant 后面。

## Decision

在 optimistic user reconciliation 中返回原位替换结果：

1. 找到等价 optimistic user item 后，直接以 authoritative user item 替换该数组位置；
2. 标记该 user 已被原位接管，reducer 跳过后续 user `upsertItem` 追加；
3. 延续现有 generated-image anchor retarget 与 reinsert 逻辑；
4. 无匹配 optimistic user 时，保留当前通用 `upsertItem` 行为。

## Trade-offs

- 原位替换避免依赖 realtime 事件到达顺序，改动集中且不会引入全局排序规则。
- 不采用 timestamp 排序：realtime/history payload 的 timestamp 完整性不一致，且可能影响 tool/reasoning 的既有相对顺序。
- 不延迟 assistant 渲染：会降低流式首段反馈，且不能从根因上保证顺序。

## Verification

- 先添加 reducer regression test，确认旧实现失败。
- 修复后运行该测试及相关 queued-send / optimistic-render tests。
- 在应用中按“运行中发送 queued follow-up”路径手动复现，确认 timeline 顺序正确。

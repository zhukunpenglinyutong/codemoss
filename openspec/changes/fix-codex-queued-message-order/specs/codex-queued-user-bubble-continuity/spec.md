## MODIFIED Requirements

### Requirement: Handoff Bubble SHALL Deduplicate Cleanly With Optimistic Or Authoritative User Items

系统 MUST 在 handoff bubble 只承担过渡可见性的前提下，与后续真实 user item 平滑去重，避免重复气泡或改变既有 timeline 顺序。

#### Scenario: authoritative user item arrives after its assistant realtime item

- **GIVEN** queued follow-up 已生成 optimistic user bubble
- **AND** 对应 assistant realtime item 已先写入 timeline
- **WHEN** equivalent authoritative user item 随后到达
- **THEN** 系统 MUST 用 authoritative user item 原位替换 optimistic user bubble
- **AND** authoritative user item MUST 保持在对应 assistant item 之前
- **AND** timeline MUST 只保留一条等价 user bubble

#### Scenario: queued follow-up remains visible before successor assistant output

- **GIVEN** Codex 的上一轮 assistant 仍在 processing
- **WHEN** 用户发送一个会进入 queue 的 follow-up
- **THEN** 系统 MUST 立即显示该 queued follow-up 的 user bubble
- **AND** 该 bubble MUST 锚定在入队时上一轮 timeline tail 之后
- **AND** 当 successor assistant realtime item 到达时，该 assistant item MUST 显示在 queued user bubble 之后

#### Scenario: queued dispatch establishes canonical optimistic ownership before realtime output

- **GIVEN** queued Codex follow-up 已有 handoff bubble
- **WHEN** queue 开始 dispatch 该 follow-up
- **THEN** 系统 MUST 在 async preparation 与 realtime send 之前写入对应的 `optimistic-user-*` item
- **AND** 后续 authoritative user item MUST 原位接管该 item
- **AND** history/reconcile 收敛前后都 MUST 保持 `user → assistant` 顺序

#### Scenario: next queued follow-up claims the handoff after the prior item becomes canonical

- **GIVEN** 第二条 queued Codex follow-up 的 canonical user item 已位于其 `anchorItemId` 之后
- **AND** 第二轮 assistant 正在 processing
- **WHEN** 用户发送第三条会进入 queue 的 follow-up
- **THEN** 系统 MUST 将 handoff bubble 交接给第三条 follow-up
- **AND** 第三条 bubble MUST 锚定在第二轮已有 timeline tail 之后
- **AND** 更早位置的同文 user item MUST NOT 被当作第三条的 canonical item

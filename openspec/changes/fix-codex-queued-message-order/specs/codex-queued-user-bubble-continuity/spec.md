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

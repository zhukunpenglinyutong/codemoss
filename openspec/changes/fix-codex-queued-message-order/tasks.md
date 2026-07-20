## 1. Implementation

- [x] 1.1 新增 assistant 先到、authoritative user 后到的 reducer regression test。
- [x] 1.2 调整 optimistic user reconciliation，使 authoritative user 原位接管。
- [x] 1.3 确认 generated-image anchor 重定向保持正确。
- [x] 1.4 为 queue 中的 Codex head 建立 anchored handoff bubble，避免用户消息在排队期间不可见。
- [x] 1.5 在 queued Codex dispatch 前同步建立 reducer 内 optimistic user item，并在 preparation 后原位更新。
- [x] 1.6 扩展 handoff presentation 与 optimistic-render 回归测试，覆盖连续第二、第三条排队消息及同文历史消息去重边界。

## 2. Verification

- [x] 2.1 运行新增 reducer test，并确认修复前失败、修复后通过。
- [x] 2.2 运行 queued-send 和 optimistic-render focused tests。
- [x] 2.3 执行 `npm run typecheck` 与相关 lint。
- [x] 2.4 运行新增 queue / handoff / optimistic-render 定向测试，并确认修复前失败、修复后通过。
- [ ] 2.5 在 Codex queued follow-up 场景完成手动验证。

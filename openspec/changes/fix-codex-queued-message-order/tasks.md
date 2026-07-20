## 1. Implementation

- [x] 1.1 新增 assistant 先到、authoritative user 后到的 reducer regression test。
- [x] 1.2 调整 optimistic user reconciliation，使 authoritative user 原位接管。
- [x] 1.3 确认 generated-image anchor 重定向保持正确。

## 2. Verification

- [x] 2.1 运行新增 reducer test，并确认修复前失败、修复后通过。
- [x] 2.2 运行 queued-send 和 optimistic-render focused tests。
- [x] 2.3 执行 `npm run typecheck` 与相关 lint。
- [ ] 2.4 在 Codex queued follow-up 场景完成手动验证。

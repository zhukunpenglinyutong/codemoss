# 修复 Linux analytics 启动崩溃并核验 React 收敛

## OpenSpec

- Change ID: `fix-linux-startup-webkit-react-loop`
- Canonical artifacts: `openspec/changes/fix-linux-startup-webkit-react-loop/**`

## 目标

在独立 worktree 中以最小修改修复 production Linux/WebKitGTK 下百度统计请求触发 WebKitNetworkProcess/libsoup 崩溃的问题，并核验阻断统计后曾观测到的 React #185 已由 baseline convergence fixes 覆盖。新增 analytics 修复必须由 pre-fix failing regression test、post-fix targeted gates、production ELF 与 AppImage 真实启动证据共同证明；React 链路在无可重复 real-seam failure 时不增加 speculative guard。

## 边界

- 不修改主工作树、display/PRIME/proxy；用户明确授权的本地 desktop launcher 调整保持在 Git/PR scope 之外。
- 不升级 dependency，不做 AppShell 无关重构。
- analytics guard 必须发生在 script/network creation 前，并只影响确认受影响的 Linux WebKitGTK production path。
- React #185 必须先核对 build identity、source-mapped real owner 与真实 hydration fixture；只有可重复 real-seam failure 才允许新增修复。
- 初始诊断默认不 commit；2026-08-02 用户完成桌面验收并明确授权修正 review finding 后提交 PR。

## 验收

以 OpenSpec `tasks.md` 与 `verification.md` 为准；至少包括 focused/full gates、direct ELF/AppImage 各 120 秒、renderer markers、ErrorBoundary absence、crash-log delta、screenshot/geometry/pixel statistics，以及 temporary application-list launcher 等价启动验证。

## PR Review Follow-up

- `/review` 发现原 guard 会同时禁用 Linux Web Service browser analytics；最终实现必须仅禁用 Linux native Tauri/WebKitGTK。
- Regression 必须同时证明 Linux native no-injection 与 Linux Web Service production injection。
- PR 不包含用户 launcher、wrapper、AppImage binary 或其他 host-local configuration。

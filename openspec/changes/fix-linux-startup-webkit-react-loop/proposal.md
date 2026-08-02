## Why

`ccgui@0.7.15` 在本机 Ubuntu 22.04 / X11 / WebKitGTK 2.50.4 / libsoup 3.0.7 的真实 production 启动中首先发生确定性的百度统计崩溃：v0.7.13 起注入的 `hm.baidu.com` 请求会触发 `WebKitNetworkProcess` 在 libsoup 内 `SIGSEGV`，窗口因此只剩菜单栏和标题栏。阻断统计请求的一次诊断运行随后记录过 React `Maximum update depth exceeded`（#185）并落入 ErrorBoundary；production source map 将 owner 映射到 `useModels`，但故障 bundle 与当前 baseline 重建 bundle 的 SHA-256 完全一致，而 baseline 已包含 `4c5e97c8e`、`e6e964d88` 两次 #185 收敛修复。多个隔离 settings/workspace hydration fixture 均未再次触发 #185，因此本 change 只新增可 red/green 证明的 Linux analytics guard，并把既有 #185 修复作为必须重新通过的 startup convergence baseline，而不叠加 speculative state guard。

## 目标与边界

- 在受影响的 Linux/WebKitGTK runtime 中，于 DOM script 创建和 network request 之前阻断百度统计注入。
- 通过 matching production source map 与窄 instrumentation 核对 React #185 owner，确认当前 bundle 是否已经包含现有 convergence fix；只有能在真实 seam 重现时才新增 state guard。
- 使用正确的 Tauri `custom-protocol` production build，同时验证 direct ELF、AppImage 与 desktop-entry-equivalent 启动。
- 保留其他平台、Linux Web Service browser、development build、非主窗口以及相邻 composer/model/session 行为。

## 非目标

- 不升级或替换 WebKitGTK/libsoup，不修改系统 proxy、PRIME/display mode、IME 或用户启动器。
- 不通过延迟 analytics、吞掉 NetworkProcess failure、关闭 ErrorBoundary、增加 arbitrary timeout 或 broad AppShell refactor 掩盖故障。
- 不新增 dependency，不改变 analytics site id，不修改持久化 schema。
- 不把 `cargo build --release` 的 dev-server 黑屏当作 production 对照；production ELF 必须启用 `custom-protocol`。

## What Changes

- 为现有 `installBaiduTongji` 注入边界增加 affected Linux native Tauri/WebKitGTK guard，并扩展 focused Vitest 覆盖 Linux native no-injection、Linux Web Service browser 与 unaffected-platform production behavior。
- 将 minified React stack 映射回当前源码，并核对故障 bundle 与 baseline build identity；复用已有 `useModels` convergence tests，删除无法重现 failure loop 的临时组合测试与 instrumentation。
- 增加 Linux renderer startup verification：renderer-ready、无 `react/error-boundary`、无新 WebKit/libsoup crash，以及非空白/非 ErrorBoundary window evidence。
- 在 OpenSpec verification 中记录 release ELF、AppImage 和 temporary desktop-entry-equivalent 运行证据；真实 launcher 与 main worktree 保持不变。

## Capabilities

### New Capabilities

- `linux-renderer-startup-stability`: 约束 Linux/WebKitGTK external analytics safety、React startup state convergence 与 production artifact runtime evidence。

### Modified Capabilities

- 无。现有 `linux-appimage-startup-compatibility` 主要约束 Wayland/AppImage host fallback；本 change 同时覆盖 X11 与 direct ELF 的 renderer 侧故障，因此建立独立、较窄的 renderer capability。

## 方案对比与取舍

1. **采用：只在已复现 owner 上增加最小 guard。** analytics 在 script injection boundary 按 affected runtime fail closed；React 继续复用 baseline 已有的 single-plan、snapshot-ref 与 semantic no-op contract。该方案避免把一次不可复现的 #185 观察转化成未经证实的第二层状态逻辑。
2. **备选：升级 WebKitGTK/libsoup 或强制 proxy/display fallback。** 这会改变用户系统且不能解释 React #185，因此拒绝。
3. **备选：Linux 全面禁网或延后 analytics。** 前者破坏产品功能，后者仍可能触发同一 NetworkProcess crash，因此拒绝。
4. **备选：ErrorBoundary 自动 reload。** 会把 deterministic update loop 变成 reload loop，丢失根因且无法满足可用性验收，因此拒绝。

## 验收标准

- focused test 证明 fix 前 production Linux native renderer 会注入唯一 site id，fix 后 affected runtime 不创建相关 script/request；Linux Web Service browser、development、secondary window 与 unaffected production platform 行为保持。
- 现有 React #185 focused tests、AppShell startup tests 与 production runtime 均证明 selection convergence；若不能让当前 baseline 在 real seam 失败，则不得新增声称“修复 #185”的测试或 guard。
- release ELF 使用 `--features custom-protocol`，与 worktree AppImage 各连续运行至少 120 秒；两者均有 `bootstrap/render-committed`、`bootstrap/renderer-ready-marked`，无 `react/error-boundary`。
- 每次 launch timestamp 之后没有新的 `WebKitNetworkProcess` / libsoup kernel、journal 或 apport crash。
- screenshot、window geometry 与 pixel statistics 共同证明 content area 非白屏、非黑屏、非透明、非 ErrorBoundary-only。
- full lint/typecheck/test/build/runtime-contract/OpenSpec gates 通过；temporary launcher、process、source map 与 instrumentation 全部清理，main worktree 与真实 launcher 未变化。

## Impact

- Frontend: `src/services/baiduTongji.ts` 及其 test；React 路径只做 source-map/build-identity/既有 tests 的验证，不新增 production source diff。
- Packaging/runtime: Vite production bundle、Tauri release ELF、Linux AppImage；不修改 Rust command contract 或 system config。
- Specs: 新增 `linux-renderer-startup-stability` delta 与 change-local verification evidence。
- Dependencies/storage: 无新增 dependency，无 schema migration。

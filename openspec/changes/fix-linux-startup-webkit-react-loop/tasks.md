## 1. Isolation And Diagnosis

- [x] 1.1 [P0, depends: none] 在独立 worktree 核对 baseline、launcher、WebKit/libsoup/runtime facts，读取 frontend hook/state/quality/type-safety 与 render-jank 指南；输出 main/new worktree status evidence。
- [x] 1.2 [P0, depends: 1.1] 用 matching production source map 与 development updater trace 映射 React #185；完成 build identity、单变量 fixture 与真实 migration hydration 核对。
- [x] 1.3 [P0, depends: 1.2] 创建 linked Trellis task，记录 OpenSpec change id、worktree boundary、pre-fix signals 与 verification commands。

## 2. Linux Analytics Crash Guard

- [x] 2.1 [P0, depends: 1.1] 在 `src/services/baiduTongji.test.ts` 增加 affected production Linux/WebKitGTK failing regression，并保留 development、secondary-window、unaffected production cases。
- [x] 2.2 [P0, depends: 2.1] 在现有 analytics service boundary 增加最小 platform/runtime guard，确保在 `_hmt`/script/network creation 前 return；不新增 dependency，不修改 CSP/site id。
- [x] 2.3 [P0, depends: 2.2] 运行 focused Vitest、typecheck、production build，检查 unique site id 的实际 guarded call path并记录 red/green evidence。
- [x] 2.4 [P1, depends: 2.3] 根据 `/review` finding 将 Linux guard 收窄到 native Tauri/WebKitGTK；新增 Linux Web Service browser regression，证明普通 browser production 仍保留 analytics。

## 3. React Startup Convergence

- [x] 3.1 [P0, depends: 1.2,2.3] 核对 source-mapped real seam：当前 baseline 已含 #185 fix，组合 fixture 与真实 migration hydration 均未复现 unbounded update；删除 StrictMode-only false-positive 临时测试。
- [x] 3.2 [P0, depends: 3.1] 不新增 speculative React source guard；复核现有 semantic no-op / snapshot-ref / acyclic dependency fix 与相邻 model/freeform/session tests。
- [x] 3.3 [P0, depends: 3.2] 运行 focused tests、AppShell runtime contract、typecheck/build，并用 no-analytics production ELF 越过原 failure window；删除全部 temporary instrumentation/source map edits。

## 4. Production Artifact Verification

- [x] 4.1 [P0, depends: 2.3,3.3] 运行 lint、typecheck、full tests、runtime contracts、Vite build 与 `cargo build --release --bin cc-gui --features custom-protocol`，记录 exact exit summaries。
- [x] 4.2 [P0, depends: 4.1] direct ELF 连续运行至少 120 秒；验证 render/ready markers、无 ErrorBoundary、无 launch timestamp 后的新 WebKit/libsoup crash，并捕获 screenshot/pixel/geometry evidence。
- [x] 4.3 [P0, depends: 4.2] `npm run build:appimage` 后直接启动 worktree artifact，再用 temporary XDG desktop entry 复用真实 wrapper environment 启动；每条 path 观察至少 120 秒并执行同一 evidence contract。
- [x] 4.4 [P0, depends: 4.3] 删除 temporary entry/process/source maps/instrumentation，运行 `check`、`check-cross-layer`、`finish-work`，更新 `verification.md`，复核 main worktree/index/HEAD、真实 launcher 与 system settings 未变化。

## 5. PR Readiness

- [x] 5.1 [P0, depends: 2.4,4.4] 重新运行 focused/full gates、OpenSpec validation 与 final AppImage runtime verification，记录收窄 guard 后的 artifact SHA-256 和 launch evidence。
- [x] 5.2 [P0, depends: 5.1] 执行最终 `/review`、`check`、`check-cross-layer`、`finish-work`，确认 PR 不包含本地 launcher/AppImage artifact，并提交、记录 Trellis session、推送和创建 PR。

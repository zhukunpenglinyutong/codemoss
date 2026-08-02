## Context

现场证据把 startup failure 分成确定性与一次性两层：原版 `v0.7.15` 在 analytics script 发起 `hm.baidu.com` 请求时，`WebKitNetworkProcess` 同秒在 `libsoup-3.0.so.0 + 0x4b1d5` 崩溃；绕 proxy、AppImage/direct ELF A/B 都复现。临时完全移除 `installBaiduTongji()` 后的一次运行在 render/ready markers 后记录过 React #185。matching source map 将栈定位到 `useModels.applySelectionPlan`，但原 production `App-D-NB5kA4.js` 与当前 baseline 重建产物 SHA-256 同为 `0403d66005420cdd1dc3283952b3f72e901695b7b78c36edfb3916f1c953c9f2`，证明它已包含 `4c5e97c8e`、`e6e964d88` 的 #185 修复。真实 migration fixture 与多个单变量组合均无法让当前 baseline 再次进入 ErrorBoundary，因此新增修复只针对可复现的 analytics owner；React 作为既有 convergence contract 重新验证。

现有 main worktree 有用户改动 `package-lock.json` 与 `.codegraph/`，实现必须在独立 linked worktree 完成。验证使用 temporary XDG desktop entry 指向 worktree artifact，复用既有 launcher 的 GStreamer environment，不覆盖 main-worktree artifact；用户后续选择的本地 launcher 配置不属于 Git/PR scope。

## Goals / Non-Goals

**Goals:**

- network request prevention 位于 analytics injection boundary，且 affected runtime 判定可测试。
- React #185 verification 锚定 source-mapped update owner；复核 baseline 的 semantic no-op、snapshot-ref 与 real-seam regression，不在无法重现时新增 production guard。
- production verification 能同时证明 process、renderer event、crash delta 与 visible window。

**Non-Goals:**

- 不改变 WebKit host fallback、CSP allowlist、analytics provider/site id 或其他平台 telemetry policy。
- 不假定最近含 `#185` 的 commit 必然是根因；commit history 仅用于 hypothesis 排序。
- 不以 dev build、bare Cargo release、单测或存活 PID 单独宣称修复。

## Decisions

### 1. Analytics 在 request creation 前按 affected runtime fail closed

`installBaiduTongji` 继续拥有 production/main-window gating。本 change 在同一 boundary 增加 Linux native Tauri/WebKitGTK guard，使 affected runtime 在创建 `<script>`、初始化 `_hmt` 或接触 NetworkProcess 前 return。`window.__MOSSX_WEB_SERVICE__ === true` 明确标识 daemon 提供的普通 browser runtime；该路径不经过 native `WebKitNetworkProcess`/libsoup，必须保留原 analytics behavior。平台信号复用现有 `detectRendererPlatform` 与 Web Service marker，不新增 async IPC 或 dependency。

为何不只改 `main.tsx`：调用点 guard 会让 unit test 只能证明 caller 条件，无法证明 analytics service 本身不会被其他 caller 误用；service boundary 是唯一 request owner。为何不删除 CSP domain：CSP 只控制 allow/deny，不能阻止 script load attempt，也不能作为 analytics 是否注入的证据。

### 2. React owner 先 source-map 与 build identity 校准，再决定是否改代码

先对原始 minified frames 使用 matching production source map，并用 bundle hash 证明 source 对应关系；随后在 development React build 安装最小 updater/component-stack probe，对 3–5 个 hypotheses 一次只改变一个 variable。只有 real producer/consumer exchange 能在当前 baseline 形成 unbounded update 时，才允许新增 regression 与 production guard。

本次结果是现有 `useModels` 已具备 single selection plan、snapshot-ref 与 semantic no-op；same-value functional setter probe 也证明调用 setter 本身不会形成 loop。由于 `k3/null`、空 sidebar hydration 与真实 workspace hydration 等 fixture 均未复现，不新增“plan equal 就跳过 apply”等 speculative guard。禁止关闭 effect、忽略错误或 broad memoization；若未来新证据能稳定复现，应另开带 failing real-seam regression 的 change。

### 3. Runtime 判定采用四类独立 evidence

每次 production launch 都记录 start timestamp/PID，并在 120 秒窗口检查：

1. `bootstrap/render-committed` 与 `bootstrap/renderer-ready-marked`；
2. 无 `react/error-boundary`；
3. timestamp 之后无 kernel/journal/apport WebKit/libsoup crash；
4. window screenshot + geometry + pixel distribution 证明非空白/error fallback。

ELF 先运行，AppImage 后运行。AppImage 再通过 temporary XDG desktop entry 触发一次 application-list-equivalent launch；entry 与 process 在 evidence 捕获后清理。真实 `.desktop` 和 wrapper 只读核对，不修改。

## Risks / Trade-offs

- [Risk] Runtime platform signal 被 spoof 或缺失 → focused tests 同时覆盖 Linux navigator fact、native marker absence 与 Web Service marker presence；缺失时保持 current non-Linux behavior，不扩大 fail closed 范围。
- [Risk] Production source map hash 与现场 asset 不同 → fallback 到 development component stack/updater trace，并用同一 release runtime event sequence复验。
- [Risk] AppImage build 非确定或耗时 → direct ELF 先关闭功能风险；AppImage 仍是 terminal acceptance，不因 ELF green 跳过。
- [Trade-off] Linux/WebKitGTK 不上报百度统计 PV/UV；相较 deterministic native process crash，startup 可用性优先。

## Migration Plan

1. 为 analytics 创建 pre-fix failing regression；对 React 完成 source-map/build-identity 与 real-seam fixture 核对。
2. 只为可重复的 analytics owner 落地最小 guard；React 复用并重跑 baseline 已有 convergence tests。
3. 运行 full gates 和 direct ELF/AppImage/desktop-entry-equivalent runtime verification。
4. 更新 `verification.md`；满足 human gate 前不 archive，不修改 release launcher。

Rollback 只需回退 analytics guard 与对应 regression test；React production source 未在本 change 修改。无 data/schema migration。

## Open Questions

- 现场一次性 #185 的 source owner 已定位到 `useModels.applySelectionPlan` 链，但当前 baseline 新增触发条件仍未复原；该边界必须在 verification 中明确记录，不能表述为“本 change 新修复了第二个 React bug”。

# Verification

## 1. Scope And Classification

- Verification worktree：独立 linked worktree（不复用 main worktree）
- Branch：`fix/linux-startup-webkit-react-loop`
- Production source fix 仅涉及 `src/services/baiduTongji.ts`；regression test 位于同层 `src/services/baiduTongji.test.ts`。
- Linux native Tauri/WebKitGTK production 在 `_hmt`、`<script>`、`hm.baidu.com` network request 创建前 return；Linux Web Service browser、Windows production、development、secondary window contract 保持不变。
- React #185 未增加 speculative guard。故障现场 bundle 与当前 baseline 重建 bundle 的 SHA-256 同为 `0403d66005420cdd1dc3283952b3f72e901695b7b78c36edfb3916f1c953c9f2`；baseline 已包含既有 convergence fixes `4c5e97c8e`、`e6e964d88`，多组 fixture 与真实 migration hydration 均未再次复现。

## 2. Regression And Quality Gates

| Command / probe | Result |
|---|---|
| baseline source + 新 Linux native analytics test | expected red：`1 failed / 3 passed`，实际创建 `hm.baidu.com` script |
| `/review` 后新增 Linux Web Service regression（应用收窄前） | expected red：`1 failed / 4 passed`，Linux Web Service 被原 guard 误禁用 |
| final `baiduTongji.test.ts` | `5 passed`；Linux native 不注入，Linux Web Service/Windows production 保留注入 |
| final focused Vitest（含 `useModels` 与 real-seam `app-shell.startup.test.tsx`） | `3 files passed / 39 tests passed` |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0；0 errors，9 existing warnings |
| `npm run check:runtime-contracts` | exit 0 |
| `npm run build` | exit 0 |
| `cargo build --release --bin cc-gui --features custom-protocol` | exit 0；final AppImage build 内 release compilation `9m45s` |
| full Vitest | batch 19 only `Sidebar.test.tsx` 2 failures / 51 passed；fix worktree 与 main worktree 精确同样失败，按已授权 baseline exception 继续 |

Full-test baseline failures：

- `creates a new session directly inside a workspace session folder`
- `moves codex pending folder intent after catalog-backed session exists`
- 两者均找不到 `menuitemradio /codex-tui\/default-config/`；不在本 change 修改范围。

Production bundle 检查确认 guard 顺序为：

```js
if (
  !isMainWindow() ||
  (window.__MOSSX_WEB_SERVICE__ !== true &&
    detectRendererPlatform() === "linux")
) return;
window._hmt = /* ... */;
```

## 3. Production Artifact

- `npm run build:appimage` 完成 Rust release build 和 AppImage bundle 生成。
- Artifact：`src-tauri/target/release/bundle/appimage/ccgui_0.7.15_amd64.AppImage`
- SHA-256：`d8d2a4e5971c05b056027ceacc9233674fc272a1aad1cdb4710a987222cc600c`
- Size：`106658296` bytes；mtime `2026-08-02 22:13:12 +0800`。
- Rust release build：`9m45s`；AppImage bundle 在 signing gate 前成功生成。
- Bundle 生成后命令因本机只有 Tauri public key、缺少 `TAURI_SIGNING_PRIVATE_KEY` 而 exit 1；这是 post-bundle signing environment failure，不影响本地 artifact runtime verification，也未安装或写入 signing config。

## 4. Runtime Evidence Contract

每条路径都验证：process 持续存活至少 120 秒；window `Map State` 为 `IsViewable`；截图包含真实 sidebar/composer/content，而非 white/black single-color surface；启动 timestamp 后 app error log、user journal、coredump 均无 `react/error-boundary`、`Maximum update depth`、`WebKitNetworkProcess` crash、`libsoup` crash 或 `SIGSEGV`。

| Launch path | Duration | Window / pixel evidence | Result |
|---|---:|---|---|
| direct release ELF | 182s | `1552x1043` / `IsViewable`; 6625 colors；mean `0.975070`；stddev `0.065551`；sidebar、workspace、composer、model selector 可见 | pass |
| direct generated AppImage | 181s | `1552x1043` / `IsViewable`; 6574 colors；mean `0.974618`；stddev `0.065051`；min `3341`，max `65535` | pass |
| actual application-list launcher (`gtk-launch` → user-local `.desktop` → wrapper → same AppImage) | 209s | `1552x1043` / `IsViewable`; 6574 colors；mean `0.974618`；stddev `0.065051`；min `3341`，max `65535` | pass |

Direct ELF markers：

- `renderer/install`: `1785680038850`
- `bootstrap/render-committed`: `1785680039429`
- `bootstrap/renderer-ready-marked`: `1785680040405`

同一 AppImage SHA-256 的 completion-marker recheck：

| Launch path | `renderer/install` | `render-committed` | `renderer-ready-marked` | target errors |
|---|---:|---:|---:|---:|
| direct AppImage | `1785680251039` | `1785680251627` | `1785680252656` | app/journal/coredump 均 0 |
| actual application-list launcher | `1785680775541` | `1785680776174` | `1785680777315` | app/journal/coredump 均 0 |

User-local launcher 复用既有 GStreamer environment，并指向上述同一 AppImage SHA-256；launcher、wrapper 与 AppImage 在最终 209 秒运行前后 checksum 保持一致。该 host-local launcher 配置不属于 Git/PR diff；`ccgui-latest.desktop` 与 `ccgui-latest-appimage` 未修改。

## 5. Review Boundary

- `check`：service/test placement、strict TypeScript、test coverage、forbidden patterns 均无 violation。
- `check-cross-layer`：change 不跨 3+ layers；复用现有 `detectRendererPlatform`，未创建重复 utility；analytics call site 仅为 `src/main.tsx`，site id 与 script injection 仅有一个 owner。
- `finish-work`：lint/typecheck/runtime contracts/focused regression/build/manual startup evidence 已完成；full-test 仅保留已在 main/fix 双树证明相同的 baseline exception；无 API、database、infra 或 cross-layer contract 变更，因此无需新增 `.trellis/spec/**` executable contract。
- Final `codex review --uncommitted`：未发现本次变更引入的可操作缺陷；额外复核 Web Service shim 注入顺序、native/Web Service runtime branch 与 production minified bundle，并再次通过 focused Vitest、typecheck、build 与 targeted ESLint。
- Cleanup audit：temporary HOME、temporary `.desktop`/wrapper、screenshots、source maps/instrumentation 与全部测试进程均已删除；这些 transient artifacts 不进入 Git/PR。
- Main worktree HEAD 仍为 `8b2a3a7c2297cff4aa2211057c7bd0926dbb4375`，index empty，原有 `M package-lock.json` 与 `?? .codegraph/` 保持不变。
- 未触及的 baseline launcher checksum 保持不变：`ccgui-latest.desktop` 为 `bd43af818c396ad76841ffcf593435d19e5caad2eb4ce5b512fcca689dc1acbb`；`ccgui-latest-appimage` 为 `189c05a40d26b6130514ed99bcebb87f9019f71a0f647d518683fe89232eaffe`。
- 本验证证明 startup white/black screen 与目标 crash 已修复；不把 startup screenshot 扩大解释为所有业务交互均已完成 manual acceptance。

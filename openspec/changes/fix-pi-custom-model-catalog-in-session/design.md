# Design: fix-pi-custom-model-catalog-in-session

## Decisions

### D1: profile/home single source

新增带 `home_override` 的 Pi detection path。启动轻量检测仍保持 `include_models=false`，
on-demand catalog 才运行 RPC / list-models / configured merge，避免恢复启动重探开销。

### D2: catalog identity

configured model 使用 `provider/modelId` 作为 `ModelInfo.id` 与 runtime model，friendly
`name` 放入 description。完整 identity 由现有 `split_provider_model` 拆分，并交给
`plan_rpc_model_reconcile` / `set_model(provider, modelId)`。

### D3: fallback diagnostic

RPC 成功优先；失败后尝试两段 `--list-models`。全部失败时 generated fallback MAY
保留，但 MUST 同时合并可解析的 configured models，并返回最终 probe error。

## Verification

- Rust tests 覆盖 requested profile loader 与 resident model reconcile matrix。
- `rustfmt --check`、`typecheck`、runtime contracts、strict OpenSpec validation。
- macOS GUI 验证新建/已有 Pi 会话选择 configured model 后正常回复。

# Change: fix-pi-custom-model-catalog-in-session

## Why

设置页已能读取 Pi profile 下的 `models.json`，但会话 `get_engine_models("pi")`
仍主要依赖 RPC / `pi --list-models` / generated fallback。profile/home 未统一时，
configured provider/model 会在设置页可见，却无法在会话中选择和使用。

## What Changes

- RPC、`pi --list-models` 与 `models.json` loader 统一使用当前 Pi engine config 的 `home_dir`。
- 将 configured provider/model 合并进会话 catalog，并以 `provider/modelId` 作为完整 identity。
- 复用现有 resident reconcile，在下一轮调用 `set_model(provider, modelId)`。
- CLI catalog 探测失败时保留 configured models，并通过 `EngineStatus.error` 暴露 diagnostic。

## Acceptance

- 新建会话与已有会话均可选择 configured model 并正常完成下一轮发送。
- model selector 显示完整 `provider/modelId`。
- macOS GUI 已完成实机验证。

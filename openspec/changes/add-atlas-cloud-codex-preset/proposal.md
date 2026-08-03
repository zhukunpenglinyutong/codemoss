## Why

Codex provider management already exposes curated OpenAI-compatible presets, but Atlas Cloud users must currently assemble `config.toml` manually. A first-class preset removes that error-prone setup while preserving the existing managed-provider runtime path.

## 目标与边界

- Add an Atlas Cloud choice to the existing Codex provider preset catalog.
- Pre-fill the OpenAI-compatible endpoint, provider id, model id, and Chat Completions wire protocol.
- Keep authentication in the existing `auth.json` editor and never persist a real key in source.

## 非目标

- 不修改 Codex runtime transport、provider switching 或 session binding。
- 不新增 Atlas Cloud logo、推广文案、依赖或 README 内容。
- 不改变其他 provider preset 的默认值。

## What Changes

- Add the `atlas-cloud` Codex provider preset with `https://api.atlascloud.ai/v1`, `deepseek-ai/deepseek-v4-pro`, and `wire_api = "chat"`.
- Add English and Simplified Chinese preset labels.
- Add a focused dialog regression test for the generated provider config.

## Capabilities

### New Capabilities

- `codex-provider-management`: Codex provider preset management and generated connection configuration.

### Modified Capabilities

无。

## 验收标准

- Selecting Atlas Cloud fills the expected provider name, endpoint, model, provider id, and Chat Completions wire protocol.
- Existing custom, official, and third-party presets remain unchanged.
- Focused tests, TypeScript checks, production build, diff/secret checks, and a real Atlas Cloud Chat Completions request pass.

## Impact

- `src/features/vendors/types.ts`
- `src/features/vendors/components/CodexProviderDialog.test.tsx`
- `src/i18n/locales/{en,zh}/settings.ts`
- No dependency, lockfile, README, backend, or storage changes.

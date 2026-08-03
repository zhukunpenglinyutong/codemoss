## Context

Codex presets are typed data entries that generate a managed `config.toml` and reuse the existing `auth.json` editor. The runtime already supports OpenAI-compatible providers and the `chat` wire API, so Atlas Cloud requires no transport or persistence changes.

## Goals / Non-Goals

**Goals:**

- Reuse `buildCodexProviderConfigToml` as the single config generator.
- Make the Atlas Cloud endpoint and default model explicit and testable.
- Keep the change isolated to provider catalog data and localization.

**Non-Goals:**

- Add a dedicated network client or runtime adapter.
- Store API keys in the preset.
- Add marketing assets or documentation.

## Decisions

### 1. Use the existing Codex provider preset catalog

The preset uses id `atlas-cloud` and provider id `atlas_cloud`. This preserves the current dialog, save, and managed session launch flow.

### 2. Use Chat Completions explicitly

Atlas Cloud exposes an OpenAI-compatible Chat Completions API. The generated config therefore sets `wire_api = "chat"` instead of relying on the helper default.

### 3. Keep credentials empty

The preset reuses `DEFAULT_CODEX_AUTH_JSON`, leaving `OPENAI_API_KEY` empty for the user to provide through the existing secure editor.

## Risks / Trade-offs

- [Risk] Atlas Cloud changes a recommended model id -> the preset remains editable after selection, matching all existing third-party presets.
- [Risk] A generic icon is less recognizable -> no unofficial logo is introduced; visual branding can be added separately if an approved asset exists.

## Migration Plan

No migration is required. Removing the preset fully rolls back the change without affecting saved custom providers.

## Open Questions

无。

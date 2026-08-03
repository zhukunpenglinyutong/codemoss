## ADDED Requirements

### Requirement: Atlas Cloud MUST Be Available As A Codex Provider Preset

Codex provider management MUST offer Atlas Cloud as a selectable OpenAI-compatible preset. Selecting it MUST generate configuration for `https://api.atlascloud.ai/v1`, provider id `atlas_cloud`, default model `deepseek-ai/deepseek-v4-pro`, and the Chat Completions wire API while leaving the API key empty for user input.

#### Scenario: user selects the Atlas Cloud preset

- **WHEN** a user adds a Codex provider and selects Atlas Cloud
- **THEN** the provider name MUST be `Atlas Cloud`
- **AND** generated `config.toml` MUST use `https://api.atlascloud.ai/v1`
- **AND** generated `config.toml` MUST use model `deepseek-ai/deepseek-v4-pro`
- **AND** generated `config.toml` MUST set `model_provider = "atlas_cloud"`
- **AND** generated `config.toml` MUST set `wire_api = "chat"`
- **AND** generated `auth.json` MUST NOT contain a real API key

#### Scenario: existing provider behavior remains unchanged

- **WHEN** a user selects any existing official, custom, or third-party Codex preset
- **THEN** its existing generated configuration MUST remain unchanged
- **AND** Atlas Cloud support MUST NOT add a new runtime transport or storage path

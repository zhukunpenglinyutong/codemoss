## ADDED Requirements

### Requirement: Configured Pi models MUST enter the session catalog

`get_engine_models("pi")` MUST merge configured provider/models from the current Pi
profile/home into the session catalog. Each configured entry MUST expose the complete
`provider/modelId` identity. Selecting it in a new or resident session MUST cause the
next turn to use `set_model(provider, modelId)`.

RPC, `pi --list-models`, and `models.json` loading MUST use the same profile/home.
When CLI catalog probing fails, configured models MUST remain selectable and the engine
status MUST expose a diagnostic instead of silently presenting only generated fallback.

#### Scenario: Configured model is selectable

- **WHEN** the active Pi profile defines `cliproxy/gpt-custom` in `models.json`
- **THEN** the session model catalog MUST contain `cliproxy/gpt-custom`
- **AND** selecting it MUST apply `set_model("cliproxy", "gpt-custom")` before the next turn

#### Scenario: CLI probing fails

- **WHEN** RPC and both `pi --list-models` attempts fail
- **AND** the active profile contains a valid configured model
- **THEN** the configured model MUST remain in the catalog
- **AND** the engine status MUST contain the probe diagnostic

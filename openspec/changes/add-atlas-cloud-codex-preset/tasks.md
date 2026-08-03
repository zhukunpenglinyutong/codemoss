## 1. Provider Catalog

- [x] 1.1 [P0, depends: none] Add the Atlas Cloud Codex preset using the existing typed config builder.
- [x] 1.2 [P0, depends: 1.1] Add English and Simplified Chinese labels.

## 2. Regression Coverage

- [x] 2.1 [P0, depends: 1.1] Verify the selected preset fills endpoint, model, provider id, and Chat Completions wire protocol.

## 3. Closure

- [x] 3.1 [P0, depends: 2.1] Run focused Vitest, typecheck, production build, strict OpenSpec validation, diff/secret checks, and a real Atlas Cloud request.
- [x] 3.2 [P1, depends: 3.1] Prepare Trellis session evidence and a signed commit.

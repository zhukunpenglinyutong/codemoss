# Add Windows Portable Build Workflow

## Goal

Add a reproducible Windows x64 portable ZIP build that runs in GitHub Actions without release secrets, while keeping the existing signed multi-platform release workflow unchanged. Build the local unsigned macOS arm64 DMG from the same source commit.

## Requirements

- Add `npm run build:win-portable` as the supported Windows portable build entrypoint.
- Build the Tauri application with `--no-bundle` and explicitly build `cc_gui_daemon.exe`.
- Stage `cc-gui.exe`, `cc_gui_daemon.exe`, `dist/`, `curated-skills/`, `skills-lock.json`, and `PORTABLE_README.txt` into a versioned directory.
- Fail with a clear error when any required portable artifact is missing.
- Produce `release-local/ccgui_<version>_windows_x64_portable.zip` and replace stale staging output on repeated builds.
- Add an independent Windows GitHub Actions workflow for pull requests and manual dispatch, with no release secrets and no GitHub Release side effects.
- Keep user data in the normal Windows AppData location and rely on the system WebView2 runtime.
- Document the portable artifact contract and operator commands.

## Acceptance Criteria

- [x] The packaging contract is covered by automated tests for complete, missing-file, and stale-output cases.
- [ ] Windows CI runs `npm ci`, `npm run doctor:win`, and `npm run build:win-portable` on `windows-latest`.
- [ ] CI verifies the daemon executable and portable ZIP contents before uploading the artifact.
- [x] Existing `.github/workflows/release.yml` remains unchanged.
- [x] Frontend lint, typecheck, runtime-contract checks, and strict doctor checks pass where supported; the full frontend suite retains six pre-existing `src/app-shell.startup.test.tsx` timeouts on Node 20 and Node 24.
- [x] Local macOS arm64 DMG build is attempted with signing and notarization disabled; the DMG verifies, mounts, and launches on Apple Silicon.
- [ ] The branch is committed and pushed to `origin/codex/windows-portable-build`.

## Code-Spec Contract

- Target spec: `.trellis/spec/backend/windows-portable-build.md`.
- Command: `npm run build:win-portable` is Windows-only and returns non-zero outside Windows or for incomplete outputs.
- Artifact layout: executable pair and resource directories are siblings at the ZIP root.
- CI: portable workflow uploads Actions artifacts only and must not consume signing or release credentials.
- Error matrix: unsupported OS, missing executable/resource, archive failure, and stale staging output must have deterministic behavior.
- Good case: complete x64 ZIP from a clean GitHub runner.
- Base case: repeated build replaces the previous staging directory and ZIP.
- Bad case: a ZIP is uploaded without the daemon or packaged skills.

## Technical Notes

- The existing formal release workflow creates GitHub releases and post-release version bump PRs, so it is intentionally not reused.
- Tauri has no native portable bundle target; the ZIP must be assembled from the release executables and configured resources.
- The local `openspec` CLI is unavailable, so OpenSpec creation/validation cannot be completed in this environment.

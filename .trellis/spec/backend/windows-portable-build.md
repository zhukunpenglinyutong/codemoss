# Windows Portable Build Contract

## Scenario: GitHub Actions Windows x64 portable ZIP

### 1. Scope / Trigger

- Trigger: adding or changing the Windows no-install build command, portable ZIP layout, or its GitHub Actions workflow.
- Goal: produce a runnable, reproducible test artifact without invoking installer, signing, updater, or GitHub Release behavior.

### 2. Signatures

- npm command: `npm run build:win-portable`
- build script entry: `node scripts/build-windows-portable.mjs`
- packaging helper: `assembleWindowsPortable(options) -> Promise<{ stagingDir, zipPath, artifactName }>`
- output: `release-local/codeport_<version>_windows_x64_portable.zip`
- CI artifact: `codeport-<version>-windows-x64-portable`

### 3. Contracts

- The command MUST fail on non-Windows hosts before running Tauri or Cargo builds.
- The main app MUST be built with `tauri build --config src-tauri/tauri.windows.conf.json --no-bundle --ci`.
- `cc_gui_daemon.exe` MUST be built explicitly with Cargo even if another build happened to produce it.
- The ZIP root MUST contain these sibling paths:
  - `CodePort.exe` (renamed from the internal Cargo output `cc-gui.exe`)
  - `cc_gui_daemon.exe`
  - `dist/index.html` and `dist/assets/**`
  - `curated-skills/**`
  - `skills-lock.json`
  - `PORTABLE_README.txt`
- Repeated builds MUST delete the previous staging directory and ZIP before copying current outputs.
- Portable mode means no installer; application state continues to use normal Windows AppData paths.
- The artifact relies on the system WebView2 runtime and MUST document that dependency.
- The portable workflow MUST NOT reference the `release` environment, signing secrets, `gh release`, or version-bump behavior.

### 4. Validation & Error Matrix

| Case | Required result |
|---|---|
| Host is not Windows | Exit non-zero with a Windows-only message before build commands run |
| Main executable missing | Exit non-zero and name the internal build output `cc-gui.exe` |
| Daemon executable missing | Exit non-zero and name `cc_gui_daemon.exe` |
| `dist/index.html` or `dist/assets` missing | Exit non-zero and name the missing frontend resource |
| Curated skills or lock file missing | Exit non-zero and name the missing skill resource |
| Old staging output exists | Remove it before copying; no stale sentinel file remains |
| Archive command fails | Exit non-zero; do not report success or upload a partial artifact |
| Complete inputs | Create the versioned ZIP and report its absolute path |

### 5. Good / Base / Bad Cases

- Good: a clean `windows-latest` runner builds both executables, stages all resources, validates the daemon, and uploads the ZIP.
- Base: a second build for the same version replaces the prior directory and ZIP deterministically.
- Bad: copying only `CodePort.exe`; daemon auto-start, web assets, or curated skills then fail at runtime.

### 6. Tests Required

- Unit test a complete fixture and assert every required destination path exists.
- Unit test each required source category missing and assert the error names that path.
- Unit test stale staging cleanup with a sentinel file.
- CI MUST run the focused packaging test, `doctor:win`, the build command, `cc_gui_daemon.exe --help`, ZIP extraction, and post-extraction layout checks.
- Manual Windows 11 smoke test: extract, launch `CodePort.exe`, confirm the app remains running, daemon auto-start works, and curated skills load.

### 7. Wrong vs Correct

#### Wrong

```yaml
- run: npm run tauri -- build --bundles nsis
- uses: actions/upload-artifact@v4
  with:
    path: src-tauri/target/release/cc-gui.exe
```

This is neither portable nor complete: the installer path has release-side concerns and the raw executable lacks required sibling resources.

#### Correct

```yaml
- run: npm run doctor:win
- run: npm run build:win-portable
- run: node --test scripts/build-windows-portable.test.mjs
- uses: actions/upload-artifact@v4
  with:
    path: release-local/codeport_*_windows_x64_portable.zip
```

The dedicated command owns the complete layout and fails closed before CI uploads it.

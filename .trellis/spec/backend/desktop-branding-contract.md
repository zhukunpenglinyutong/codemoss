# Desktop Branding Contract

## Scenario: CodePort product name and application icon

### 1. Scope / Trigger

- Trigger: changing the desktop product name, window title, bundle path, installer/archive name, or application icon.
- Goal: keep CodePort branding consistent across macOS, Windows, Linux, web metadata, CI packaging, and documentation without migrating compatibility-sensitive storage identity.

### 2. Signatures

- Tauri product name: `src-tauri/tauri.conf.json -> productName = "CodePort"`
- Runtime window title: `WebviewWindowBuilder::title("CodePort")`
- Web document title: `<title>CodePort</title>`
- macOS bundle: `CodePort.app`
- local macOS artifact: `release-local/CodePort_<version>_<arch>.dmg`
- Windows portable executable: `CodePort.exe`
- Windows portable archive: `release-local/codeport_<version>_windows_x64_portable.zip`
- source icon: `src-tauri/icons/codeport-app-icon.svg`
- generated desktop icons: `src-tauri/icons/icon.icns`, `src-tauri/icons/icon.ico`, and configured PNG sizes

### 3. Contracts

- User-visible product names MUST use `CodePort`, including bundle names, window titles, installer/archive names, portable launch instructions, and README copy.
- The Windows portable packager MUST copy the internal Cargo output `cc-gui.exe` to the public filename `CodePort.exe`.
- The macOS DMG staging script MUST derive the `.app` item name from the supplied bundle path instead of hard-coding a legacy app name.
- Root, frontend, docs, macOS, and Windows icon files MUST be generated from the same CodePort icon source.
- Compatibility-sensitive internal identity MUST remain stable unless a migration is explicitly designed: Tauri identifier `com.zhukunpenglinyutong.ccgui`, Rust package/bin names, daemon filename, storage directories, local-storage keys, and signing/notary credential names.
- Formal release and local build scripts MUST resolve `CodePort.app`; a product-name change MUST NOT leave a stale `ccgui.app` path that breaks signing, notarization, or packaging.

### 4. Validation & Error Matrix

| Case | Required result |
|---|---|
| Tauri product name is not `CodePort` | `npm run check:branding` fails |
| Runtime or HTML title is not `CodePort` | `npm run check:branding` fails |
| Portable source `cc-gui.exe` exists | Package it as `CodePort.exe` |
| Portable source executable is missing | Fail and name internal source `cc-gui.exe` |
| macOS bundle is `CodePort.app` | DMG stages that exact basename and positions it in Finder |
| Icon generation completes | Desktop, frontend, and docs icon hashes match |
| Internal identifier remains legacy | Existing app data, permissions, and session identity remain attached |

### 5. Good / Base / Bad Cases

- Good: Finder, Dock, window title, Windows extracted executable, artifacts, and docs all display CodePort while existing user data remains available.
- Base: internal diagnostic paths and daemon binaries retain legacy technical names for compatibility but are not presented as the product name.
- Bad: changing only `productName`; the app builds as `CodePort.app` while release scripts still look for `ccgui.app` and fail after compilation.

### 6. Tests Required

- `npm run check:branding` asserts the Tauri product name, runtime title, HTML title, macOS bundle path token, and Windows portable public filename.
- `npm run test:win-portable-packaging` asserts `CodePort.exe`, the CodePort artifact name, missing-source behavior, and stale-output cleanup.
- YAML syntax validation for release and Windows portable workflows.
- `npm run doctor:strict` and `npm run check:runtime-contracts` after branding/config changes.
- macOS unsigned arm64 build: verify the DMG, mount it, assert `CodePort.app` and the new icon, then launch briefly.

### 7. Wrong vs Correct

#### Wrong

```json
{ "productName": "CodePort" }
```

```bash
APP_PATH=src-tauri/target/release/bundle/macos/ccgui.app
```

#### Correct

```json
{ "productName": "CodePort" }
```

```bash
APP_PATH=src-tauri/target/release/bundle/macos/CodePort.app
APP_BUNDLE_NAME="$(basename "$APP_PATH")"
```

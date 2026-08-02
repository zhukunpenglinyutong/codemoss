## ADDED Requirements

### Requirement: Linux WebKitGTK Startup MUST Avoid Unsafe External Analytics Injection

The renderer MUST prioritize startup availability over external analytics in an affected Linux/WebKitGTK production runtime. Prevention MUST occur before an analytics script, beacon, or equivalent network request is created.

#### Scenario: production starts in affected Linux WebKitGTK runtime

- **WHEN** the production renderer starts inside the supported Linux Tauri/WebKitGTK runtime
- **THEN** Baidu analytics script injection MUST be skipped before the unique site id is submitted to `hm.baidu.com`
- **AND** startup MUST NOT initialize an analytics request that can reach `WebKitNetworkProcess` or libsoup.

#### Scenario: development or secondary window starts

- **WHEN** the renderer is not a production build or the current window is not the main window
- **THEN** the existing no-injection behavior MUST remain
- **AND** the Linux guard MUST NOT create a parallel analytics path.

#### Scenario: unaffected production platform starts

- **WHEN** the production main window runs outside the affected Linux/WebKitGTK runtime
- **THEN** the existing analytics behavior MAY remain enabled
- **AND** platform gating MUST NOT require a new backend command or dependency.

#### Scenario: Linux Web Service opens in a regular browser

- **WHEN** the production frontend runs with `window.__MOSSX_WEB_SERVICE__ === true` on Linux
- **THEN** the native WebKitGTK safety guard MUST NOT disable the existing analytics behavior
- **AND** the Web Service browser path MUST remain distinguishable from the native Tauri renderer without a new backend command.

### Requirement: Renderer Startup State Updates MUST Converge

Every startup-time React state/effect owner MUST converge after catalog, settings, workspace, and persisted selection hydration. A logically equivalent derived value MUST NOT publish a new state/reference that re-triggers the same owner.

#### Scenario: startup derives a selection or state equal to the current value

- **WHEN** a startup effect/layout effect/store subscriber derives a result semantically equal to its current state
- **THEN** the write MUST be skipped or the previous state reference MUST be retained
- **AND** the same derivation MUST NOT trigger another synchronous update cycle.

#### Scenario: startup hydration changes a value once

- **WHEN** persisted or runtime facts require one real state correction
- **THEN** the owner MUST publish the corrected value once
- **AND** the next render with the same facts MUST be a no-op
- **AND** the main renderer MUST NOT enter React `Maximum update depth exceeded` or `react/error-boundary`.

#### Scenario: regression coverage exercises the real update seam

- **WHEN** startup convergence logic is changed
- **THEN** regression coverage MUST mount or otherwise exercise the actual producer/consumer update exchange that previously looped
- **AND** a pure helper test alone MUST NOT be treated as proof if it cannot reproduce the feedback chain.

### Requirement: Linux Production Startup Verification MUST Prove A Visible Stable Renderer

Release verification MUST test both the direct Tauri ELF and AppImage with the production custom protocol, and MUST distinguish a usable renderer from a live but blank or ErrorBoundary-only process.

#### Scenario: direct release ELF starts

- **WHEN** the Linux release ELF is built with `custom-protocol` and launched
- **THEN** it MUST remain running with a visible usable content area for at least 120 seconds
- **AND** diagnostics MUST contain `bootstrap/render-committed` and `bootstrap/renderer-ready-marked`
- **AND** diagnostics MUST NOT contain `react/error-boundary` for that launch.

#### Scenario: AppImage or desktop-entry-equivalent path starts

- **WHEN** the worktree AppImage is launched directly or through a desktop-entry-equivalent environment
- **THEN** it MUST satisfy the same 120-second renderer-ready and visible-content evidence
- **AND** verification MUST NOT overwrite the user's existing launcher or main-worktree AppImage.

#### Scenario: startup completes without a native network-process crash

- **WHEN** either production artifact reaches renderer-ready
- **THEN** no new kernel, journal, coredump, or apport event after that launch timestamp MAY report `WebKitNetworkProcess` or libsoup crash
- **AND** screenshot, window geometry, and pixel-distribution evidence MUST rule out white, black, transparent, or ErrorBoundary-only content.

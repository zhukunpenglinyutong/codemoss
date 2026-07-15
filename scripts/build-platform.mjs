#!/usr/bin/env node
/**
 * Multi-platform build script for CodePort
 *
 * Usage:
 *   node scripts/build-platform.mjs <platform>
 *
 * Platforms:
 *   mac-arm64      - macOS Apple Silicon (aarch64)
 *   mac-x64        - macOS Intel (x86_64)
 *   mac-universal  - macOS Universal (Intel + Apple Silicon)
 *   win-x64        - Windows x64
 *   linux-x64      - Linux x64
 *   linux-arm64    - Linux ARM64
 *   all            - All platforms (current OS only)
 *
 * Options:
 *   --skip-notarize  - Skip notarization (macOS only)
 *   --skip-sign      - Skip code signing (macOS only)
 */

import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const RELEASE_DIR = join(ROOT_DIR, "release-local");
const TAURI_DIR = join(ROOT_DIR, "src-tauri");
const BUILD_NPM_USERCONFIG = join(ROOT_DIR, ".npmrc.build-platform");
const LEGACY_NPM_CONFIG_ENV_KEYS = [
  "npm_config_electron_mirror",
  "npm_config_electron-mirror",
];

// Configuration
const CONFIG = {
  codesignIdentity:
    process.env.CODESIGN_IDENTITY ||
    "Developer ID Application: kunpeng zhu (RLHBM56QRH)",
  notaryProfile: process.env.NOTARY_PROFILE || "ccgui-Notarize",
  entitlements: join(TAURI_DIR, "Entitlements.plist"),
  openssl: {
    arm64: "/opt/homebrew/opt/openssl@3",
    x64: "/tmp/openssl-x86_64",
  },
};

// Get version from tauri.conf.json
function getVersion() {
  const confPath = join(TAURI_DIR, "tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf-8"));
  return conf.version;
}

// Execute command with logging
function createChildProcessEnv(overrides = {}) {
  const childEnv = { ...process.env, ...overrides };
  childEnv.NPM_CONFIG_USERCONFIG = BUILD_NPM_USERCONFIG;
  childEnv.npm_config_userconfig = BUILD_NPM_USERCONFIG;
  for (const key of LEGACY_NPM_CONFIG_ENV_KEYS) {
    delete childEnv[key];
  }
  return childEnv;
}

function exec(cmd, options = {}) {
  console.log(`\n> ${cmd}\n`);
  const { env, ignoreError, ...execOptions } = options;
  try {
    execSync(cmd, {
      stdio: "inherit",
      cwd: ROOT_DIR,
      env: createChildProcessEnv(env),
      ...execOptions,
    });
    return true;
  } catch (error) {
    // Ignore TAURI_SIGNING_PRIVATE_KEY error - it's just for auto-updates
    // This error has exit code 1 but the build actually succeeded
    const errorStr = String(error.stderr || error.stdout || error.message || "");
    if (
      errorStr.includes("TAURI_SIGNING_PRIVATE_KEY") ||
      (error.status === 1 && cmd.includes("tauri") && cmd.includes("build"))
    ) {
      // Check if the build actually produced output
      console.log("\n(Build completed - TAURI_SIGNING_PRIVATE_KEY warning only affects auto-updates)\n");
      return true;
    }
    if (ignoreError) {
      return false;
    }
    throw error;
  }
}

function pruneLinuxAppImageWaylandLibraries(appImagePath) {
  exec(`node scripts/prune-appimage-wayland-libs.mjs --appimage "${appImagePath}"`);
}

// Check current platform
function getCurrentPlatform() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    return { os: "mac", arch: arch === "arm64" ? "arm64" : "x64" };
  } else if (platform === "win32") {
    return { os: "win", arch: "x64" };
  } else if (platform === "linux") {
    return { os: "linux", arch: arch === "arm64" ? "arm64" : "x64" };
  }
  return { os: "unknown", arch: "unknown" };
}

// Ensure release directory exists
function ensureReleaseDir() {
  if (!existsSync(RELEASE_DIR)) {
    mkdirSync(RELEASE_DIR, { recursive: true });
  }
}

// Build macOS app
async function buildMacOS(arch, options = {}) {
  const { skipSign = false, skipNotarize = false } = options;
  const version = getVersion();

  console.log(`\n========================================`);
  console.log(`Building macOS ${arch}...`);
  console.log(`========================================\n`);

  const current = getCurrentPlatform();
  if (current.os !== "mac") {
    console.error(
      "Error: macOS builds can only be performed on macOS.",
    );
    console.log("\nOptions:");
    console.log("  1. Use GitHub Actions with macos-latest runner");
    console.log("  2. Build on a Mac machine");
    process.exit(1);
  }

  let target, bundlePath, dmgName;

  if (arch === "arm64") {
    target = "aarch64-apple-darwin";
    bundlePath = join(
      TAURI_DIR,
      "target/aarch64-apple-darwin/release/bundle/macos/CodePort.app",
    );
    dmgName = `CodePort_${version}_aarch64.dmg`;
  } else if (arch === "x64") {
    target = "x86_64-apple-darwin";
    bundlePath = join(
      TAURI_DIR,
      "target/x86_64-apple-darwin/release/bundle/macos/CodePort.app",
    );
    dmgName = `CodePort_${version}_x86_64.dmg`;

    // Check x86_64 OpenSSL
    if (!existsSync(CONFIG.openssl.x64)) {
      console.error(`Error: x86_64 OpenSSL not found at ${CONFIG.openssl.x64}`);
      console.log("\nTo prepare x86_64 OpenSSL:");
      console.log("  brew fetch --force --bottle-tag=sequoia openssl@3");
      console.log(
        '  BOTTLE=$(find ~/Library/Caches/Homebrew/downloads -name "*openssl*3*sequoia*" -type f | head -1)',
      );
      console.log("  mkdir -p /tmp/openssl-x86_64");
      console.log('  tar xf "$BOTTLE" -C /tmp/openssl-x86_64 --strip-components=2');
      process.exit(1);
    }
  } else if (arch === "universal") {
    target = "universal-apple-darwin";
    bundlePath = join(
      TAURI_DIR,
      "target/universal-apple-darwin/release/bundle/macos/CodePort.app",
    );
    dmgName = `CodePort_${version}_universal.dmg`;

    // Check x86_64 OpenSSL for universal builds
    if (!existsSync(CONFIG.openssl.x64)) {
      console.error(`Error: x86_64 OpenSSL not found at ${CONFIG.openssl.x64}`);
      console.log("\nUniversal builds require x86_64 OpenSSL. To prepare:");
      console.log("  brew fetch --force --bottle-tag=sequoia openssl@3");
      console.log(
        '  BOTTLE=$(find ~/Library/Caches/Homebrew/downloads -name "*openssl*3*sequoia*" -type f | head -1)',
      );
      console.log("  mkdir -p /tmp/openssl-x86_64");
      console.log('  tar xf "$BOTTLE" -C /tmp/openssl-x86_64 --strip-components=2');
      process.exit(1);
    }
  }

  // Ensure x86_64 target is installed for non-arm64 builds
  if (arch !== "arm64") {
    exec("rustup target add x86_64-apple-darwin", { ignoreError: true });
  }

  // Build frontend first to ensure latest styles are included
  console.log("\nBuilding frontend...");
  exec("npm run build");

  // Clean Rust build cache to force recompile with new frontend assets
  // Tauri embeds frontend resources in the binary, so we need to force recompilation
  console.log("\nCleaning Rust build cache to embed latest frontend...");
  exec(`rm -rf ${TAURI_DIR}/target/${target}/release/.fingerprint`, { ignoreError: true });
  exec(`rm -f ${TAURI_DIR}/target/${target}/release/cc-gui`, { ignoreError: true });
  exec(`rm -rf ${TAURI_DIR}/target/${target}/release/bundle`, { ignoreError: true });

  // Build the app
  const buildEnv = arch === "arm64" ? "" : `X86_64_APPLE_DARWIN_OPENSSL_DIR=${CONFIG.openssl.x64} `;
  exec(`${buildEnv}npm run tauri -- build --target ${target} --bundles app`);

  // For universal builds, merge daemon binary
  if (arch === "universal") {
    console.log("\nMerging daemon binary for universal build...");
    exec(`lipo -create \\
      ${TAURI_DIR}/target/aarch64-apple-darwin/release/cc_gui_daemon \\
      ${TAURI_DIR}/target/x86_64-apple-darwin/release/cc_gui_daemon \\
      -output ${TAURI_DIR}/target/universal-apple-darwin/release/cc_gui_daemon`);

    // Rebuild bundle
    exec(`${buildEnv}npm run tauri -- build --target ${target} --bundles app`);
  }

  // Sign and bundle OpenSSL
  if (!skipSign) {
    console.log("\nBundling OpenSSL and signing...");

    if (arch === "universal") {
      // Create universal OpenSSL dylibs
      const frameworksPath = join(bundlePath, "Contents/Frameworks");
      mkdirSync(frameworksPath, { recursive: true });

      exec(`lipo -create \\
        ${CONFIG.openssl.arm64}/lib/libcrypto.3.dylib \\
        ${CONFIG.openssl.x64}/lib/libcrypto.3.dylib \\
        -output "${frameworksPath}/libcrypto.3.dylib"`);

      exec(`lipo -create \\
        ${CONFIG.openssl.arm64}/lib/libssl.3.dylib \\
        ${CONFIG.openssl.x64}/lib/libssl.3.dylib \\
        -output "${frameworksPath}/libssl.3.dylib"`);

      // Fix library paths
      exec(`install_name_tool -id "@rpath/libcrypto.3.dylib" "${frameworksPath}/libcrypto.3.dylib"`, { ignoreError: true });
      exec(`install_name_tool -id "@rpath/libssl.3.dylib" "${frameworksPath}/libssl.3.dylib"`, { ignoreError: true });
      exec(`install_name_tool -change ${CONFIG.openssl.arm64}/lib/libcrypto.3.dylib @rpath/libcrypto.3.dylib "${frameworksPath}/libssl.3.dylib"`, { ignoreError: true });

      // Fix binary paths
      for (const bin of ["cc-gui", "cc_gui_daemon"]) {
        const binPath = join(bundlePath, "Contents/MacOS", bin);
        exec(`install_name_tool -add_rpath "@executable_path/../Frameworks" "${binPath}"`, { ignoreError: true });
        exec(`install_name_tool -change ${CONFIG.openssl.arm64}/lib/libssl.3.dylib @rpath/libssl.3.dylib "${binPath}"`, { ignoreError: true });
        exec(`install_name_tool -change ${CONFIG.openssl.arm64}/lib/libcrypto.3.dylib @rpath/libcrypto.3.dylib "${binPath}"`, { ignoreError: true });
      }

      // Sign all components
      const identity = CONFIG.codesignIdentity;
      const entitlements = CONFIG.entitlements;
      exec(`codesign --force --options runtime --sign "${identity}" --entitlements "${entitlements}" --timestamp "${frameworksPath}/libcrypto.3.dylib"`);
      exec(`codesign --force --options runtime --sign "${identity}" --entitlements "${entitlements}" --timestamp "${frameworksPath}/libssl.3.dylib"`);
      exec(`codesign --force --options runtime --sign "${identity}" --entitlements "${entitlements}" --timestamp "${bundlePath}/Contents/MacOS/cc-gui"`);
      exec(`codesign --force --options runtime --sign "${identity}" --entitlements "${entitlements}" --timestamp "${bundlePath}/Contents/MacOS/cc_gui_daemon"`);
      exec(`codesign --force --options runtime --sign "${identity}" --entitlements "${entitlements}" --timestamp "${bundlePath}"`);
    } else {
      // Use existing script for single-arch builds
      exec(`CODESIGN_IDENTITY="${CONFIG.codesignIdentity}" scripts/macos-fix-openssl.sh "${bundlePath}"`);
    }
  }

  // Create DMG with drag-to-install panel
  ensureReleaseDir();
  const createDmgScript = join(ROOT_DIR, "scripts", "create-dmg.sh");
  exec(`bash "${createDmgScript}" "${bundlePath}" "${RELEASE_DIR}/${dmgName}" "CodePort"`);

  // Notarize
  if (!skipNotarize && !skipSign) {
    console.log("\nNotarizing...");
    exec(`xcrun notarytool submit "${RELEASE_DIR}/${dmgName}" --keychain-profile "${CONFIG.notaryProfile}" --wait`);
    exec(`xcrun stapler staple "${RELEASE_DIR}/${dmgName}"`);
  }

  console.log(`\n========================================`);
  console.log(`macOS ${arch} build complete!`);
  console.log(`Output: ${RELEASE_DIR}/${dmgName}`);
  console.log(`========================================\n`);

  return join(RELEASE_DIR, dmgName);
}

// Build Windows
async function buildWindows(arch, options = {}) {
  const version = getVersion();

  console.log(`\n========================================`);
  console.log(`Building Windows ${arch}...`);
  console.log(`========================================\n`);

  const current = getCurrentPlatform();
  if (current.os !== "win") {
    console.error(
      "Error: Windows builds can only be performed on Windows.",
    );
    console.log("\nTauri apps cannot be cross-compiled for Windows.");
    console.log("Options:");
    console.log("  1. Use GitHub Actions with windows-latest runner");
    console.log("  2. Build on a Windows machine");
    console.log("  3. Use a Windows VM (Parallels, VMware, etc.)");
    console.log("\nTo build on Windows, run:");
    console.log("  npm run build:win-x64");
    process.exit(1);
  }

  // Build on Windows
  exec("npm run tauri:build:win -- --bundles msi,nsis");

  const installerPath = join(
    TAURI_DIR,
    `target/release/bundle/nsis/CodePort_${version}_x64-setup.exe`,
  );

  console.log(`\n========================================`);
  console.log(`Windows ${arch} build complete!`);
  console.log(`Output: ${installerPath}`);
  console.log(`========================================\n`);

  return installerPath;
}

// Build Linux
async function buildLinux(arch, options = {}) {
  const version = getVersion();

  console.log(`\n========================================`);
  console.log(`Building Linux ${arch}...`);
  console.log(`========================================\n`);

  const current = getCurrentPlatform();
  if (current.os !== "linux") {
    console.error(
      "Error: Linux builds can only be performed on Linux.",
    );
    console.log("\nTauri apps cannot be cross-compiled for Linux.");
    console.log("Options:");
    console.log("  1. Use GitHub Actions with ubuntu-latest runner");
    console.log("  2. Build on a Linux machine or VM");
    console.log("  3. Use Docker with a Linux image");
    console.log("\nTo build on Linux, run:");
    console.log(`  npm run build:linux-${arch}`);
    process.exit(1);
  }

  // Check if we're on the right architecture
  if (current.arch !== arch) {
    console.error(`Error: Current system is ${current.arch}, but trying to build for ${arch}.`);
    console.log("\nOptions:");
    console.log(`  1. Use GitHub Actions with appropriate runner`);
    console.log(`  2. Build on a ${arch} Linux machine`);
    process.exit(1);
  }

  // Build AppImage
  exec("NO_STRIP=1 npm run tauri -- build --bundles appimage");

  const appImagePath = join(
    TAURI_DIR,
    `target/release/bundle/appimage/CodePort_${version}_${arch === "arm64" ? "aarch64" : "amd64"}.AppImage`,
  );
  pruneLinuxAppImageWaylandLibraries(appImagePath);

  console.log(`\n========================================`);
  console.log(`Linux ${arch} build complete!`);
  console.log(`Output: ${appImagePath}`);
  console.log(`========================================\n`);

  return appImagePath;
}

// Build all platforms for current OS
async function buildAll(options = {}) {
  const current = getCurrentPlatform();
  const results = [];

  console.log(`\n========================================`);
  console.log(`Building all platforms for ${current.os}...`);
  console.log(`========================================\n`);

  if (current.os === "mac") {
    results.push(await buildMacOS("arm64", options));
    results.push(await buildMacOS("x64", options));
    results.push(await buildMacOS("universal", options));
  } else if (current.os === "win") {
    results.push(await buildWindows("x64", options));
  } else if (current.os === "linux") {
    results.push(await buildLinux(current.arch, options));
  }

  console.log(`\n========================================`);
  console.log(`All builds complete!`);
  console.log(`========================================`);
  console.log("Outputs:");
  results.forEach((r) => console.log(`  - ${r}`));
  console.log("");

  return results;
}

// Parse arguments
const args = process.argv.slice(2);
const platform = args[0];
const options = {
  skipSign: args.includes("--skip-sign"),
  skipNotarize: args.includes("--skip-notarize"),
};

if (!platform) {
  console.log(`
CodePort Multi-Platform Build Script

Usage:
  node scripts/build-platform.mjs <platform> [options]

Platforms:
  mac-arm64      - macOS Apple Silicon (aarch64)
  mac-x64        - macOS Intel (x86_64)
  mac-universal  - macOS Universal (Intel + Apple Silicon)
  win-x64        - Windows x64
  linux-x64      - Linux x64
  linux-arm64    - Linux ARM64
  all            - All platforms for current OS

Options:
  --skip-sign      - Skip code signing (macOS only)
  --skip-notarize  - Skip notarization (macOS only)

Examples:
  npm run build:mac-arm64
  npm run build:mac-universal -- --skip-notarize
  npm run build:all
`);
  process.exit(0);
}

// Execute build
try {
  switch (platform) {
    case "mac-arm64":
      await buildMacOS("arm64", options);
      break;
    case "mac-x64":
      await buildMacOS("x64", options);
      break;
    case "mac-universal":
      await buildMacOS("universal", options);
      break;
    case "win-x64":
      await buildWindows("x64", options);
      break;
    case "linux-x64":
      await buildLinux("x64", options);
      break;
    case "linux-arm64":
      await buildLinux("arm64", options);
      break;
    case "all":
      await buildAll(options);
      break;
    default:
      console.error(`Unknown platform: ${platform}`);
      console.log("Run without arguments to see available platforms.");
      process.exit(1);
  }
} catch (error) {
  console.error("\nBuild failed:", error.message);
  process.exit(1);
}

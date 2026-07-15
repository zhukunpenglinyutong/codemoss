#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function assertWindowsHost(platform = process.platform) {
  if (platform !== "win32") {
    throw new Error(
      "Windows portable builds can only be produced on Windows. Use the Windows Portable GitHub Actions workflow.",
    );
  }
}

function npmInvocation(platform = process.platform) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return { command: process.execPath, argsPrefix: [npmExecPath] };
  }
  if (platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      argsPrefix: ["/d", "/c", "npm"],
    };
  }
  return { command: "npm", argsPrefix: [] };
}

function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}

function runCommand(command, args, options = {}) {
  console.log(`\n> ${formatCommand(command, args)}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? DEFAULT_ROOT_DIR,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

async function readVersion(rootDir) {
  const configPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const version = String(config.version ?? "").trim();
  if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) {
    throw new Error(`Invalid Tauri version in ${configPath}: ${JSON.stringify(config.version)}`);
  }
  return version;
}

function portablePaths(rootDir, version) {
  const artifactBase = `codeport_${version}_windows_x64_portable`;
  const releaseDir = path.join(rootDir, "release-local");
  return {
    artifactName: `codeport-${version}-windows-x64-portable`,
    stagingDir: path.join(releaseDir, artifactBase),
    zipPath: path.join(releaseDir, `${artifactBase}.zip`),
    mainExe: path.join(rootDir, "src-tauri", "target", "release", "cc-gui.exe"),
    daemonExe: path.join(rootDir, "src-tauri", "target", "release", "cc_gui_daemon.exe"),
    distDir: path.join(rootDir, "dist"),
    distIndex: path.join(rootDir, "dist", "index.html"),
    distAssets: path.join(rootDir, "dist", "assets"),
    curatedSkillsDir: path.join(rootDir, "src-tauri", "resources", "curated-skills"),
    skillsLock: path.join(rootDir, "skills-lock.json"),
  };
}

async function requirePath(targetPath, expectedKind, label) {
  let info;
  try {
    info = await stat(targetPath);
  } catch (error) {
    throw new Error(`Required ${label} is missing: ${targetPath}`, { cause: error });
  }

  const valid = expectedKind === "file" ? info.isFile() : info.isDirectory();
  if (!valid) {
    throw new Error(`Required ${label} is not a ${expectedKind}: ${targetPath}`);
  }
}

async function validatePortableInputs(paths) {
  await requirePath(paths.mainExe, "file", "main executable cc-gui.exe");
  await requirePath(paths.daemonExe, "file", "daemon executable cc_gui_daemon.exe");
  await requirePath(paths.distDir, "directory", "frontend dist directory");
  await requirePath(paths.distIndex, "file", "frontend dist/index.html");
  await requirePath(paths.distAssets, "directory", "frontend dist/assets directory");
  await requirePath(paths.curatedSkillsDir, "directory", "curated-skills directory");
  await requirePath(paths.skillsLock, "file", "skills-lock.json");
}

function portableReadme(version) {
  return `CodePort ${version} - Windows x64 Portable Test Build

1. Extract the entire ZIP before running the application.
2. Keep CodePort.exe, cc_gui_daemon.exe, dist, curated-skills, and skills-lock.json together.
3. Start the application by double-clicking CodePort.exe.

Requirements:
- Windows 10 or Windows 11 x64
- Microsoft Edge WebView2 Runtime installed on the system

Notes:
- This is an unsigned test build. Windows SmartScreen may show an Unknown publisher warning.
- Portable means no installer is required. Settings, sessions, and caches still use the normal Windows AppData directories.
- Automatic updater artifacts are not included in this ZIP.
`;
}

async function archivePortableDirectory({ stagingDir, zipPath }) {
  const powershell = `
$ErrorActionPreference = 'Stop'
$source = Join-Path $env:CCGUI_PORTABLE_STAGING '*'
Compress-Archive -Path $source -DestinationPath $env:CCGUI_PORTABLE_ZIP -CompressionLevel Optimal -Force
`;
  runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", powershell],
    {
      env: {
        CCGUI_PORTABLE_STAGING: stagingDir,
        CCGUI_PORTABLE_ZIP: zipPath,
      },
    },
  );
}

async function assembleWindowsPortable({
  rootDir = DEFAULT_ROOT_DIR,
  version,
  archiveRunner = archivePortableDirectory,
} = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedVersion = version ?? (await readVersion(resolvedRoot));
  const paths = portablePaths(resolvedRoot, resolvedVersion);

  await validatePortableInputs(paths);
  await mkdir(path.dirname(paths.stagingDir), { recursive: true });
  await rm(paths.stagingDir, { recursive: true, force: true });
  await rm(paths.zipPath, { force: true });
  await mkdir(paths.stagingDir, { recursive: true });

  await cp(paths.mainExe, path.join(paths.stagingDir, "CodePort.exe"));
  await cp(paths.daemonExe, path.join(paths.stagingDir, "cc_gui_daemon.exe"));
  await cp(paths.distDir, path.join(paths.stagingDir, "dist"), { recursive: true });
  await cp(paths.curatedSkillsDir, path.join(paths.stagingDir, "curated-skills"), {
    recursive: true,
  });
  await cp(paths.skillsLock, path.join(paths.stagingDir, "skills-lock.json"));
  await writeFile(
    path.join(paths.stagingDir, "PORTABLE_README.txt"),
    portableReadme(resolvedVersion),
    "utf8",
  );

  try {
    await archiveRunner({ stagingDir: paths.stagingDir, zipPath: paths.zipPath });
    await requirePath(paths.zipPath, "file", "portable ZIP archive");
  } catch (error) {
    await rm(paths.zipPath, { force: true });
    throw error;
  }

  return {
    artifactName: paths.artifactName,
    stagingDir: paths.stagingDir,
    zipPath: paths.zipPath,
  };
}

async function buildWindowsPortable({
  rootDir = DEFAULT_ROOT_DIR,
  platform = process.platform,
  commandRunner = runCommand,
  archiveRunner = archivePortableDirectory,
} = {}) {
  assertWindowsHost(platform);
  const resolvedRoot = path.resolve(rootDir);
  const npm = npmInvocation(platform);

  commandRunner(
    npm.command,
    [
      ...npm.argsPrefix,
      "run",
      "tauri",
      "--",
      "build",
      "--config",
      "src-tauri/tauri.windows.conf.json",
      "--no-bundle",
      "--ci",
    ],
    { cwd: resolvedRoot },
  );
  commandRunner(
    "cargo",
    [
      "build",
      "--release",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--bin",
      "cc_gui_daemon",
    ],
    { cwd: resolvedRoot },
  );

  return assembleWindowsPortable({ rootDir: resolvedRoot, archiveRunner });
}

async function main() {
  const result = await buildWindowsPortable();
  console.log("\nWindows portable build complete.");
  console.log(`Staging: ${result.stagingDir}`);
  console.log(`Output:  ${result.zipPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[windows-portable] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export {
  assembleWindowsPortable,
  assertWindowsHost,
  buildWindowsPortable,
  portablePaths,
  readVersion,
  validatePortableInputs,
};

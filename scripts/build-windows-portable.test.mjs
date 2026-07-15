import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assembleWindowsPortable,
  assertWindowsHost,
  buildWindowsPortable,
  portablePaths,
} from "./build-windows-portable.mjs";

async function createFixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ccgui-windows-portable-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const paths = portablePaths(rootDir, "1.2.3");
  await mkdir(path.dirname(paths.mainExe), { recursive: true });
  await mkdir(paths.distAssets, { recursive: true });
  await mkdir(path.join(paths.curatedSkillsDir, "sample-skill"), { recursive: true });
  await writeFile(paths.mainExe, "main-executable");
  await writeFile(paths.daemonExe, "daemon-executable");
  await writeFile(path.join(rootDir, "src-tauri", "tauri.conf.json"), '{"version":"1.2.3"}');
  await writeFile(paths.distIndex, '<div id="root"></div><script type="module"></script>');
  await writeFile(path.join(paths.distAssets, "app.js"), "export {};");
  await writeFile(path.join(paths.curatedSkillsDir, "sample-skill", "SKILL.md"), "# Sample");
  await writeFile(paths.skillsLock, '{"version":2,"skills":{}}');

  return { rootDir, paths };
}

async function fakeArchive({ zipPath }) {
  await writeFile(zipPath, "portable-zip");
}

test("assembles the complete portable layout", async (t) => {
  const { rootDir, paths } = await createFixture(t);
  const result = await assembleWindowsPortable({
    rootDir,
    version: "1.2.3",
    archiveRunner: fakeArchive,
  });

  assert.equal(result.artifactName, "codeport-1.2.3-windows-x64-portable");
  for (const relativePath of [
    "CodePort.exe",
    "cc_gui_daemon.exe",
    "dist/index.html",
    "dist/assets/app.js",
    "curated-skills/sample-skill/SKILL.md",
    "skills-lock.json",
    "PORTABLE_README.txt",
  ]) {
    assert.equal(existsSync(path.join(result.stagingDir, relativePath)), true, relativePath);
  }
  assert.equal(existsSync(result.zipPath), true);
  assert.equal(result.zipPath, paths.zipPath);
});

test("fails closed when a required portable source is missing", async (t) => {
  const cases = [
    ["main executable", (paths) => rm(paths.mainExe)],
    ["daemon executable", (paths) => rm(paths.daemonExe)],
    ["dist/index.html", (paths) => rm(paths.distIndex)],
    ["dist/assets", (paths) => rm(paths.distAssets, { recursive: true })],
    ["curated-skills", (paths) => rm(paths.curatedSkillsDir, { recursive: true })],
    ["skills-lock.json", (paths) => rm(paths.skillsLock)],
  ];

  for (const [label, removeSource] of cases) {
    await t.test(label, async (subtest) => {
      const { rootDir, paths } = await createFixture(subtest);
      await removeSource(paths);
      await assert.rejects(
        assembleWindowsPortable({ rootDir, version: "1.2.3", archiveRunner: fakeArchive }),
        new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      );
    });
  }
});

test("replaces stale staging and archive output", async (t) => {
  const { rootDir, paths } = await createFixture(t);
  await mkdir(paths.stagingDir, { recursive: true });
  await writeFile(path.join(paths.stagingDir, "stale.txt"), "stale");
  await mkdir(path.dirname(paths.zipPath), { recursive: true });
  await writeFile(paths.zipPath, "old-zip");

  const result = await assembleWindowsPortable({
    rootDir,
    version: "1.2.3",
    archiveRunner: fakeArchive,
  });

  assert.equal(existsSync(path.join(result.stagingDir, "stale.txt")), false);
  assert.equal(await readFile(result.zipPath, "utf8"), "portable-zip");
});

test("removes partial archive output when compression fails", async (t) => {
  const { rootDir, paths } = await createFixture(t);

  await assert.rejects(
    assembleWindowsPortable({
      rootDir,
      version: "1.2.3",
      archiveRunner: async ({ zipPath }) => {
        await writeFile(zipPath, "partial-zip");
        throw new Error("compression failed");
      },
    }),
    /compression failed/,
  );

  assert.equal(existsSync(paths.zipPath), false);
});

test("orchestrates a no-bundle Tauri build and explicit daemon build", async (t) => {
  const { rootDir } = await createFixture(t);
  const calls = [];

  await buildWindowsPortable({
    rootDir,
    platform: "win32",
    commandRunner: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
    },
    archiveRunner: fakeArchive,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(-8), [
    "run",
    "tauri",
    "--",
    "build",
    "--config",
    "src-tauri/tauri.windows.conf.json",
    "--no-bundle",
    "--ci",
  ]);
  assert.equal(calls[1].command, "cargo");
  assert.deepEqual(calls[1].args, [
    "build",
    "--release",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--bin",
    "cc_gui_daemon",
  ]);
  assert.equal(calls[0].cwd, rootDir);
  assert.equal(calls[1].cwd, rootDir);
});

test("rejects non-Windows hosts before building", async () => {
  let commandCalls = 0;
  assert.throws(() => assertWindowsHost("darwin"), /only be produced on Windows/i);
  assert.doesNotThrow(() => assertWindowsHost("win32"));
  await assert.rejects(
    buildWindowsPortable({
      platform: "darwin",
      commandRunner: () => {
        commandCalls += 1;
      },
    }),
    /only be produced on Windows/i,
  );
  assert.equal(commandCalls, 0);
});

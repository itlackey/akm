// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { releaseRefusal } from "./release-guard.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// `--dist` also builds the installers and update metadata. `--release` is `--dist` for distribution: it refuses
// unless the tree is clean and the engine is the released tarball (release-guard.mjs).
const release = process.argv.includes("--release");
const dist = release || process.argv.includes("--dist");
const stage = await mkdtemp(path.join(os.tmpdir(), "akm-desktop-package-"));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const core = JSON.parse(await readFile(path.join(root, ".core.json"), "utf8").catch(() => "null"));
// Desktop has no version of its own: it is the akm version it embeds, which a stage release stamps (`-beta`).
const version = JSON.parse(await readFile(path.join(root, ".core/package.json"), "utf8")).version;
const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
if (release) {
  const refusal = releaseRefusal({ dirty, core });
  if (refusal) throw new Error(refusal);
}
// Install the same locally packed core and frozen production dependency graph.
await cp(path.join(root, "build"), path.join(stage, "build"), { recursive: true });
await cp(path.join(root, "electron"), path.join(stage, "electron"), { recursive: true });
await cp(path.join(root, "resources"), path.join(stage, "resources"), { recursive: true });
await writeFile(path.join(stage, "package.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
await cp(path.join(root, "bun.lock"), path.join(stage, "bun.lock"));
await writeFile(
  path.join(stage, "build-info.json"),
  `${JSON.stringify({ commit: commit + (dirty ? "-dirty" : "") })}\n`,
);
await cp(path.join(root, ".core"), path.join(stage, ".core"), { recursive: true });
await cp(path.join(root, "THIRD_PARTY.md"), path.join(stage, "THIRD_PARTY.md"));
await cp(path.join(root, "../LICENSE"), path.join(stage, "LICENSE"));
execFileSync("bun", ["install", "--frozen-lockfile", "--production", "--ignore-scripts"], {
  cwd: stage,
  stdio: "inherit",
});
await mkdir(path.join(root, "out"), { recursive: true });
const output = await packager({
  dir: stage,
  name: "AKM Desktop",
  executableName: "akm-desktop",
  out: path.join(root, "out", new Date().toISOString().replaceAll(":", "-")),
  platform: /** @type {import("@electron/packager").OfficialPlatform} */ (process.platform),
  arch: /** @type {import("@electron/packager").OfficialArch} */ (process.arch),
  electronVersion: manifest.devDependencies.electron,
  asar: false,
  prune: false,
  overwrite: false,
  ignore: /^\/\.core(?:\/|$)/,
});
console.log(JSON.stringify({ output, stage }));
if (dist) {
  const { build, Platform, archFromString } = await import("electron-builder");
  const arch = archFromString(process.arch);
  // Installers are unsigned (see docs/software.md): no identity, no secrets. Signing would be `mac.identity`,
  // `win.signtoolOptions` and notarization here, with their credentials from the release job.
  const platforms = {
    linux: { target: Platform.LINUX.createTarget("AppImage", arch) },
    // The zip is what electron-updater downloads on macOS; the dmg is what a person opens.
    darwin: { target: Platform.MAC.createTarget(["dmg", "zip"], arch) },
    win32: { target: Platform.WINDOWS.createTarget("nsis", arch) },
  };
  const platform = platforms[/** @type {keyof typeof platforms} */ (process.platform)];
  if (!platform) throw new Error(`Desktop installers are built for Linux, macOS and Windows, not ${process.platform}.`);
  const installers = path.join(root, "dist");
  await rm(installers, { recursive: true, force: true });
  // Use the normal AppDir entry point, without builder's automatic
  // --no-sandbox fallback. Preserve Electron's existing sandbox policy.
  const launcher = path.join(root, "scripts/AppRun");
  if (process.platform === "linux") {
    await cp(launcher, path.join(output[0], "AppRun"));
    await chmod(path.join(output[0], "AppRun"), 0o755);
  }
  await build({
    projectDir: root,
    prepackaged: output[0],
    targets: platform.target,
    // The release job uploads the files; builder writes the update metadata (latest*.yml) either way.
    publish: "never",
    config: {
      appId: "dev.fwdslsh.akm-desktop",
      productName: "AKM Desktop",
      extraMetadata: { version },
      // electron-builder expands these macros itself.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: builder macros, not a template
      artifactName: "AKM-Desktop-${version}-${arch}.${ext}",
      directories: { output: installers },
      // electron-updater reads the repository from here (resources/app-update.yml) and, per release, the
      // channel file builder writes next to the installers: latest*.yml, or <stage>*.yml for a stage release.
      publish: {
        provider: "github",
        owner: "itlackey",
        repo: "akm",
        channel: version.match(/-([a-z]+)/)?.[1] ?? "latest",
      },
      linux: {
        executableName: "akm-desktop",
        category: "Utility",
        icon: path.join(root, "resources/512x512.png"),
        syncDesktopName: true,
      },
      appImage: { executableArgs: [] },
      mac: {
        category: "public.app-category.productivity",
        icon: path.join(root, "resources/512x512.png"),
        identity: null,
      },
      win: { icon: path.join(root, "resources/512x512.png") },
      toolsets: { appimage: "1.0.3" },
      npmRebuild: false,
    },
  });
  const files = await readdir(installers);
  for (const file of files.filter((name) => /\.(AppImage|dmg|zip|exe)$/.test(name))) {
    const artifact = path.join(installers, file);
    if (file.endsWith(".AppImage")) {
      // Assert the actual archive retains our launcher when builder changes.
      const inspection = await mkdtemp(path.join(os.tmpdir(), "akm-appimage-check-"));
      execFileSync(artifact, ["--appimage-extract", "AppRun"], { cwd: inspection, stdio: "pipe" });
      const extracted = await readFile(path.join(inspection, "squashfs-root/AppRun"));
      await rm(inspection, { recursive: true, force: true });
      if (!extracted.equals(await readFile(launcher))) {
        throw new Error("The AppImage changed its sandbox-preserving launcher. Do not distribute it.");
      }
    }
    const sha256 = createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex");
    await writeFile(`${artifact}.sha256`, `${sha256}  ${file}\n`);
    console.log(`${file}\nSHA256: ${sha256}`);
  }
}

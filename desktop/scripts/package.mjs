import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { releaseRefusal } from "./release-guard.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const appimage = process.argv.includes("--appimage");
if (appimage && (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))) {
  throw new Error("Build AppImages on Linux x64 or arm64.");
}
const stage = await mkdtemp(path.join(os.tmpdir(), "akm-desktop-package-"));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
// Desktop has no version of its own: it is the akm version it embeds.
const version = JSON.parse(await readFile(path.join(root, "../package.json"), "utf8")).version;
const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
if (appimage) {
  const refusal = releaseRefusal({
    version,
    dirty,
    tags: execFileSync("git", ["tag", "--points-at", "HEAD"], { cwd: root, encoding: "utf8" }).split("\n"),
  });
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
  platform: process.platform,
  arch: process.arch,
  electronVersion: manifest.devDependencies.electron,
  asar: false,
  prune: false,
  overwrite: false,
  ignore: /^\/\.core(?:\/|$)/,
});
console.log(JSON.stringify({ output, stage }));
if (appimage) {
  const { build, Platform, archFromString } = await import("electron-builder");
  // Use the normal AppDir entry point, without builder's automatic
  // --no-sandbox fallback. Preserve Electron's existing sandbox policy.
  const launcher = path.join(root, "scripts/AppRun");
  await cp(launcher, path.join(output[0], "AppRun"));
  await chmod(path.join(output[0], "AppRun"), 0o755);
  const artifacts = await build({
    projectDir: root,
    prepackaged: output[0],
    targets: Platform.LINUX.createTarget("AppImage", archFromString(process.arch)),
    publish: "never",
    config: {
      appId: "dev.fwdslsh.akm-desktop",
      productName: "AKM Desktop",
      extraMetadata: { version },
      // electron-builder expands these macros itself.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: builder macros, not a template
      artifactName: "AKM-Desktop-${version}-${arch}.${ext}",
      directories: { output: path.dirname(output[0]) },
      linux: {
        executableName: "akm-desktop",
        category: "Utility",
        icon: path.join(root, "resources/512x512.png"),
        syncDesktopName: true,
      },
      appImage: { executableArgs: [] },
      toolsets: { appimage: "1.0.3" },
      npmRebuild: false,
    },
  });
  for (const artifact of artifacts.filter((file) => file.endsWith(".AppImage"))) {
    // Assert the actual archive retains our launcher when builder changes.
    const inspection = await mkdtemp(path.join(os.tmpdir(), "akm-appimage-check-"));
    execFileSync(artifact, ["--appimage-extract", "AppRun"], { cwd: inspection, stdio: "pipe" });
    if (!Buffer.from(await readFile(path.join(inspection, "squashfs-root/AppRun"))).equals(await readFile(launcher))) {
      throw new Error("The AppImage changed its sandbox-preserving launcher. Do not distribute it.");
    }
    const sha256 = createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex");
    await writeFile(`${artifact}.sha256`, `${sha256}  ${path.basename(artifact)}\n`);
    console.log(`AppImage: ${artifact}\nSHA256: ${sha256}`);
  }
}

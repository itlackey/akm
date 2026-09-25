// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Builds a realistic AKM home by driving the OLD (previous-release) launcher
 * through it: a stash with every asset type, a second filesystem bundle, a
 * git bundle (with an in-bundle symlink at the bundle root), a website
 * bundle, an npm bundle, a scheduled/enabled task pair plus one that stays
 * ungranted, and a synced native (fake) crontab.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "./install";
import { runLauncher } from "./install";
import { serveFakeNpmRegistry } from "./npm-fixture-registry";

/** Known, deliberate scope reductions from the brief — surfaced to the caller instead of silently dropped. */
export const HOME_DEVIATIONS: readonly string[] = [
  "A scheduled workflow (step 9's 'if the old release supports a scheduled workflow') was not added: " +
    "wiring a durable workflow run into the rehearsal fixture is out of proportion to what this gate needs to " +
    "prove about task/bundle/scheduler upgrade compatibility, and workflow IR compatibility already has its own " +
    "versioning story (irVersion) tracked separately.",
  "The npm bundle's assigned name is read back from `bundle list` rather than asserted to be the requested " +
    "'npm-bundle': `akm bundle add npm:<pkg> --name <x>` silently ignores `--name` for every registry-backed " +
    "install (npm/github/git-via-registry) — `addRegistryStash` never forwards it to " +
    "`upsertInstalledRegistryEntry`, whose `deriveBundleId` falls back to a slug of the extracted cache " +
    "directory's basename when the registry id itself is not a bare slug (an `npm:` id always fails " +
    "`isBundleSlug` on the colon). This is a real CLI defect independent of the upgrade-rehearsal gate; out of " +
    "this item's `src/`-free scope, so it is flagged rather than fixed here.",
];

export interface UpgradeHomeTaskIds {
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly manual: string;
}

export interface UpgradeHomeBundles {
  readonly stash: "stash";
  readonly secondFs: string;
  readonly git: string;
  readonly website: string;
  readonly npm: string;
}

export interface UpgradeHome {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stashDir: string;
  readonly fakeCrontab: string;
  readonly configPath: string;
  readonly taskIds: UpgradeHomeTaskIds;
  readonly bundles: UpgradeHomeBundles;
  readonly searchTerm: string;
  readonly rememberedTerm: string;
  readonly deviations: readonly string[];
}

/** A single installed scheduled task, with no full-suite bundle/index/search fixture around it. */
export interface LegacyGrantHome {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stashDir: string;
  readonly fakeCrontab: string;
  readonly configPath: string;
  readonly taskId: string;
}

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd ${cwd}) failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function fakeCrontabScript(): string {
  // Same shape as tests/integration/linux-standalone-scheduler.test.ts's fake
  // crontab (`FAKE_CRONTAB`): `-l` reads it back, `-` writes stdin over it.
  return [
    "#!/bin/sh",
    `if [ "\${1:-}" = "-l" ]; then`,
    '  if [ -f "$FAKE_CRONTAB" ]; then cat "$FAKE_CRONTAB"; exit 0; fi',
    '  echo "no crontab for sandbox" >&2',
    "  exit 1",
    "fi",
    `if [ "\${1:-}" = "-" ]; then cp /dev/stdin "$FAKE_CRONTAB"; exit 0; fi`,
    "exit 2",
    "",
  ].join("\n");
}

// Generous per-step budget: a cold CLI invocation competes with the sibling
// npm installs (which themselves can spend minutes in native `node-gyp`
// rebuilds for optional dependencies) and, on a shared/contended host, with
// unrelated processes — this is a one-shot rehearsal, not a latency test.
const HOME_STEP_TIMEOUT_MS = 240_000;

/** Run an old-launcher step; throws with stdout+stderr on a nonzero exit. */
async function runStep(
  label: string,
  launcher: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  const result = await runLauncher(launcher, args, env, HOME_STEP_TIMEOUT_MS);
  if (result.status !== 0) {
    throw new Error(
      `upgrade-rehearsal home step failed: ${label}\nargv: ${args.join(" ")}\nexit: ${result.status}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

export async function buildHome(oldLauncher: string, root: string): Promise<UpgradeHome> {
  const fakeBin = path.join(root, "fake-bin");
  const fakeCrontab = path.join(root, "crontab");
  const home = path.join(root, "home");
  const configHome = path.join(root, "config");
  const dataHome = path.join(root, "data");
  const cacheHome = path.join(root, "cache");
  const stateHome = path.join(root, "state");
  const stashDir = path.join(root, "stash");
  const configPath = path.join(configHome, "akm", "config.json");

  for (const dir of [
    fakeBin,
    home,
    path.join(configHome, "akm"),
    dataHome,
    cacheHome,
    stateHome,
    stashDir,
    path.join(stashDir, "knowledge"),
    path.join(stashDir, "skills"),
    path.join(stashDir, "memories"),
    path.join(stashDir, "tasks"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(path.join(fakeBin, "crontab"), fakeCrontabScript(), { mode: 0o755 });

  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        configVersion: "0.9.0",
        bundles: { stash: { path: stashDir } },
        defaultBundle: "stash",
        semanticSearchMode: "off",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    AKM_BUNDLE_DIR: stashDir,
    FAKE_CRONTAB: fakeCrontab,
    PATH: [fakeBin, process.env.PATH ?? ""].join(path.delimiter),
    NO_COLOR: "1",
    CI: "1",
  };

  // ── 1. Stash content: two knowledge docs, one skill, one memory ──────────
  const searchTerm = "upgrade-rehearsal-widget";
  fs.writeFileSync(
    path.join(stashDir, "knowledge", "widget-calibration.md"),
    `---\ndescription: Widget calibration notes\n---\n\n# Widget calibration\n\nThe ${searchTerm} must be calibrated before use.\n`,
  );
  fs.writeFileSync(
    path.join(stashDir, "knowledge", "widget-maintenance.md"),
    "---\ndescription: Widget maintenance notes\n---\n\n# Widget maintenance\n\nInspect seals monthly.\n",
  );
  fs.mkdirSync(path.join(stashDir, "skills", "upgrade-rehearsal-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(stashDir, "skills", "upgrade-rehearsal-skill", "SKILL.md"),
    "---\ndescription: Upgrade rehearsal stash skill fixture\n---\n\n# Upgrade rehearsal skill\n",
  );
  fs.writeFileSync(
    path.join(stashDir, "memories", "seed-memory.md"),
    "---\ndescription: Seed memory written while building the upgrade rehearsal home\n---\n\n# Seed memory\n\nWritten by the previous release.\n",
  );

  // ── 2. Task sources (v4): three scheduled, one manual ────────────────────
  const taskIds: UpgradeHomeTaskIds = { a: "scheduled-a", b: "scheduled-b", c: "scheduled-c", manual: "manual" };
  const scheduledTask = (name: string, id: string, cron: string) =>
    `version: 4\nname: ${name}\nrun: echo ${id}\nshell: sh\nschedule: "${cron}"\n`;
  fs.writeFileSync(
    path.join(stashDir, "tasks", `${taskIds.a}.yml`),
    scheduledTask("Scheduled A", taskIds.a, "0 4 * * *"),
  );
  fs.writeFileSync(
    path.join(stashDir, "tasks", `${taskIds.b}.yml`),
    scheduledTask("Scheduled B", taskIds.b, "0 5 * * *"),
  );
  fs.writeFileSync(
    path.join(stashDir, "tasks", `${taskIds.c}.yml`),
    scheduledTask("Scheduled C", taskIds.c, "0 6 * * *"),
  );
  fs.writeFileSync(
    path.join(stashDir, "tasks", `${taskIds.manual}.yml`),
    `version: 4\nname: Manual task\nrun: echo ${taskIds.manual}\nshell: sh\n`,
  );

  // ── 7/8 (moved up). Enable a and b, then sync — BEFORE the git bundle's ──
  // in-bundle symlink (step 4 below) exists. The PREVIOUS release predates
  // 45b5693dc/d76af0a7b (this candidate's own fix): its `task sync`
  // unconditionally aborts the whole reconcile the moment ANY enabled
  // bundle's root contains ANY symlink, regardless of whether that bundle
  // owns any task — confirmed empirically (`... is a symbolic source with a
  // physical source identity collision; guarded reads require one no-follow
  // owner.` from `SchedulerSourceCollector`/`guarded-source.ts`). Syncing
  // here, while only the (symlink-free) stash bundle is enabled, still meets
  // every requirement of steps 7-8 (crontab rows for a/b, none for c); the
  // git bundle's symlink is then exercised for the first time by the
  // CANDIDATE's sync in the test file, which is what actually has the fix.
  await runStep("task enable scheduled-a", oldLauncher, ["task", "enable", `stash//tasks/${taskIds.a}`], env);
  await runStep("task enable scheduled-b", oldLauncher, ["task", "enable", `stash//tasks/${taskIds.b}`], env);
  await runStep("task sync", oldLauncher, ["task", "sync"], env);

  // ── 3. A second filesystem bundle ─────────────────────────────────────────
  const secondFsDir = path.join(root, "second-bundle");
  fs.mkdirSync(path.join(secondFsDir, "skills", "second-bundle-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(secondFsDir, "skills", "second-bundle-skill", "SKILL.md"),
    "---\ndescription: Second filesystem bundle fixture skill\n---\n\n# Second bundle skill\n",
  );
  await runStep(
    "bundle add (second filesystem)",
    oldLauncher,
    ["bundle", "add", secondFsDir, "--name", "second-fs"],
    env,
  );

  // ── 4. A git bundle with an in-bundle symlink at the bundle root ─────────
  const gitRepoDir = path.join(root, "git-remote");
  fs.mkdirSync(path.join(gitRepoDir, "skills", "git-bundle-skill"), { recursive: true });
  fs.writeFileSync(path.join(gitRepoDir, "AGENTS.md"), "# Repo notes\n\nFixture repo notes.\n");
  fs.symlinkSync("AGENTS.md", path.join(gitRepoDir, "CLAUDE.md"));
  fs.writeFileSync(
    path.join(gitRepoDir, "skills", "git-bundle-skill", "SKILL.md"),
    "---\ndescription: Git bundle fixture skill\n---\n\n# Git bundle skill\n",
  );
  git(["init", "--initial-branch=main", gitRepoDir], root);
  git(["-C", gitRepoDir, "config", "user.name", "AKM Upgrade Rehearsal"], root);
  git(["-C", gitRepoDir, "config", "user.email", "upgrade-rehearsal@example.test"], root);
  git(["-C", gitRepoDir, "config", "commit.gpgsign", "false"], root);
  git(["-C", gitRepoDir, "add", "-A"], root);
  git(["-C", gitRepoDir, "commit", "-m", "seed"], root);
  await runStep(
    "bundle add (git, in-bundle symlink)",
    oldLauncher,
    ["bundle", "add", gitRepoDir, "--provider", "git", "--name", "git-bundle"],
    env,
  );

  // ── 5. A website bundle served from a local Bun.serve ─────────────────────
  const websitePages: Record<string, string> = {
    "/": '<html><body><h1>Upgrade rehearsal site</h1><a href="/about.html">About</a></body></html>',
    "/about.html": "<html><body><h1>About</h1><p>Static fixture page two.</p></body></html>",
  };
  const websiteServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      const body = websitePages[pathname];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { headers: { "Content-Type": "text/html" } });
    },
  });
  try {
    await runStep(
      "bundle add (website)",
      oldLauncher,
      [
        "bundle",
        "add",
        `http://127.0.0.1:${websiteServer.port}`,
        "--name",
        "site",
        "--allow-insecure-transport",
        "--max-pages",
        "5",
      ],
      env,
    );
  } finally {
    websiteServer.stop(true);
  }

  // ── 6. An npm bundle served from a second local Bun.serve ─────────────────
  // `--name` has no effect here: `akmAdd`'s registry-install path
  // (`addRegistryStash`/`upsertInstalledRegistryEntry`) never forwards
  // `input.name` — the bundle key is `deriveBundleId(registryId, stashRoot,
  // …)`, and `registryId` here is `npm:<pkg>`, which fails `isBundleSlug`
  // (the colon), so it falls back to a slug of the extracted CACHE
  // directory's basename ("extracted"), not the package name. Read back the
  // name `bundle add` actually assigned instead of asserting the one we
  // asked for — flagged as a follow-up (see deviations).
  const npmRegistry = await serveFakeNpmRegistry(root);
  let npmBundleName: string;
  try {
    await runStep(
      "bundle add (npm)",
      oldLauncher,
      ["bundle", "add", `npm:${npmRegistry.packageName}`, "--name", "npm-bundle"],
      { ...env, AKM_NPM_REGISTRY: npmRegistry.url },
    );
    const listed = await runStep("bundle list (resolve npm bundle name)", oldLauncher, ["bundle", "list"], env);
    const sources = (JSON.parse(listed.stdout) as { sources?: { name?: string }[] }).sources ?? [];
    const knownNames = new Set(["stash", "second-fs", "git-bundle", "site"]);
    const discovered = sources.map((source) => source.name).find((name) => name && !knownNames.has(name));
    if (!discovered) throw new Error(`Could not identify the npm bundle's assigned name in: ${listed.stdout}`);
    npmBundleName = discovered;
  } finally {
    npmRegistry.close();
  }

  // ── 9. Index, remember, search, and run the manual task ──────────────────
  await runStep("index", oldLauncher, ["index"], env);
  const rememberedTerm = "upgrade-rehearsal-remembered-fact";
  await runStep(
    "remember",
    oldLauncher,
    ["remember", `A note about the ${rememberedTerm} written by the previous release.`],
    env,
  );
  await runStep("search", oldLauncher, ["search", searchTerm], env);
  await runStep("task run manual", oldLauncher, ["task", "run", `stash//tasks/${taskIds.manual}`], env);
  // akm proposal new needs an engine — skipped per the brief.

  // ── 10. Model a config carried over from 0.9.15, which accepted this key ─
  // (`experimental.workflowEngine`). Written AFTER the last old-launcher
  // step above: the previous release installed for this rehearsal (0.9.16+)
  // already rejects it — its `experimental` schema is `.strict()` with no
  // read shim — so the old launcher must never read config.json again once
  // the key is present. Only the CANDIDATE, which carries the retired-key
  // read shim, is exercised against it (tests 1-3), and `migrate apply`
  // (test 3) is the on-disk removal the read shim's warning points to.
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ ...rawConfig, experimental: { workflowEngine: true } }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return {
    root,
    env,
    stashDir,
    fakeCrontab,
    configPath,
    taskIds,
    bundles: { stash: "stash", secondFs: "second-fs", git: "git-bundle", website: "site", npm: npmBundleName },
    searchTerm,
    rememberedTerm,
    deviations: HOME_DEVIATIONS,
  };
}

/**
 * Builds the minimal home the `"0.9.15"` upgrade origin needs: a single
 * scheduled task, installed by the 0.9.15 launcher's OWN direct activation
 * (`akm task add --schedule ... --command ...`, no `--disabled`) — 0.9.15
 * predates `task enable`/`task disable` and source-bound scheduler grants
 * (0.9.16) entirely, so this installs a real crontab row with NO
 * `scheduler.enabled` config grant at all, the exact 2026-09-24 scenario
 * upgrade-B's carry-forward exists to rescue. Deliberately reduced from
 * {@link buildHome}'s full five-bundle-kind fixture (brief's own allowance:
 * "adapt the home builder per origin ... report any gap as a deviation") --
 * every other bundle kind, index/search/remember, and the retired
 * `experimental.workflowEngine` config-shape fixture are already covered
 * by the `"previous"` origin; this origin exists ONLY to prove the
 * ungranted-row carry-forward against a home the current grant model never
 * touched.
 */
export async function buildLegacyGrantHome(oldLauncher: string, root: string): Promise<LegacyGrantHome> {
  const fakeBin = path.join(root, "fake-bin");
  const fakeCrontab = path.join(root, "crontab");
  const home = path.join(root, "home");
  const configHome = path.join(root, "config");
  const dataHome = path.join(root, "data");
  const cacheHome = path.join(root, "cache");
  const stateHome = path.join(root, "state");
  const stashDir = path.join(root, "stash");
  const configPath = path.join(configHome, "akm", "config.json");

  for (const dir of [fakeBin, home, path.join(configHome, "akm"), dataHome, cacheHome, stateHome, stashDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(path.join(fakeBin, "crontab"), fakeCrontabScript(), { mode: 0o755 });

  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        configVersion: "0.9.0",
        bundles: { stash: { path: stashDir } },
        defaultBundle: "stash",
        semanticSearchMode: "off",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    AKM_BUNDLE_DIR: stashDir,
    FAKE_CRONTAB: fakeCrontab,
    PATH: [fakeBin, process.env.PATH ?? ""].join(path.delimiter),
    NO_COLOR: "1",
    CI: "1",
  };

  const taskId = "legacy-scheduled";
  await runStep(
    "task add (0.9.15 direct activation, no host-local grant)",
    oldLauncher,
    ["task", "add", taskId, "--schedule", "0 4 * * *", "--command", `echo ${taskId}`],
    env,
  );

  return { root, env, stashDir, fakeCrontab, configPath, taskId };
}

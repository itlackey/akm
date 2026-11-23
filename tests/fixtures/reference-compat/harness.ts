// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The reference-compatibility corpus harness, shared by `scripts/record-reference-compat.ts` (which runs it against
 * the pre-refactor tree and writes `expected.json`) and `tests/integration/reference-compat.test.ts` (which runs it
 * against the working tree and compares).
 *
 * It imports nothing from `src/`: both trees are driven only through `bun <tree>/src/cli.ts`, as a user runs them.
 *
 * Each run gets a fresh sandbox (its own HOME, XDG directories, fixture bundle copies, `state.db` rebuilt from
 * `state.sql`, a fake `crontab` holding the scheduler rows) so no run reads or writes anything real. The commands
 * run in order in one sandbox: read-only ones first, then the few that write.
 *
 * NORMALISED (and nothing else) before a result is recorded or compared:
 *   1. the sandbox root, the tree's root and the Bun binary's path and its directory become `<SANDBOX>`, `<TREE>`, `<BUN>` and `<BUNDIR>`;
 *   2. a timestamp (ISO `...T...Z`, or SQLite `YYYY-MM-DD HH:MM:SS`) dated 2026-02-01 or later, i.e. one written by
 *      the run, becomes `<TIME>`, and a bare date (`YYYY-MM-DD`) of 2026-02-01 or later becomes `<DATE>`; the
 *      fixture's own dates are all earlier and are kept;
 *   3. a duration: a number under a key named `*Ms`, `*ms` or `elapsed*`, and `<n>ms` / `<n>s` inside text, becomes
 *      `<DURATION>`;
 *   4. an id the run minted (a UUID other than the fixture's `00000000-...` proposal ids, a `run-<hex>` /
 *      `wf-<hex>` run id) becomes `<ID>`;
 *   5. a task run's temporary script directory (`/tmp/akm-task-script-<random>`) and the timestamp in a task log's file
 *      name become `<TMP>/akm-task-script` and `<TIME>`;
 *   6. the CLI's version (`0.10.<n>`) becomes `<VERSION>`;
 *   7. a frozen workflow plan's `planHash` / `childPlanHash` (a hash of the plan, which holds the sandbox's paths) and
 *      the `"contentHash":"<hex>"` a stored proposal records for content akm stamped with the run's time become
 *      `<HASH>`; the plan itself, step by step, is still compared;
 *   8. a `content` field of a `show` result is replaced by its length and SHA-256, so the file records the content
 *      hash the design asks for instead of whole documents.
 *   9. the path of a file a tracked bundle's case changed is normalised like any other text (a retirement's archive
 *      directory carries its time), and two paths that then agree are told apart by their order (` (2)`).
 * JSON objects are compared as parsed values, so key order is not compared; array order is.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCENARIOS, type Scenario } from "./scenarios";
import { dumpState, seedState } from "./seed-state";

export const FIXTURE_DIR = import.meta.dir;
/** The oldest timestamp the normaliser treats as written by the run; the fixture's own are all earlier. */
const RUN_EPOCH = "2026-02-01";
/** The one warning a config in the retired `bundles.<n>.components` form gets on every command (§0.2 A2). */
const RETIRED_COMPONENTS_WARNING = /uses the retired bundles\.<name>\.components form/;

export interface CorpusCase {
  id: string;
  /** akm arguments, with `{OUT}` replaced by the sandbox's output directory. */
  args: string[];
  stdin?: string;
  /** Environment variables this command runs with besides the sandbox's (`{FIXTURE}` is the sandbox's fixture directory). */
  env?: Record<string, string>;
  /** Files (relative to the sandbox's output directory) the command wrote that the result records. */
  readFiles?: string[];
}

/** A recorded result: what a user of the command sees, after normalisation. */
export interface CorpusResult {
  exit?: number;
  /** stdout: the parsed JSON when it is JSON, else its lines. */
  stdout?: unknown;
  /** stderr's text lines: warnings, deprecation notices. */
  stderr?: string[];
  /** The JSON error object a failing command prints on stderr, parsed. */
  errorJson?: unknown;
  files?: Record<string, string>;
  /** What the command changed in the bundles a scenario tracks (see `Scenario.track`). */
  changes?: Record<string, { written: Record<string, string>; removed: string[] }>;
  /** Rows, files or text a non-command probe read (state tables, the config file, the bundle trees, a scenario's probe). */
  value?: unknown;
}

// ── The commands ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every ref spelling a user writes today, for `akm show`. A spelling that does not resolve today is recorded too. */
export const SHOW_REFS: string[] = [
  // qualified and unqualified, with and without the file suffix
  "knowledge/guide",
  "main//knowledge/guide",
  "knowledge/guide.md",
  "main//knowledge/guide.md",
  "team//knowledge/shared",
  "knowledge/shared",
  "knowledge/shared.md",
  // the retired `<type>:<name>` head, qualified and not
  "knowledge:guide",
  "main//knowledge:guide",
  "skill:deploy",
  "command:release",
  "workflow:ship",
  "task:nightly",
  "script:hello.sh",
  // case variants
  "Knowledge/Guide",
  "knowledge/GUIDE",
  "knowledge/Case-Variant",
  "knowledge/case-variant",
  "knowledge/Case-Variant.md",
  "main//knowledge/CASE-VARIANT",
  // nested
  "knowledge/api/auth",
  "knowledge/api/auth.md",
  // a file outside its type's folder, and the outdated spelling of it
  "reports/quarterly",
  "reports/quarterly.md",
  "knowledge/reports/quarterly",
  "main//knowledge/reports/quarterly",
  // each type, as a folder ref and as the file spelling
  "skills/deploy",
  "skills/deploy/SKILL.md",
  "skills/deploy.md",
  "commands/release",
  "commands/release.md",
  "agents/reviewer",
  "agents/reviewer.md",
  "scripts/hello.sh",
  "scripts/hello",
  "workflows/ship",
  "workflows/ship.md",
  "workflows/inner",
  "team//workflows/release",
  "tasks/nightly",
  "tasks/nightly.yml",
  "team//tasks/team-task",
  "team//tasks/team-task.yml",
  "env/app",
  "env/app.env",
  "main//env/app",
  "env/team",
  "secrets/api-token",
  "memories/deploy-note",
  "memories/deploy-note.md",
  "lessons/retry",
  "lessons/retry.md",
  // `.derived` twins
  "memories/deploy-note.derived",
  "memories/deploy-note.derived.md",
  "main//memories/deploy-note.derived",
  // a concept in two bundles: unqualified takes today's bundle order, qualified takes its bundle
  "knowledge/dup",
  "main//knowledge/dup",
  "team//knowledge/dup",
  // fragments
  "knowledge/guide#intro",
  "knowledge/guide.md#intro",
  "main//knowledge/guide#deploy",
  "knowledge/guide#no-such-section",
  "team//knowledge/shared#shared",
  // the generic-files bundle
  "files//docs/readme.txt",
  "docs/readme.txt",
  "files//scripts/tool.py",
  "scripts/tool.py",
  "files//notes/n",
  "files//notes/n.md",
  "notes/n",
  "files//data/table.json",
  // typed by content today: frontmatter `agent:` / `type:` and `$ARGUMENTS` in a knowledge note
  "knowledge/acts-like-command",
  "knowledge/declares-lesson",
  // files the walk does not reach
  "knowledge/.drafts/draft",
  ".cache/stray",
  "bin/helper.sh",
  // a wiki folder inside an akm bundle
  "wikis/lab/pages/attention",
  "wikis/lab/schema",
  "wikis/lab/raw/snapshot",
  "main//wikis/lab/pages/attention",
  // several spellings of one concept
  "skills/twinned",
  "skills/twinned/SKILL.md",
  "skills/twinned.md",
  "team//tasks/twin",
  "team//tasks/twin.md",
  "team//tasks/twin.yml",
  // tombstoned and missing
  "memories/pruned-note",
  "memories/successor",
  "main//memories/successor",
  // refs that must keep failing the same way
  "knowledge/ghost",
  "nosuch//knowledge/guide",
  "../etc/passwd",
  // bundles of one format each: okf, an llm wiki, a website snapshot, workflows
  "okf//concepts/ada",
  "okf//concepts/plain",
  "wiki//pages/attention",
  "wiki//pages/note",
  "wiki//raw/source",
  "snapshot//example-com/plain",
  "snapshot//example-com/tagged",
  "flows//deploy",
  "flows//doc",
];

/** Every bundle of the fixture, with its directory under `tests/fixtures/reference-compat/`. */
const BUNDLES = ["main", "team", "files", "okf", "wiki", "snapshot", "flows"];

const TASKS: Array<{ ref: string; id: string; bundle: string }> = [
  { ref: "tasks/nightly", id: "nightly", bundle: "main" },
  { ref: "tasks/report", id: "report", bundle: "main" },
  { ref: "tasks/greet", id: "greet", bundle: "main" },
  { ref: "tasks/inline", id: "inline", bundle: "main" },
  { ref: "tasks/shell", id: "shell", bundle: "main" },
  { ref: "team//tasks/team-task", id: "team-task", bundle: "team" },
];

const WORKFLOWS = ["workflows/ship", "main//workflows/ship", "workflows/inner", "team//workflows/release"];

/** Runs of `scripts/printenv.sh` with `--env` and `--secret` refs written the ways users write them. */
const RUN_ENV: Array<{ id: string; args: string[] }> = [
  { id: "env-bare", args: ["--env", "env/app"] },
  { id: "env-file-spelling", args: ["--env", "env/app.env"] },
  { id: "env-qualified", args: ["--env", "main//env/app"] },
  { id: "env-legacy-head", args: ["--env", "env:app"] },
  { id: "env-other-bundle", args: ["--env", "team//env/team"] },
  { id: "env-other-bundle-unqualified", args: ["--env", "env/team"] },
  { id: "secret-bare", args: ["--secret", "secrets/api-token:MYTOK"] },
  { id: "secret-qualified", args: ["--secret", "team//secrets/team-key:TK"] },
  { id: "secret-unqualified-other-bundle", args: ["--secret", "secrets/team-key:TK"] },
  { id: "secret-legacy-head", args: ["--secret", "secret:api-token:MYTOK"] },
  { id: "env-and-secret", args: ["--env", "env/app", "--secret", "team//secrets/team-key:TK"] },
];

const LINT_RULES = ["missing-ref", "stale-path", "invalid-task-yaml", "tracked-secrets", "missing-skill-md"];

export function corpusCases(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  // A search lists its hits up to --limit: a high one, so a change that adds or drops a hit is a difference, not a cut-off.
  const add = (id: string, args: string[], extra: Partial<CorpusCase> = {}) =>
    cases.push({ id, args: args[0] === "search" ? [...args, "--limit", "1000"] : args, ...extra });

  // Before the first index: what answers with no index.db at all.
  for (const ref of [
    "knowledge/guide",
    "main//knowledge/guide",
    "team//knowledge/shared",
    "skills/deploy",
    "tasks/nightly",
  ]) {
    add(`show before index ${ref}`, ["show", ref]);
  }
  add("search before index", ["search", "guide"]);
  add("index-full", ["index", "--full", "--quiet"]);
  add("bundle-list", ["bundle", "list"]);

  for (const ref of SHOW_REFS) add(`show ${ref}`, ["show", ref]);
  add("show outline guide", ["show", "knowledge/guide", "--outline"]);
  add("show guide detail full", ["show", "main//knowledge/guide", "--detail", "full"]);

  for (const q of ["guide", "deploy", "shared", "dup", "readme", "auth", "pruned"]) add(`search ${q}`, ["search", q]);
  add("search all", ["search", ""]);
  add("search type skill", ["search", "deploy", "--type", "skill"]);
  add("search type knowledge", ["search", "", "--type", "knowledge"]);
  add("search type workflow", ["search", "", "--type", "workflow"]);
  add("search type task", ["search", "", "--type", "task"]);
  for (const prefix of [
    "memories/",
    "knowledge/api/",
    "team//",
    "team//knowledge/",
    "main//",
    "files//",
    "reports/",
    "knowledge/reports/",
  ]) {
    add(`search prefix ${prefix}`, ["search", prefix]);
  }
  add("search from team", ["search", "dup", "--from", "team"]);
  add("search from main", ["search", "dup", "--from", "main"]);
  add("search from files", ["search", "", "--from", "files"]);
  for (const bundle of ["okf", "wiki", "snapshot", "flows"])
    add(`search from ${bundle}`, ["search", "", "--from", bundle]);
  add("search type command", ["search", "", "--type", "command"]);
  add("search type wiki-page", ["search", "", "--type", "wiki-page"]);
  add("search wikis prefix", ["search", "wikis/"]);
  add("search twinned", ["search", "twinned"]);
  add("search typing", ["search", "typing"]);
  add("search detail full", ["search", "guide", "--detail", "full"]);

  add("env list", ["env", "list"]);
  add("secret list", ["secret", "list"]);
  for (const ref of [
    "env/app",
    "env/app.env",
    "main//env/app",
    "env:app",
    "team//env/team",
    "env/team",
    "env/missing",
  ]) {
    add(`env export ${ref}`, ["env", "export", ref, "--out", `{OUT}/${ref.replace(/[^a-z0-9]+/gi, "_")}.sh`], {
      readFiles: [`${ref.replace(/[^a-z0-9]+/gi, "_")}.sh`],
    });
    add(`env path ${ref}`, ["env", "path", ref]);
  }
  for (const r of RUN_ENV) add(`run ${r.id}`, ["run", ...r.args, "scripts/printenv.sh"]);
  add("run script", ["run", "scripts/hello.sh"]);
  add("run script qualified", ["run", "main//scripts/hello.sh"]);
  add("run team script", ["run", "team//scripts/greet.sh"]);
  add("run command dry-run", ["run", "commands/release", "--arguments", "v1", "--dry-run"]);
  add("run command qualified dry-run", ["run", "main//commands/release", "--arguments", "v1", "--dry-run"]);

  for (const t of TASKS) {
    add(`doctor explain ${t.ref}`, ["doctor", "explain", t.ref]);
    add(`task explain ${t.id} --bundle ${t.bundle}`, ["task", "explain", t.id, "--bundle", t.bundle]);
  }
  // Tasks whose target is a script or a shell line run for real: `uses:` resolves the same ref the task names.
  add("run task tasks/shell", ["run", "tasks/shell"]);
  add("run task tasks/greet", ["run", "tasks/greet"]);
  add("run task team//tasks/team-task", ["run", "team//tasks/team-task"]);
  add("task history", ["task", "history"]);
  for (const ref of WORKFLOWS) {
    add(`workflow plan ${ref}`, ["workflow", "plan", ref]);
    add(`doctor explain ${ref}`, ["doctor", "explain", ref]);
  }
  add("workflow list", ["workflow", "list"]);

  add("lint", ["lint"]);
  add("lint detail full", ["lint", "--detail", "full"]);
  for (const rule of LINT_RULES) add(`lint rule ${rule}`, ["lint", "--rule", rule]);
  add("lint type workflows", ["lint", "--type", "workflows"]);
  add("lint type tasks", ["lint", "--type", "tasks"]);
  add("lint file guide", ["lint", "{BUNDLE_MAIN}/knowledge/guide.md"]);

  add("proposal list", ["proposal", "list"]);
  add("proposal list pending", ["proposal", "list", "--status", "pending"]);
  add("proposal list accepted", ["proposal", "list", "--status", "accepted"]);
  add("proposal list rejected", ["proposal", "list", "--status", "rejected"]);
  add("proposal list by ref", ["proposal", "list", "--ref", "main//knowledge/guide"]);
  for (let i = 1; i <= 7; i++) {
    const id = `00000000-0000-4000-8000-00000000000${i}`;
    add(`proposal show ${i}`, ["proposal", "show", id]);
  }
  for (const i of [3, 6]) {
    add(`proposal show ${i} --queue team`, [
      "proposal",
      "show",
      `00000000-0000-4000-8000-00000000000${i}`,
      "--queue",
      "team",
    ]);
  }
  add("proposal list --queue team", ["proposal", "list", "--queue", "team"]);
  add("proposal list --queue team pending", ["proposal", "list", "--queue", "team", "--status", "pending"]);
  add("proposal diff 2", ["proposal", "diff", "00000000-0000-4000-8000-000000000002"]);
  add("proposal diff 3 --queue team", ["proposal", "diff", "00000000-0000-4000-8000-000000000003", "--queue", "team"]);
  for (const ref of [
    "main//knowledge/new-note",
    "knowledge/new-note",
    "knowledge/new-note.md",
    "team//knowledge/shared",
  ]) {
    add(`proposal show ${ref}`, ["proposal", "show", ref]);
    add(`proposal diff ${ref}`, ["proposal", "diff", ref]);
  }
  add("proposal list --ref team//knowledge/shared", [
    "proposal",
    "list",
    "--queue",
    "team",
    "--ref",
    "team//knowledge/shared",
  ]);

  add("scheduler sync dry-run", ["doctor", "scheduler", "sync", "--dry-run"]);
  add("task doctor", ["task", "doctor"]);
  add("improve report", ["improve", "report"]);

  // ── commands that write, last ───────────────────────────────────────────────────────────────────────────────────
  add("proposal accept 2", ["proposal", "accept", "00000000-0000-4000-8000-000000000002"]);
  add("proposal revert 4", ["proposal", "revert", "00000000-0000-4000-8000-000000000004"]);
  add("proposal revert 5", ["proposal", "revert", "00000000-0000-4000-8000-000000000005"]);
  add("proposal reject 3", [
    "proposal",
    "reject",
    "00000000-0000-4000-8000-000000000003",
    "--queue",
    "team",
    "--reason",
    "corpus",
  ]);
  add("index incremental", ["index", "--quiet"]);
  add("show after index outdated spelling", ["show", "knowledge/reports/quarterly"]);
  add("search after index", ["search", "guide"]);
  add("scheduler sync dry-run after", ["doctor", "scheduler", "sync", "--dry-run"]);

  return cases;
}

// ── The sandbox ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface Sandbox {
  root: string;
  tree: string;
  fixture: string;
  out: string;
  env: Record<string, string>;
  stateDb: string;
  configFile: string;
  /** The SQL `state.db` was built from, so a scenario can build a sandbox of its own. */
  stateSql: string;
}

function copyDir(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}

function fill(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(values)) out = out.split(`@${key}@`).join(value);
  return out;
}

/** Build a sandbox for `tree` under `root`. `stateSql` is the SQL that recreates `state.db` (see `dumpState`). */
export function buildSandbox(root: string, tree: string, stateSql: string): Sandbox {
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync(root);
  const home = path.join(root, "home");
  const xdg = {
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
  };
  const fixture = path.join(root, "fixture");
  const out = path.join(root, "out");
  const bin = path.join(root, "bin");
  const work = path.join(root, "work");
  for (const dir of [home, fixture, out, bin, work, path.join(xdg.config, "akm"), path.join(xdg.data, "akm")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const bundle of BUNDLES) copyDir(path.join(FIXTURE_DIR, bundle), path.join(fixture, bundle));

  const values: Record<string, string> = {
    FIXTURE: fixture,
    CONFIG: path.join(xdg.config, "akm"),
    DATA: path.join(xdg.data, "akm"),
    CACHE: path.join(xdg.cache, "akm"),
    STATE: path.join(xdg.state, "akm"),
    BUN: process.execPath,
    AKM: path.join(tree, "src", "cli.ts"),
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/local/bin${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };
  const configFile = path.join(xdg.config, "akm", "config.json");
  fs.writeFileSync(configFile, fill(fs.readFileSync(path.join(FIXTURE_DIR, "config.json"), "utf8"), values));

  // A `crontab` whose table is a file in the sandbox, seeded with the rows an older release installed.
  const store = path.join(root, "crontab.txt");
  fs.writeFileSync(store, fill(fs.readFileSync(path.join(FIXTURE_DIR, "crontab.txt"), "utf8"), values));
  fs.writeFileSync(
    path.join(bin, "crontab"),
    `#!/bin/sh\ncase "$1" in -l) [ -f "${store}" ] && cat "${store}" || { echo "no crontab" >&2; exit 1; };; -) cat > "${store}";; esac\n`,
    { mode: 0o755 },
  );

  const stateDb = path.join(xdg.data, "akm", "state.db");
  if (stateSql.length > 0) {
    const db = new Database(stateDb);
    db.exec(fill(stateSql, values));
    db.close();
  }

  const env: Record<string, string> = {
    PATH: values.PATH as string,
    HOME: home,
    XDG_CONFIG_HOME: xdg.config,
    XDG_DATA_HOME: xdg.data,
    XDG_CACHE_HOME: xdg.cache,
    XDG_STATE_HOME: xdg.state,
    TZ: "UTC",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
  return { root, tree, fixture, out, env, stateDb, configFile, stateSql };
}

/** Build the pre-refactor tree's `state.db` in a scratch directory and freeze it, with the corpus rows, as SQL. */
export function recordStateSql(tree: string, scratch: string): string {
  const sandbox = buildSandbox(scratch, tree, "");
  const first = spawn(sandbox, ["proposal", "list"]);
  if (first.exitCode !== 0) throw new Error(`cannot create state.db with ${tree}: ${first.stderr}`);
  const db = new Database(sandbox.stateDb);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  seedState(db);
  const sql = dumpState(db);
  db.close();
  return sql.split(sandbox.fixture).join("@FIXTURE@");
}

// ── Running ─────────────────────────────────────────────────────────────────────────────────────────────────────

function spawn(sandbox: Sandbox, args: string[], stdin?: string, env?: Record<string, string>) {
  const proc = Bun.spawnSync([process.execPath, path.join(sandbox.tree, "src", "cli.ts"), ...args], {
    cwd: path.join(sandbox.root, "work"),
    env: {
      ...sandbox.env,
      ...Object.fromEntries(
        Object.entries(env ?? {}).map(([key, value]) => [key, value.split("{FIXTURE}").join(sandbox.fixture)]),
      ),
    },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    timeout: 120_000,
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function sha(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function normaliser(sandbox: Sandbox, port?: number) {
  const literals: Array<[string, string]> = [
    [sandbox.root, "<SANDBOX>"],
    [sandbox.tree, "<TREE>"],
    [process.execPath, "<BUN>"],
    // The directory the tree's PATH puts first after the sandbox's bin: where Bun is installed differs by machine.
    [path.dirname(process.execPath), "<BUNDIR>"],
    ...(port === undefined ? [] : ([[`127.0.0.1:${port}`, "127.0.0.1:<PORT>"]] as Array<[string, string]>)),
  ];
  const run = new Date(`${RUN_EPOCH}T00:00:00Z`).getTime();
  const isoRe = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;
  const dateRe = /\b\d{4}-\d\d-\d\d\b/g;
  const sqlRe = /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g;
  const later = (stamp: string) => Date.parse(stamp.replace(" ", "T") + (stamp.endsWith("Z") ? "" : "Z")) >= run;
  const uuidRe = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
  const runIdRe = /\b(?:run|wf|wfr)[-_][0-9a-f]{8,}\b/g;
  const durationRe = /(?<![\w.])\d+(?:\.\d+)?(?:ms|s)\b(?!\w)/g;
  const tmpRe = /\/tmp\/akm-task-script-[A-Za-z0-9]+/g;
  const fileStampRe = /\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z/g;
  const storedHashRe = /"contentHash":"[0-9a-f]{64}"/g;
  const versionRe = /\b0\.10\.\d{6}(?:-[0-9a-z.]+)?\b/g;

  const text = (input: string): string => {
    let s = input;
    for (const [from, to] of literals) if (from) s = s.split(from).join(to);
    s = s.replace(isoRe, (m) => (later(m) ? "<TIME>" : m));
    s = s.replace(sqlRe, (m) => (later(m) ? "<TIME>" : m));
    s = s.replace(dateRe, (m) => (m >= RUN_EPOCH ? "<DATE>" : m));
    s = s.replace(uuidRe, (m) => (m.startsWith("00000000-0000-4000-8000-") ? m : "<ID>"));
    s = s.replace(runIdRe, "<ID>");
    s = s.replace(tmpRe, "<TMP>/akm-task-script");
    s = s.replace(fileStampRe, "<TIME>");
    s = s.replace(durationRe, "<DURATION>");
    s = s.replace(storedHashRe, '"contentHash":"<HASH>"');
    s = s.replace(versionRe, "<VERSION>");
    return s;
  };
  const value = (input: unknown, key = ""): unknown => {
    if (typeof input === "string" && /^(?:planHash|childPlanHash)$/.test(key)) return "<HASH>";
    if (typeof input === "string") return text(input);
    if (typeof input === "number" && /(?:Ms|ms|MS)$|^elapsed/.test(key)) return "<DURATION>";
    if (Array.isArray(input)) return input.map((v) => value(v, key));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[text(k)] = value(v, k);
      return out;
    }
    return input;
  };
  return { text, value };
}

const SCAN_LINE = /^\[index:scan\] \[\d+\/\d+\] (?:Rescanning|Skipping) /;

/**
 * `index --verbose` names a bundle's directories in the order the filesystem lists them, in the recorded release as
 * now (ext4 and tmpfs differ): each run of those lines is sorted, so their order is no part of the contract.
 */
export function sortScanRuns(lines: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    out.push(...run.sort());
    run = [];
  };
  for (const line of lines) {
    if (SCAN_LINE.test(line)) run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

/** stderr is warning lines, and, for a failed command, one pretty-printed JSON error object after them. */
function splitStderr(stderr: string): { lines: string[]; json?: unknown } {
  const lines = stderr.split("\n");
  const start = lines.indexOf("{");
  if (start >= 0) {
    try {
      const json = JSON.parse(lines.slice(start).join("\n"));
      return { lines: lines.slice(0, start).filter((l) => l.trim().length > 0), json };
    } catch {
      // not a JSON error: fall through to plain lines
    }
  }
  return { lines: lines.filter((l) => l.trim().length > 0) };
}

function hashContent(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const out = { ...(parsed as Record<string, unknown>) };
  if (typeof out.content === "string") out.content = `${out.content.length} chars ${sha(out.content)}`;
  return out;
}

/** What the run changed in a bundle: the files it wrote (new or different, with their text) and the ones it removed. */
function bundleChanges(dir: string, pristine: string, text: (s: string) => string) {
  const files = (root: string): string[] => {
    const found: string[] = [];
    const walk = (current: string) => {
      for (const entry of fs
        .readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) found.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(root);
    return found;
  };
  const now = files(dir);
  const before = new Set(files(pristine));
  // A path carries the time a retirement was archived (`<TIME>-memories-note/cleanup.md`): it is normalised like any
  // text, and two files whose paths then agree (a memory's archive and its twin's) are told apart by their order.
  const named = (taken: (name: string) => boolean, rel: string): string => {
    const base = text(rel);
    let name = base;
    for (let n = 2; taken(name); n++) name = `${base} (${n})`;
    return name;
  };
  const written: Record<string, string> = {};
  for (const rel of now) {
    const bytes = fs.readFileSync(path.join(dir, rel), "utf8");
    if (!before.has(rel) || fs.readFileSync(path.join(pristine, rel), "utf8") !== bytes)
      written[named((name) => name in written, rel)] = text(bytes);
  }
  const removed: string[] = [];
  for (const rel of [...before].filter((r) => !now.includes(r)))
    removed.push(named((name) => removed.includes(name), rel));
  return { written, removed };
}

/**
 * The state tables read back after the run. `{bundle}` is the column that names a row's bundle: `stash_dir` (a directory)
 * in the tree the corpus was recorded from, `bundle_id` (the bundle's name, §0.2 P8) since migration 031; both are
 * read as `stash_dir`, so the recording and the working tree print the same key and the values are what differs.
 */
const STATE_PROBES: Array<{ id: string; table?: string; sql: string }> = [
  {
    id: "proposals",
    table: "proposals",
    sql: "SELECT id, {bundle} AS stash_dir, ref, status, source, content, frontmatter_json, metadata_json FROM proposals ORDER BY id",
  },
  {
    id: "improve_ledger",
    table: "improve_ledger",
    sql: "SELECT {bundle} AS stash_dir, ref, source, outcome, next_eligible_at, proposal_id, detail FROM improve_ledger ORDER BY {bundle}, ref, source",
  },
  {
    id: "improve_runs",
    table: "improve_runs",
    sql: "SELECT id, {bundle} AS stash_dir, scope_mode, scope_value, ok, result_json FROM improve_runs ORDER BY id",
  },
  {
    id: "asset_salience",
    sql: "SELECT asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score FROM asset_salience ORDER BY asset_ref",
  },
  {
    id: "asset_outcome",
    sql: "SELECT asset_ref, retrieval_count, negative_feedback_count, accepted_change_count FROM asset_outcome ORDER BY asset_ref",
  },
  {
    id: "usage_events (seeded rows)",
    sql: "SELECT event_type, entry_ref, signal FROM usage_events WHERE created_at < '2026-02-01' ORDER BY id",
  },
  { id: "task_history", sql: "SELECT task_id, status, target_kind, target_ref FROM task_history ORDER BY id" },
];

/** A probe's SQL for `db`: the bundle column filled in for the tree that wrote it. */
function probeSql(db: Database, probe: { table?: string; sql: string }): string {
  if (probe.table === undefined) return probe.sql;
  const columns = db.prepare(`SELECT name FROM pragma_table_info('${probe.table}')`).all() as Array<{ name: string }>;
  return probe.sql
    .split("{bundle}")
    .join(columns.some((column) => column.name === "bundle_id") ? "bundle_id" : "stash_dir");
}

/** Run one command of the corpus on `sandbox` and return what a user of it sees, normalised. */
function runCase(sandbox: Sandbox, norm: ReturnType<typeof normaliser>, c: CorpusCase, quietA2 = false): CorpusResult {
  const fill1 = (arg: string) =>
    arg.split("{OUT}").join(sandbox.out).split("{BUNDLE_MAIN}").join(path.join(sandbox.fixture, "main"));
  const res = spawn(sandbox, c.args.map(fill1), c.stdin, c.env);
  const result: CorpusResult = { exit: res.exitCode };
  const trimmed = res.stdout.trim();
  let parsed: unknown;
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    result.stdout =
      parsed !== undefined
        ? norm.value(c.args[0] === "show" ? hashContent(parsed) : parsed)
        : norm.text(trimmed).split("\n");
  }
  const err = splitStderr(res.stderr);
  const lines = quietA2 ? err.lines.filter((l) => !RETIRED_COMPONENTS_WARNING.test(l)) : err.lines;
  if (lines.length > 0) result.stderr = sortScanRuns(lines.map((l) => norm.text(l)));
  if (err.json !== undefined) result.errorJson = norm.value(err.json);
  if (c.readFiles) {
    result.files = {};
    for (const f of c.readFiles) {
      const file = path.join(sandbox.out, f);
      result.files[f] = fs.existsSync(file) ? norm.text(fs.readFileSync(file, "utf8")) : "<not written>";
    }
  }
  // A task run names its log; what the task printed is what shows which asset a `uses:` ref resolved to.
  const log = (parsed as { result?: { log?: unknown } } | undefined)?.result?.log;
  const logFile = typeof log === "string" ? log : undefined;
  if (logFile && fs.existsSync(logFile)) {
    result.files = { ...result.files, "task log": norm.text(fs.readFileSync(logFile, "utf8")) };
  }
  return result;
}

/** Run every case of the corpus on `sandbox`'s tree, in order, and return the normalised results by case id. */
export function runCorpus(sandbox: Sandbox, onCase?: (id: string) => void): Record<string, CorpusResult> {
  const results = runMainCorpus(sandbox, onCase);
  for (const scenario of SCENARIOS) Object.assign(results, runScenario(sandbox, scenario, onCase));
  return results;
}

/** The main corpus: every command of the home, and what the run left behind. The scenarios are run apart. */
export function runMainCorpus(sandbox: Sandbox, onCase?: (id: string) => void): Record<string, CorpusResult> {
  const norm = normaliser(sandbox);
  const results: Record<string, CorpusResult> = {};
  for (const c of corpusCases()) {
    onCase?.(c.id);
    results[c.id] = runCase(sandbox, norm, c);
  }

  // What the run left behind: the config file, the stored rows, the files each bundle gained, changed or lost, the scheduler table.
  results["file config.json"] = { value: norm.value(JSON.parse(fs.readFileSync(sandbox.configFile, "utf8"))) };
  const db = new Database(sandbox.stateDb, { readonly: true });
  for (const probe of STATE_PROBES) {
    results[`state ${probe.id}`] = { value: norm.value(db.prepare(probeSql(db, probe)).all()) };
  }
  db.close();
  for (const bundle of BUNDLES) {
    results[`changes to bundle ${bundle}`] = {
      value: bundleChanges(path.join(sandbox.fixture, bundle), path.join(FIXTURE_DIR, bundle), norm.text),
    };
  }
  const crontab = path.join(sandbox.root, "crontab.txt");
  results["file crontab"] = {
    value: fs.existsSync(crontab) ? norm.text(fs.readFileSync(crontab, "utf8")).split("\n") : "<none>",
  };
  return results;
}

/** A fake OpenAI-compatible embeddings server in a process of its own (the corpus runs commands synchronously). */
function startEmbeddingsServer(dir: string): { port: number; stop: () => void } {
  const portFile = path.join(dir, "embeddings.port");
  const proc = Bun.spawn([process.execPath, path.join(FIXTURE_DIR, "fake-embeddings.ts"), portFile], {
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let waited = 0; !fs.existsSync(portFile) || fs.readFileSync(portFile, "utf8").length === 0; waited += 20) {
    if (waited > 10_000) {
      proc.kill();
      throw new Error("the fake embeddings server did not start");
    }
    Bun.sleepSync(20);
  }
  return { port: Number(fs.readFileSync(portFile, "utf8")), stop: () => proc.kill() };
}

/**
 * Run one scenario in a sandbox of its own, beside the main one, and return its results keyed `<scenario> :: <case>`.
 * A scenario's stderr leaves out the A2 config warning: the main run's every case already shows it, and here it would
 * add a line to each case that has warnings of its own.
 */
export function runScenario(
  main: Sandbox,
  scenario: Scenario,
  onCase?: (id: string) => void,
): Record<string, CorpusResult> {
  const sandbox = buildSandbox(
    path.join(path.dirname(main.root), `scenario-${scenario.id.replace(/\W+/g, "-")}`),
    main.tree,
    main.stateSql,
  );
  const server = scenario.embeddings ? startEmbeddingsServer(sandbox.root) : undefined;
  try {
    if (server) {
      const cfg = JSON.parse(fs.readFileSync(sandbox.configFile, "utf8"));
      cfg.semanticSearchMode = "auto";
      cfg.embedding = {
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        model: "fake",
        dimension: 8,
        provider: "openai",
      };
      fs.writeFileSync(sandbox.configFile, JSON.stringify(cfg, null, 2));
    }
    scenario.setup?.(sandbox);
    for (const args of scenario.prep ?? []) spawn(sandbox, args);
    scenario.afterPrep?.(sandbox);
    const pristine = path.join(sandbox.root, "pristine");
    // What a case changed is measured from the bundles as they stood before it ran.
    const snapshot = () => {
      fs.rmSync(pristine, { recursive: true, force: true });
      for (const bundle of scenario.track ?? [])
        copyDir(path.join(sandbox.fixture, bundle), path.join(pristine, bundle));
    };

    const norm = normaliser(sandbox, server?.port);
    const results: Record<string, CorpusResult> = {};
    for (const c of scenario.cases) {
      const id = `${scenario.id} :: ${c.id}`;
      onCase?.(id);
      snapshot();
      const result = runCase(sandbox, norm, c, true);
      if (scenario.track) {
        result.changes = {};
        for (const bundle of scenario.track) {
          result.changes[bundle] = bundleChanges(
            path.join(sandbox.fixture, bundle),
            path.join(pristine, bundle),
            norm.text,
          );
        }
      }
      if (scenario.after) result.value = norm.value(scenario.after(sandbox));
      results[id] = result;
    }
    for (const [name, read] of Object.entries(scenario.finals ?? {})) {
      results[`${scenario.id} :: ${name}`] = { value: norm.value(read(sandbox)) };
    }
    return results;
  } finally {
    server?.stop();
  }
}

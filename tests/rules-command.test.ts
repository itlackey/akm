/**
 * `akm rules`: the rules that apply here, in full, read from the files of the bundles the selection names; one
 * `rules` usage event per call that never counts as a search or a show.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { getDbPath } from "../src/core/paths";
import { getStateDbPath, openStateDatabase } from "../src/core/state-db";
import { akmIndex } from "../src/indexer/indexer";
import { openDatabase } from "../src/storage/database";
import { runCliCapture } from "./_helpers/cli";
import {
  type Cleanup,
  makeSandboxDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withDefaultBundle,
} from "./_helpers/sandbox";

interface RulesOutput {
  ok: boolean;
  shape: string;
  project?: { name: string; from?: string | string[]; filters?: Record<string, string[]> };
  bundles: string[];
  rules: Array<{ ref: string; description?: string; project?: string | string[]; content: string }>;
}

let stashDir = "";
let cleanup: Cleanup = () => {};
const dirs: Array<{ dir: string; cleanup: Cleanup }> = [];
let acmeDir = "";

function tmp(prefix: string): string {
  const made = makeSandboxDir(prefix);
  dirs.push(made);
  return fs.realpathSync(made.dir);
}

function write(root: string, rel: string, front: Record<string, string>, body: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = Object.entries(front)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  fs.writeFileSync(file, `---\n${fm}\n---\n\n${body}\n`, "utf8");
}

function rule(root: string, name: string, project?: string, extra: Record<string, string> = {}): void {
  write(
    root,
    `rules/${name}.md`,
    { description: `Rules ${name}`, ...(project ? { project } : {}), ...extra },
    `- Follow the ${name} conventions.`,
  );
}

function configure(extra: Record<string, unknown> = {}): void {
  saveConfig(
    withDefaultBundle(
      { semanticSearchMode: "off", projects: { acme: { paths: [acmeDir] }, globex: {} }, ...extra },
      stashDir,
    ) as never,
  );
  resetConfigCache();
}

async function rules(...args: string[]): Promise<RulesOutput> {
  const { code, stdout } = await runCliCapture(["rules", ...args, "--format", "json"]);
  expect(code).toBe(0);
  return JSON.parse(stdout) as RulesOutput;
}
const refs = (result: RulesOutput) => result.rules.map((r) => r.ref);

function usageRows(type: string): Array<{ entry_ref: string | null; metadata: string; source: string }> {
  const db = openDatabase(getStateDbPath(), { readonly: true, create: false });
  try {
    return db.prepare("SELECT entry_ref, metadata, source FROM usage_events WHERE event_type = ?").all(type) as never;
  } finally {
    db.close();
  }
}
function usageTypes(): string[] {
  const db = openDatabase(getStateDbPath(), { readonly: true, create: false });
  try {
    return (db.prepare("SELECT event_type FROM usage_events ORDER BY id").all() as Array<{ event_type: string }>).map(
      (r) => r.event_type,
    );
  } finally {
    db.close();
  }
}

beforeEach(() => {
  const data = sandboxXdgDataHome();
  const cache = sandboxXdgCacheHome(data.cleanup);
  const cfg = sandboxXdgConfigHome(cache.cleanup);
  const stash = sandboxStashDir(cfg.cleanup);
  stashDir = stash.dir;
  cleanup = stash.cleanup;
  acmeDir = tmp("rules-cmd-acme");
  rule(stashDir, "acme/development", "acme");
  rule(stashDir, "globex/development", "globex");
  rule(stashDir, "shared");
  openStateDatabase().close();
});

afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
  cleanup();
});

describe("which rules apply", () => {
  test("the project's rules first, then shared ones, in full; another project's rule is left out", async () => {
    configure();
    const result = await rules("--project", "acme");
    expect(result.ok).toBe(true);
    expect(result.shape).toBe("rules");
    expect(refs(result)).toEqual(["rules/acme/development", "rules/shared"]);
    expect(result.rules[0]).toEqual({
      ref: "rules/acme/development",
      description: "Rules acme/development",
      project: "acme",
      content: "- Follow the acme/development conventions.",
    });
    expect(result.rules[1]?.project).toBeUndefined();
    expect(result.project?.name).toBe("acme");
  });

  test("the working directory selects the project; with none only shared rules apply and no project is reported", async () => {
    configure();
    const original = process.cwd;
    process.cwd = () => acmeDir;
    try {
      expect(refs(await rules())).toEqual(["rules/acme/development", "rules/shared"]);
    } finally {
      process.cwd = original;
    }
    const none = await rules("--project", "none");
    expect(refs(none)).toEqual(["rules/shared"]);
    expect(none.project).toBeUndefined();
  });

  test("an unknown project is a usage error", async () => {
    configure();
    expect((await runCliCapture(["rules", "--project", "nope"])).code).toBe(2);
  });

  test("the ref is the one search prints, so show reads it", async () => {
    configure();
    const [first] = (await rules("--project", "acme")).rules;
    await akmIndex({ stashDir, full: true });
    const shown = await runCliCapture(["show", first?.ref ?? "", "--format", "json"]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout).type).toBe("rule");
  });

  test("proposed rules, README.md, a deeper rules folder and a nested rules folder: only real rules; nested folders count", async () => {
    rule(stashDir, "pending", undefined, { quality: "proposed" });
    rule(stashDir, "team/nested/deep");
    write(stashDir, "rules/README.md", { description: "readme" }, "about rules");
    write(stashDir, "docs/rules/d.md", { description: "docs" }, "docs rule-looking");
    write(stashDir, "knowledge/x/rules/y.md", { description: "knowledge" }, "nested knowledge");
    configure();
    expect(refs(await rules("--project", "none"))).toEqual(["rules/shared", "rules/team/nested/deep"]);
  });

  test("a rule written a second ago applies with no index at all", async () => {
    configure();
    expect(fs.existsSync(getDbPath())).toBe(false);
    rule(stashDir, "fresh");
    expect(refs(await rules("--project", "none"))).toEqual(["rules/fresh", "rules/shared"]);
    expect(fs.existsSync(getDbPath())).toBe(false);
  });
});

describe("filters", () => {
  test("--filter limits the rules; a project's filters apply when the flag is absent", async () => {
    rule(stashDir, "ops", undefined, { team: "ops" });
    rule(stashDir, "web", undefined, { team: "web" });
    configure({ projects: { acme: { paths: [acmeDir], filters: { team: "web" } } } });
    expect(refs(await rules("--project", "acme"))).toEqual(["rules/web"]);
    expect(refs(await rules("--project", "acme", "--filter", "team=ops"))).toEqual(["rules/ops"]);
    expect(refs(await rules("--project", "none", "--filter", "team="))).toEqual(["rules/shared"]);
  });

  test("a project filter on project decides the match by itself", async () => {
    configure({ projects: { acme: { paths: [acmeDir], filters: { project: "globex" } } } });
    expect(refs(await rules("--project", "acme"))).toEqual(["rules/globex/development"]);
  });

  test("a malformed --filter is a usage error", async () => {
    configure();
    expect((await runCliCapture(["rules", "--filter", "oops"])).code).toBe(2);
  });
});

describe("which bundles are read", () => {
  let teamDir = "";
  let otherDir = "";
  let offDir = "";
  beforeEach(() => {
    teamDir = tmp("rules-cmd-team");
    otherDir = tmp("rules-cmd-other");
    offDir = tmp("rules-cmd-off");
    rule(teamDir, "acme/team", "acme");
    rule(teamDir, "team-shared");
    rule(otherDir, "acme/other", "acme");
    rule(otherDir, "other-shared");
    rule(offDir, "off-shared");
  });
  const bundles = (project: Record<string, unknown> = {}) =>
    configure({
      defaultBundle: "main",
      bundles: {
        main: { path: stashDir },
        team: { path: teamDir },
        other: { path: otherDir },
        off: { path: offDir, enabled: false },
      },
      projects: { acme: { paths: [acmeDir], ...project }, globex: {} },
    });

  test("with a project and no from: the default bundle and the write bundle, once each; no other bundle", async () => {
    bundles({ write: { bundle: "team" } });
    const result = await rules("--project", "acme");
    expect(result.bundles).toEqual(["main", "team"]);
    expect(refs(result)).toEqual([
      "rules/acme/development",
      "team//rules/acme/team",
      "rules/shared",
      "team//rules/team-shared",
    ]);
    bundles({ write: { bundle: "main" } });
    expect((await rules("--project", "acme")).bundles).toEqual(["main"]);
  });

  test("with no project: the default bundle only", async () => {
    bundles();
    const result = await rules("--project", "none");
    expect(result.bundles).toEqual(["main"]);
    expect(refs(result)).toEqual(["rules/shared"]);
  });

  test("the project's from, then --from replacing it; a disabled bundle is never read", async () => {
    bundles({ from: ["team", "other"] });
    expect((await rules("--project", "acme")).bundles).toEqual(["team", "other"]);
    const named = await rules("--project", "acme", "--from", "other");
    expect(named.bundles).toEqual(["other"]);
    expect(refs(named)).toEqual(["other//rules/acme/other", "other//rules/other-shared"]);
    const both = await rules("--project", "acme", "--from", "team", "--from", "main");
    expect(both.bundles).toEqual(["team", "main"]);
    const off = await runCliCapture(["rules", "--from", "off"]);
    expect(off.code).toBe(2);
  });

  test("an unknown bundle is a usage error", async () => {
    bundles();
    expect((await runCliCapture(["rules", "--from", "nope"])).code).toBe(2);
  });

  test("--from all and registry are ignored with one warning and the rest of the rule gives the bundles", async () => {
    bundles({ from: "team" });
    const { code, stdout, stderr } = await runCliCapture([
      "rules",
      "--project",
      "acme",
      "--from",
      "all",
      "--format",
      "json",
    ]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as RulesOutput).bundles).toEqual(["team"]);
    expect(stderr).toContain("ignored");
    bundles();
    expect((await rules("--project", "none", "--from", "registry")).bundles).toEqual(["main"]);
  });
});

describe("output", () => {
  test("text and md open with the project line and print each rule under its ref; no rules says so", async () => {
    configure();
    for (const format of ["text", "md"]) {
      const { code, stdout } = await runCliCapture(["rules", "--project", "acme", "--format", format]);
      expect(code).toBe(0);
      expect(stdout).toContain("Project acme");
      expect(stdout).toContain("## rules/acme/development\n\n- Follow the acme/development conventions.");
      expect(stdout).toContain("## rules/shared");
    }
    fs.rmSync(path.join(stashDir, "rules"), { recursive: true });
    const empty = await runCliCapture(["rules", "--project", "none", "--format", "text"]);
    expect(empty.stdout.trim()).toBe("No rules apply here.");
  });
});

describe("usage", () => {
  test("one rules event per call: project, bundles, refs and characters; never a search or a show", async () => {
    configure();
    const result = await rules("--project", "acme");
    expect(usageTypes()).toEqual(["rules"]);
    const [row] = usageRows("rules");
    expect(row?.entry_ref).toBeNull();
    expect(row?.source).toBe("user");
    expect(JSON.parse(row?.metadata ?? "{}")).toEqual({
      project: "acme",
      bundles: result.bundles,
      refs: [`${result.bundles[0]}//rules/acme/development`, `${result.bundles[0]}//rules/shared`],
      chars: result.rules.reduce((sum, r) => sum + r.content.length, 0),
    });
    await rules("--project", "none");
    expect(usageTypes()).toEqual(["rules", "rules"]);
    expect(JSON.parse(usageRows("rules")[1]?.metadata ?? "{}").project).toBeUndefined();
  });

  test("the event source is the one every command resolves", async () => {
    configure();
    process.env.AKM_EVENT_SOURCE = "audit";
    try {
      await rules("--project", "none");
    } finally {
      delete process.env.AKM_EVENT_SOURCE;
    }
    expect(usageRows("rules")[0]?.source).toBe("audit");
  });

  test("a rules load moves no search or show count and no utility score", async () => {
    configure();
    await akmIndex({ stashDir, full: true });
    await rules("--project", "acme");
    await akmIndex({ stashDir, full: true });
    const db = openDatabase(getDbPath(), { readonly: true, create: false });
    try {
      const rows = db.prepare("SELECT show_count, search_count FROM utility_scores").all() as Array<{
        show_count: number;
        search_count: number;
      }>;
      expect(rows.filter((r) => r.show_count > 0 || r.search_count > 0)).toEqual([]);
    } finally {
      db.close();
    }
    expect(usageTypes().filter((type) => type !== "rules")).toEqual([]);
  });
});

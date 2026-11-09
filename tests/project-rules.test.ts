/**
 * Project rules (#1467): `rules/` assets are ordinary search hits that apply to the project they name
 * (and shared ones), another project's rules never appear, and a bundle without `rules/` is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCurate } from "../src/commands/read/curate-run";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { getStateDbPath } from "../src/core/state-db";
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
  withEnv,
} from "./_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};
const dirs: Array<{ dir: string; cleanup: Cleanup }> = [];

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

function rule(root: string, name: string, project: string | undefined): void {
  write(
    root,
    `rules/${name}.md`,
    { description: `Rules ${name}`, ...(project ? { project } : {}) },
    `- Follow the ${name} conventions.`,
  );
}

let acmeDir = "";
let globexDir = "";

async function setup(extra: Record<string, unknown> = {}): Promise<void> {
  saveConfig({
    semanticSearchMode: "off",
    projects: { acme: { paths: [acmeDir] }, globex: { paths: [globexDir] } },
    ...extra,
  } as never);
  resetConfigCache();
  await akmIndex({ stashDir, full: true });
}

beforeEach(() => {
  const data = sandboxXdgDataHome();
  const cache = sandboxXdgCacheHome(data.cleanup);
  const cfg = sandboxXdgConfigHome(cache.cleanup);
  const stash = sandboxStashDir(cfg.cleanup);
  stashDir = stash.dir;
  cleanup = stash.cleanup;
  acmeDir = tmp("rules-acme");
  globexDir = tmp("rules-globex");
  write(stashDir, "knowledge/invoice-export.md", { description: "Invoice export guide" }, "invoice export steps");
  write(stashDir, "knowledge/invoice-tax.md", { description: "Invoice tax guide" }, "invoice export tax steps");
  rule(stashDir, "acme/development", "acme");
  rule(stashDir, "globex/development", "globex");
  rule(stashDir, "shared", undefined);
});

afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
  cleanup();
});

const search = async (...args: string[]) => {
  const { code, stdout } = await runCliCapture(["search", ...args, "--format", "json"]);
  expect(code).toBe(0);
  return JSON.parse(stdout) as { hits: Array<{ ref: string; type: string }>; warnings?: string[] };
};
const refs = (hits: Array<{ ref: string }>) => hits.map((h) => h.ref);

describe("search", () => {
  test("an untyped page holds ordinary hits only: no rule is forced in; a matching query returns only applicable rules", async () => {
    await setup();
    const plain = await search("invoice export", "--project", "acme");
    expect(refs(plain.hits)).toEqual(["knowledge/invoice-export", "knowledge/invoice-tax"]);
    expect(plain.warnings).toBeUndefined();
    const limited = await search("invoice export", "--project", "acme", "--limit", "1");
    expect(refs(limited.hits)).toEqual(["knowledge/invoice-export"]);
    const matching = await search("Rules", "--project", "acme");
    expect(refs(matching.hits).sort()).toEqual(["rules/acme/development", "rules/shared"]);
  });

  test("two projects get their own rules", async () => {
    await setup();
    expect(refs((await search("Rules", "--project", "globex")).hits).sort()).toEqual([
      "rules/globex/development",
      "rules/shared",
    ]);
  });

  test("the working directory selects the same rules as --project", async () => {
    await setup();
    const explicit = await search("Rules", "--project", "acme");
    const original = process.cwd;
    process.cwd = () => acmeDir;
    try {
      expect(refs((await search("Rules")).hits)).toEqual(refs(explicit.hits));
      expect(refs(explicit.hits)).toHaveLength(2);
    } finally {
      process.cwd = original;
    }
  });

  test("with no project only shared rules apply", async () => {
    await setup();
    expect(refs((await search("Rules", "--project", "none")).hits)).toEqual(["rules/shared"]);
  });

  test('search "rules/" lists exactly the applicable rules under the project', async () => {
    await setup();
    expect(refs((await search("rules/", "--project", "acme")).hits)).toEqual([
      "rules/acme/development",
      "rules/shared",
    ]);
    expect(refs((await search("rules/", "--project", "none")).hits)).toEqual(["rules/shared"]);
  });

  test('search "" --type rule lists exactly the applicable rules, with descriptions', async () => {
    write(stashDir, "rules/README.md", { description: "readme" }, "readme");
    await setup();
    const result = await search("", "--type", "rule", "--limit", "200", "--project", "acme", "--detail", "normal");
    expect(refs(result.hits)).toEqual(["rules/acme/development", "rules/shared"]);
    expect((result.hits[0] as { description?: string }).description).toBe("Rules acme/development");
    expect(refs((await search("", "--type", "rule", "--project", "none")).hits)).toEqual(["rules/shared"]);
  });

  test("a query that matches nothing keeps the no-match tip", async () => {
    await setup();
    const result = (await search("zzqxjnomatch", "--project", "acme")) as { hits: unknown[]; tip?: string };
    expect(result.tip).toBeTruthy();
    expect(result.hits).toEqual([]);
  });

  test("a bundle without rules/ is unchanged", async () => {
    fs.rmSync(path.join(stashDir, "rules"), { recursive: true });
    await setup();
    expect(refs((await search("invoice export", "--project", "acme")).hits)).toEqual([
      "knowledge/invoice-export",
      "knowledge/invoice-tax",
    ]);
  });

  test("--from and a disabled bundle keep their rules out", async () => {
    const team = tmp("rules-team");
    const off = tmp("rules-off");
    rule(team, "acme/team", "acme");
    rule(off, "acme/off", "acme");
    await setup({
      bundles: { main: { path: stashDir }, team: { path: team }, off: { path: off, enabled: false } },
    });
    const all = refs((await search("rules/", "--project", "acme")).hits);
    expect(all).toContain("team//rules/acme/team");
    expect(all.some((ref) => ref.includes("acme/off"))).toBe(false);
    expect(refs((await search("rules/", "--project", "acme", "--from", "main")).hits)).toEqual([
      "rules/acme/development",
      "rules/shared",
    ]);
  });
});

describe("curate", () => {
  const run = (args: Record<string, unknown>) =>
    runCurate({ query: "fix invoice export", limit: "10", ...args }, { detail: "normal", shape: "human" });

  test("an untyped page holds limit ordinary hits; a directory and --project agree", async () => {
    await setup();
    const named = await run({ project: "acme", limit: "2" });
    expect(named.items.map((i) => ("ref" in i ? i.ref : ""))).toEqual([
      "knowledge/invoice-export",
      "knowledge/invoice-tax",
    ]);
    const byDir = await run({ cwd: acmeDir, limit: "2" });
    expect(byDir.items.map((i) => ("ref" in i ? i.ref : ""))).toEqual(
      named.items.map((i) => ("ref" in i ? i.ref : "")),
    );
  });

  test("--type rule curates only the applicable rules", async () => {
    await setup();
    const result = await run({ project: "acme", query: "Rules", type: "rule" });
    expect(result.items.map((i) => ("ref" in i ? i.ref : "")).sort()).toEqual([
      "rules/acme/development",
      "rules/shared",
    ]);
  });
});

describe("classification", () => {
  test("only a top-level rules/ folder holds rules; a nested rules folder keeps its type", async () => {
    write(stashDir, "knowledge/x/rules/y.md", { description: "nested knowledge" }, "marker text");
    write(stashDir, "memories/rules/n.md", { description: "memory in rules" }, "marker text");
    write(stashDir, "lessons/rules/l.md", { description: "lesson in rules", when_to_use: "always" }, "marker text");
    write(stashDir, "docs/rules/d.md", { description: "docs rules" }, "marker text");
    await setup();
    const of = async (type: string) => refs((await search("", "--type", type, "--project", "none")).hits);
    expect(await of("knowledge")).toContain("knowledge/x/rules/y");
    expect(await of("knowledge")).toContain("docs/rules/d");
    expect(await of("memory")).toContain("memories/rules/n");
    expect(await of("lesson")).toContain("lessons/rules/l");
    expect(refs((await search("", "--type", "rule", "--project", "none")).hits)).toEqual(["rules/shared"]);
  });
});

describe("the project's own value", () => {
  test("rules match what the project stamps and prefers, not its key", async () => {
    const web = tmp("rules-web2");
    rule(stashDir, "platform/dev", "platform");
    await setup({
      projects: {
        web2: { paths: [web], prefer: { project: "platform" }, write: { metadata: { project: "platform" } } },
      },
    });
    expect(refs((await search("", "--type", "rule", "--project", "web2")).hits)).toEqual([
      "rules/platform/dev",
      "rules/shared",
    ]);
  });

  test("a project filter on project decides eligibility; the comparison is skipped", async () => {
    rule(stashDir, "platform/dev", "platform");
    await setup({ projects: { web: { paths: [tmp("rules-web")], filters: { project: "platform" } } } });
    expect(refs((await search("", "--type", "rule", "--project", "web")).hits)).toEqual(["rules/platform/dev"]);
  });

  test("usage is recorded and compared by the stamped value", async () => {
    write(stashDir, "knowledge/platform-doc.md", { description: "Platform doc", project: "platform" }, "doc");
    await setup({
      projects: { web2: { paths: [tmp("rules-web2u")], write: { metadata: { project: "platform" } } } },
    });
    await runCliCapture(["show", "knowledge/platform-doc", "--project", "web2", "--format", "json"]);
    expect(refs((await search("--by-usage", "--project", "web2")).hits)).toEqual(["knowledge/platform-doc"]);
  });
});

describe("search --by-usage", () => {
  const inDir = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
    const original = process.cwd;
    process.cwd = () => dir;
    try {
      return await fn();
    } finally {
      process.cwd = original;
    }
  };
  const show = (ref: string) => runCliCapture(["show", ref, "--format", "json"]);
  const usage = async (...args: string[]) => refs((await search("--by-usage", ...args)).hits);

  beforeEach(async () => {
    write(stashDir, "knowledge/globex-only.md", { description: "Globex only", project: "globex" }, "globex only");
    await setup();
  });

  test("lists what was shown in the project, most shown first, ties by ref; other projects' shows and assets stay out", async () => {
    await inDir(acmeDir, async () => {
      await show("knowledge/invoice-tax");
      await show("knowledge/invoice-export");
      await show("knowledge/invoice-tax");
    });
    await inDir(globexDir, async () => {
      await show("knowledge/globex-only");
      await show("knowledge/globex-only");
      await show("knowledge/globex-only");
    });
    expect(await usage("--project", "acme")).toEqual(["knowledge/invoice-tax", "knowledge/invoice-export"]);
    expect(await usage("--project", "globex")).toEqual(["knowledge/globex-only"]);
    // Shown in acme, then asset of globex shown in acme: still not eligible for acme.
    await inDir(acmeDir, () => show("knowledge/globex-only"));
    expect(await usage("--project", "acme")).not.toContain("knowledge/globex-only");
  });

  test("the directory and --project agree; no project counts every show, attributed or not", async () => {
    await inDir(acmeDir, () => show("knowledge/invoice-tax"));
    await show("knowledge/invoice-export");
    expect(await inDir(acmeDir, () => usage())).toEqual(await usage("--project", "acme"));
    expect(await usage("--project", "acme")).toEqual(["knowledge/invoice-tax"]);
    expect(await usage("--project", "none")).toEqual(["knowledge/invoice-export", "knowledge/invoice-tax"]);
  });

  test("machine reads, rules and unshown assets are not counted; --limit and --type apply", async () => {
    await withEnv({ AKM_EVENT_SOURCE: "unknown" }, () => inDir(acmeDir, () => show("knowledge/invoice-tax")));
    expect(await usage("--project", "acme")).toEqual([]);
    await inDir(acmeDir, async () => {
      await show("rules/acme/development");
      await show("knowledge/invoice-tax");
      await show("knowledge/invoice-export");
    });
    expect(await usage("--project", "acme")).toEqual(["knowledge/invoice-export", "knowledge/invoice-tax"]);
    expect(await usage("--project", "acme", "--limit", "1")).toEqual(["knowledge/invoice-export"]);
    expect(await usage("--project", "acme", "--type", "memory")).toEqual([]);
  });

  test("it records no usage itself and ignores a query with a warning", async () => {
    await inDir(acmeDir, () => show("knowledge/invoice-tax"));
    const db = openDatabase(getStateDbPath(), { readonly: true, create: false });
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number }).n;
    const before = count();
    const result = await search("--by-usage", "invoice", "--project", "acme");
    expect(refs(result.hits)).toEqual(["knowledge/invoice-tax"]);
    expect(result.warnings?.join(" ")).toContain("ignores the query");
    expect(count()).toBe(before);
    db.close();
  });

  test("show --project attributes a read to that project, from any directory; none records no project", async () => {
    await show("knowledge/invoice-tax");
    await runCliCapture(["show", "knowledge/invoice-tax", "--project", "acme", "--format", "json"]);
    await runCliCapture(["show", "knowledge/invoice-export", "--project", "acme", "--format", "json"]);
    await inDir(acmeDir, () =>
      runCliCapture(["show", "knowledge/invoice-export", "--project", "none", "--format", "json"]),
    );
    expect(await usage("--project", "acme")).toEqual(["knowledge/invoice-export", "knowledge/invoice-tax"]);
    expect(await usage("--project", "globex")).toEqual([]);
    const bad = await runCliCapture(["show", "knowledge/invoice-tax", "--project", "nope"]);
    expect(bad.code).toBe(2);
  });

  test("--type rule does not list rules; --from registry warns and lists locally", async () => {
    await inDir(acmeDir, () => show("rules/acme/development"));
    expect(await usage("--project", "acme", "--type", "rule")).toEqual([]);
    const result = await search("--by-usage", "--project", "acme", "--from", "registry");
    expect(result.warnings?.join(" ")).toContain("ignores --from registry");
  });

  test("no history: an empty list", async () => {
    expect(await usage("--project", "acme")).toEqual([]);
  });
});

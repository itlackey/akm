/**
 * Project rules (#1467): `rules/` assets lead untyped search and curate for the project they name
 * (and shared ones), another project's rules never appear, and a bundle without `rules/` is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { packCuratedHits } from "../src/commands/read/curate";
import { runCurate } from "../src/commands/read/search-cli";
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
    "- Use Bun for scripts.",
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
  test("the project's rules and shared rules lead a query with none of their words; another project's never appear", async () => {
    await setup();
    const result = await search("invoice export", "--project", "acme");
    expect(refs(result.hits)).toEqual([
      "rules/acme/development",
      "rules/shared",
      "knowledge/invoice-export",
      "knowledge/invoice-tax",
    ]);
    expect(result.hits[0]?.type).toBe("rule");
  });

  test("two projects get their own rules", async () => {
    await setup();
    expect(refs((await search("invoice", "--project", "globex")).hits).slice(0, 2)).toEqual([
      "rules/globex/development",
      "rules/shared",
    ]);
  });

  test("the working directory selects the same rules as --project", async () => {
    await setup();
    const explicit = await search("invoice export", "--project", "acme");
    const original = process.cwd;
    process.cwd = () => acmeDir;
    try {
      expect(refs((await search("invoice export")).hits)).toEqual(refs(explicit.hits));
    } finally {
      process.cwd = original;
    }
  });

  test("with no project only shared rules apply", async () => {
    await setup();
    expect(refs((await search("invoice export", "--project", "none")).hits)).toEqual([
      "rules/shared",
      "knowledge/invoice-export",
      "knowledge/invoice-tax",
    ]);
  });

  test('search "rules/" lists exactly the applicable rules under the project', async () => {
    await setup();
    expect(refs((await search("rules/", "--project", "acme")).hits)).toEqual([
      "rules/acme/development",
      "rules/shared",
    ]);
    expect(refs((await search("rules/", "--project", "none")).hits)).toEqual(["rules/shared"]);
  });

  test("rules count in --limit and a cut list says so", async () => {
    await setup();
    const one = await search("invoice export", "--project", "acme", "--limit", "1");
    expect(refs(one.hits)).toEqual(["rules/acme/development"]);
    expect(one.warnings?.join(" ")).toContain("More rules apply than --limit 1");
    const exact = await search("invoice export", "--project", "acme", "--limit", "2");
    expect(refs(exact.hits)).toEqual(["rules/acme/development", "rules/shared"]);
    expect(exact.warnings).toBeUndefined();
  });

  test("an explicit --type or --filter that excludes rules is honoured", async () => {
    await setup();
    expect(refs((await search("invoice", "--project", "acme", "--type", "knowledge")).hits)).toEqual([
      "knowledge/invoice-export",
      "knowledge/invoice-tax",
    ]);
    const filtered = await search("invoice", "--project", "acme", "--filter", "description=nothing");
    expect(refs(filtered.hits)).toEqual([]);
  });

  test("a bundle without rules/ is unchanged", async () => {
    fs.rmSync(path.join(stashDir, "rules"), { recursive: true });
    await setup();
    expect(refs((await search("invoice export", "--project", "acme")).hits)).toEqual([
      "knowledge/invoice-export",
      "knowledge/invoice-tax",
    ]);
  });

  test("no applicable rules: results are the ordinary ones", async () => {
    fs.rmSync(path.join(stashDir, "rules/shared.md"));
    await setup();
    expect(refs((await search("invoice export", "--project", "none")).hits)).toEqual([
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

  test("applicable rules lead the items, in the limit; a directory and --project agree", async () => {
    await setup();
    const named = await run({ project: "acme", limit: "3" });
    expect(named.items.map((i) => ("ref" in i ? i.ref : ""))).toEqual([
      "rules/acme/development",
      "rules/shared",
      "knowledge/invoice-export",
    ]);
    const byDir = await run({ cwd: acmeDir, limit: "3" });
    expect(byDir.items.map((i) => ("ref" in i ? i.ref : ""))).toEqual(
      named.items.map((i) => ("ref" in i ? i.ref : "")),
    );
  });

  test("with no project only shared rules lead", async () => {
    await setup();
    const result = await run({ project: "none" });
    expect(result.items.map((i) => ("ref" in i ? i.ref : "")).slice(0, 2)).toEqual([
      "rules/shared",
      "knowledge/invoice-export",
    ]);
  });

  test("packing keeps the rules first and drops ordinary hits before them", async () => {
    await setup();
    const packed = await packCuratedHits(await run({ project: "acme" }), 12);
    expect(packed.items.map((i) => i.ref)).toEqual(
      ["rules/acme/development", "rules/shared"].slice(0, packed.items.length),
    );
    expect(packed.items.length).toBeGreaterThan(0);
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

  test("no history: an empty list", async () => {
    expect(await usage("--project", "acme")).toEqual([]);
  });
});

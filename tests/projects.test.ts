/**
 * Projects (#1461): the resolver, precedence per kind, the name convention, config handling, curate()'s
 * cwd/project, write defaults and extract naming. No project must leave every output byte-identical.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { curate } from "../src/api";
import { deriveExtractCandidateRef } from "../src/commands/improve/extract";
import { buildSessionAssetContent } from "../src/commands/improve/session-asset";
import { runCurate } from "../src/commands/read/search-cli";
import { parseFrontmatter } from "../src/core/asset/frontmatter";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { projectForDirectory, resolveProject } from "../src/core/projects";
import { _setWarnSinkForTests } from "../src/core/warn";
import { akmIndex } from "../src/indexer/indexer";
import { fillMetadata } from "../src/indexer/passes/metadata";
import { runCliCapture } from "./_helpers/cli";
import {
  type Cleanup,
  makeSandboxDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  writeSandboxConfig,
} from "./_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};
const dirs: Array<{ dir: string; cleanup: Cleanup }> = [];

function tmp(prefix: string): string {
  const made = makeSandboxDir(prefix);
  dirs.push(made);
  return fs.realpathSync(made.dir);
}

function note(root: string, name: string, front: Record<string, string>): void {
  const file = path.join(root, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = Object.entries(front)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  fs.writeFileSync(file, `---\ndescription: widget ${name}\n${fm}\n---\n\nwidget ${name} note\n`, "utf8");
}

beforeEach(() => {
  const data = sandboxXdgDataHome();
  const cache = sandboxXdgCacheHome(data.cleanup);
  const cfg = sandboxXdgConfigHome(cache.cleanup);
  const stash = sandboxStashDir(cfg.cleanup);
  stashDir = stash.dir;
  cleanup = stash.cleanup;
});

afterEach(() => {
  _setWarnSinkForTests();
  for (const d of dirs.splice(0)) d.cleanup();
  cleanup();
});

describe("resolver", () => {
  test("longest path wins, nested projects never merge, no match is none", () => {
    const root = tmp("proj-root");
    const inner = path.join(root, "apps", "web");
    fs.mkdirSync(inner, { recursive: true });
    const config = {
      projects: { mono: { paths: [root], from: "a" }, web: { paths: [inner] } },
    };
    const web = resolveProject(config, { cwd: path.join(inner, "src") });
    expect(web?.name).toBe("web");
    expect(web?.from).toBeUndefined();
    expect(resolveProject(config, { cwd: root })?.name).toBe("mono");
    expect(resolveProject(config, { cwd: tmp("proj-elsewhere") })).toBeUndefined();
  });

  test("whole segments only, and symlinks resolve", () => {
    const root = tmp("proj-seg");
    const sibling = `${root}-extra`;
    fs.mkdirSync(sibling);
    dirs.push({ dir: sibling, cleanup: () => fs.rmSync(sibling, { recursive: true, force: true }) });
    const link = path.join(tmp("proj-link"), "alias");
    fs.symlinkSync(root, link);
    const config = { projects: { p: { paths: [root] } } };
    expect(resolveProject(config, { cwd: sibling })).toBeUndefined();
    expect(resolveProject(config, { cwd: link })?.name).toBe("p");
  });

  test("~ expands to the home directory", () => {
    const rel = `akm-projects-test-${process.pid}`;
    const config = { projects: { home: { paths: [`~/${rel}`] } } };
    const match = projectForDirectory(config, path.join(os.homedir(), rel, "sub"));
    expect(match).toEqual({ name: "home", path: `~/${rel}` });
  });

  test("--project wins over the directory; none means no project; unknown is a usage error", () => {
    const a = tmp("proj-a");
    const config = { projects: { a: { paths: [a] }, b: { paths: [tmp("proj-b")] } } };
    const chosen = resolveProject(config, { project: "b", cwd: a });
    expect(chosen?.name).toBe("b");
    expect(chosen?.path).toBeUndefined();
    expect(resolveProject(config, { project: "none", cwd: a })).toBeUndefined();
    expect(() => resolveProject(config, { project: "nope" })).toThrow(/Unknown project "nope"/);
  });

  test("name convention: bare entry prefers and stamps its name; explicit values win", () => {
    const bare = resolveProject({ projects: { akm: {} } }, { project: "akm" });
    expect(bare?.prefer).toEqual({ project: "akm" });
    expect(bare?.write.metadata).toEqual({ project: "akm" });
    const own = resolveProject(
      { projects: { akm: { prefer: { team: "x" }, write: { metadata: { project: "other", client: "c" } } } } },
      { project: "akm" },
    );
    expect(own?.prefer).toEqual({ team: "x" });
    expect(own?.write.metadata).toEqual({ project: "other", client: "c" });
  });
});

describe("config", () => {
  test("malformed pieces warn once and are ignored; the rest of the config loads", () => {
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(String(args[0]));
    });
    const good = tmp("proj-good");
    writeSandboxConfig({
      semanticSearchMode: "off",
      projects: {
        good: { paths: [good, "relative/dir"], from: 5, write: { user: "", bundle: "b" } },
        none: { paths: [good] },
        broken: "text",
      },
    });
    resetConfigCache();
    const projects = loadConfig().projects;
    expect(Object.keys(projects ?? {})).toEqual(["good"]);
    expect(projects?.good?.paths).toEqual([good]);
    expect(projects?.good?.from).toBeUndefined();
    expect(projects?.good?.write).toEqual({ bundle: "b" });
    const text = warnings.join("\n");
    expect(text).toMatch(/projects\.good\.paths/);
    expect(text).toMatch(/projects\.good\.from/);
    expect(text).toMatch(/projects\.broken/);
    expect(text).toMatch(/projects\.none/);
  });

  test("extends merges projects by name, local winning", () => {
    const base = path.join(tmp("proj-base"), "base.json");
    fs.writeFileSync(
      base,
      JSON.stringify({
        configVersion: "0.9.0",
        projects: { shared: { paths: ["/srv/a"], from: "team" }, only: { paths: ["/srv/o"] } },
      }),
    );
    saveConfig({
      semanticSearchMode: "off",
      extends: base,
      projects: { shared: { paths: ["/srv/mine"] }, local: { paths: ["/srv/l"] } },
    } as never);
    resetConfigCache();
    const projects = loadConfig().projects ?? {};
    expect(Object.keys(projects).sort()).toEqual(["local", "only", "shared"]);
    expect(projects.shared).toEqual({ paths: ["/srv/mine"], from: "team" });
  });
});

describe("curate", () => {
  let work = "";

  beforeEach(async () => {
    work = tmp("proj-work");
    note(stashDir, "akm-note", { project: "akm" });
    note(stashDir, "other-note", { project: "other" });
    note(stashDir, "plain-note", { team: "t" });
    saveConfig({
      semanticSearchMode: "off",
      projects: {
        akm: { paths: [work] },
        scoped: { paths: [tmp("proj-scoped")], filters: { project: ["other", ""] } },
      },
    } as never);
    await akmIndex({ stashDir, full: true });
  });

  const run = (args: Record<string, unknown>) =>
    runCurate({ query: "widget", limit: "10", ...args }, { detail: "normal", shape: "human" });

  test("the directory selects a project: prefer by name, reported in the response", async () => {
    const result = await run({ cwd: work });
    expect(result.project).toEqual({ name: "akm", path: work, prefer: { project: "akm" } });
    expect(result.items[0]?.name).toBe("akm-note");
  });

  test("an explicit --prefer replaces the project's; --project reports no path", async () => {
    const result = await run({ cwd: work, prefer: ["project=other"] });
    expect(result.items[0]?.name).toBe("other-note");
    expect(result.project?.prefer).toEqual({ project: "akm" });
    const named = await run({ project: "scoped" });
    expect(named.project?.path).toBeUndefined();
    expect(named.project?.filters).toEqual({ project: ["other", ""] });
    expect(named.items.map((i) => i.name).sort()).toEqual(["other-note", "plain-note"]);
    const explicit = await run({ project: "scoped", filters: ["project=akm"] });
    expect(explicit.items.map((i) => i.name)).toEqual(["akm-note"]);
  });

  test("no project: output is byte-identical with or without a projects key", async () => {
    const elsewhere = tmp("proj-nowhere");
    const withProjects = await curate("widget", { cwd: elsewhere, format: "json" });
    const text = await curate("widget", { cwd: elsewhere, format: "text" });
    saveConfig({ semanticSearchMode: "off" });
    resetConfigCache();
    expect(await curate("widget", { cwd: elsewhere, format: "json" })).toBe(withProjects);
    expect(await curate("widget", { cwd: elsewhere, format: "text" })).toBe(text);
    expect(withProjects).not.toContain('"project"');
    expect(text).not.toContain("Project ");
  });

  test("curate() takes cwd and project, and text output opens with one project line", async () => {
    const text = await curate("widget", { cwd: work, format: "text" });
    expect(text.split("\n")[0]).toBe(`Project akm (${work}): prefer project=akm`);
    expect(JSON.parse(await curate("widget", { cwd: work })).project.name).toBe("akm");
    expect(JSON.parse(await curate("widget", { cwd: work, project: "none" })).project).toBeUndefined();
    await expect(curate("widget", { project: "nope" })).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
  });

  test("akm search --project reports the project and applies its filters", async () => {
    const { code, stdout } = await runCliCapture(["search", "widget", "--project", "scoped", "--format", "json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.project.name).toBe("scoped");
    expect(parsed.hits.map((h: { name: string }) => h.name).sort()).toEqual(["other-note", "plain-note"]);
    const bad = await runCliCapture(["search", "widget", "--project", "nope"]);
    expect(bad.code).toBe(2);
  });
});

describe("write defaults", () => {
  test("remember: write.bundle, scope fill one at a time, metadata, flags over project", async () => {
    const team = tmp("proj-team");
    saveConfig({
      semanticSearchMode: "off",
      bundles: { team: { path: team, writable: true } },
      projects: {
        acme: {
          write: { bundle: "team", user: "u1", channel: "acme", metadata: { client: "acme", kind: "meta" } },
        },
      },
    } as never);
    const { code, stdout, stderr } = await runCliCapture([
      "remember",
      "acme note body",
      "--project",
      "acme",
      "--channel",
      "flag",
      "--name",
      "acme-note",
    ]);
    if (code !== 0) throw new Error(stderr);
    const file = JSON.parse(stdout).path as string;
    expect(file.startsWith(team)).toBe(true);
    const { data } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    expect(data.scope_user).toBe("u1");
    expect(data.scope_channel).toBe("flag");
    expect(data.client).toBe("acme");
    expect(data.kind).toBe("meta");
    expect(data.project).toBe("acme");
  });

  test("remember: an unwritable write.bundle fails with --bundle's error", async () => {
    saveConfig({ semanticSearchMode: "off", projects: { p: { write: { bundle: "ghost" } } } } as never);
    const { code, stderr } = await runCliCapture(["remember", "text", "--project", "p"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--bundle must reference a source name");
  });

  test("fillMetadata: existing keys win and metadata never carries scope", () => {
    expect(fillMetadata({ a: 1 }, { a: 2, b: 3, scope_user: "x" })).toEqual({ a: 1, b: 3 });
  });
});

describe("extract naming", () => {
  const candidate = { type: "memory", name: "note" } as never;

  test("a configured project's name replaces the hint; otherwise today's behaviour", () => {
    const ref = { harness: "codex", sessionId: "s", filePath: "/x", projectHint: "/home/me/code/akm" };
    expect(deriveExtractCandidateRef(candidate, ref)).toBe("memories/akm/note");
    expect(deriveExtractCandidateRef(candidate, ref, "my-proj")).toBe("memories/my-proj/note");
    const claude = { harness: "claude", sessionId: "s", filePath: "/x", projectHint: "-home-me-akm" };
    expect(deriveExtractCandidateRef(candidate, claude)).toBe("memories/home-me-akm/note");
  });

  test("the session asset's project: is the name when one resolved", () => {
    const data = {
      ref: { harness: "codex", sessionId: "abcdefghij", filePath: "/x", projectHint: "/home/me/akm" },
      events: [],
      inlineRefs: [],
    } as never;
    const summary = { summary: "s", keyTopics: [] };
    expect(buildSessionAssetContent(data, summary).frontmatter.project).toBe("/home/me/akm");
    expect(buildSessionAssetContent(data, summary, "akm").frontmatter.project).toBe("akm");
  });
});

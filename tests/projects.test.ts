/**
 * Projects (#1461): the resolver, precedence per kind, the name convention, config handling, curate()'s
 * cwd/project, write defaults and extract naming. No project must leave every output byte-identical.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { AKM_READ_TOOLS } from "../src/integrations/agent/akm-read-tools";
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

  test("reserved metadata keys, ~user paths and a path shared by two projects warn and are ignored", () => {
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(String(args[0]));
    });
    const dir = tmp("proj-dup");
    writeSandboxConfig({
      semanticSearchMode: "off",
      projects: {
        first: { paths: [dir], write: { metadata: { description: "x", scope_user: "u", tags: "t", client: "c" } } },
        second: { paths: [`${dir}/`, "~someone/code"] },
      },
    });
    resetConfigCache();
    const config = loadConfig();
    expect(config.projects?.first?.write?.metadata).toEqual({ client: "c" });
    expect(config.projects?.second?.paths).toEqual([`${dir}/`]);
    const text = warnings.join("\n");
    expect(text).toMatch(/metadata\.description/);
    expect(text).toMatch(/metadata\.scope_user/);
    expect(text).toMatch(/~someone/);
    expect(text).toMatch(/also a path of "first"/);
    // First in the file wins the shared path.
    expect(resolveProject(config, { cwd: dir })?.name).toBe("first");
  });

  test("a trailing slash in a configured path still matches", () => {
    const dir = tmp("proj-slash");
    const config = { projects: { p: { paths: [`${dir}/`] } } };
    expect(resolveProject(config, { cwd: path.join(dir, "sub") })).toMatchObject({ name: "p", path: `${dir}/` });
  });

  test("extends replaces a project whole by name, local winning", () => {
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
    expect(projects.shared).toEqual({ paths: ["/srv/mine"] });
    expect(projects.only).toEqual({ paths: ["/srv/o"] });
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

  test("--pack: text opens with the project line, json stays the items only", async () => {
    const text = await runCliCapture(["curate", "widget", "--project", "akm", "--pack", "2000", "--format", "text"]);
    expect(text.code).toBe(0);
    expect(text.stdout.split("\n")[0]).toBe("Project akm: prefer project=akm");
    const json = await runCliCapture(["curate", "widget", "--project", "akm", "--pack", "2000", "--format", "json"]);
    expect(Array.isArray(JSON.parse(json.stdout))).toBe(true);
    expect(json.stdout).not.toContain('"project"');
  });

  test("model work ignores a registered project", async () => {
    const spy = spyOn(process, "cwd").mockReturnValue(work);
    try {
      const curateTool = AKM_READ_TOOLS.find((tool) => tool.name === "akm_curate");
      const out = JSON.parse(await curateTool!.run({ query: "widget" }));
      expect(out.project).toBeUndefined();
      const user = await run({});
      expect(user.project?.name).toBe("akm");
    } finally {
      spy.mockRestore();
    }
  });

  test("akm search with no project: json and text are byte-identical with or without a projects key", async () => {
    const elsewhere = tmp("proj-nowhere-cli");
    const spy = spyOn(process, "cwd").mockReturnValue(elsewhere);
    try {
      const outputs = async () => [
        (await runCliCapture(["search", "widget", "--format", "json"])).stdout,
        (await runCliCapture(["search", "widget", "--format", "text"])).stdout,
      ];
      const withProjects = await outputs();
      saveConfig({ semanticSearchMode: "off" });
      resetConfigCache();
      expect(await outputs()).toEqual(withProjects);
      expect(withProjects[0]).not.toContain('"project"');
      expect(withProjects[1]).not.toContain("Project ");
    } finally {
      spy.mockRestore();
    }
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

  test("remember: body frontmatter beats project metadata, and akm's own keys beat both (stdin)", () => {
    saveConfig({
      semanticSearchMode: "off",
      projects: { acme: { write: { metadata: { kind: "meta", tier: "meta", client: "acme" } } } },
    } as never);
    const result = spawnSync("bun", ["src/cli.ts", "remember", "--project", "acme", "--name", "stdin-note"], {
      input: "---\nkind: body\ncaptureMode: background\ndescription: from body\n---\nnote text\n",
      encoding: "utf8",
      env: process.env,
    });
    expect(result.status).toBe(0);
    const file = JSON.parse(result.stdout).path as string;
    const { data } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    expect(data.kind).toBe("body");
    expect(data.tier).toBe("meta");
    expect(data.client).toBe("acme");
    expect(data.project).toBe("acme");
    expect(data.captureMode).toBe("hot");
    expect(data.description).toBe("from body");
  });

  test("remember: the project's write.bundle never raises a conflict the user did not type", async () => {
    const team = tmp("proj-team2");
    saveConfig({
      semanticSearchMode: "off",
      bundles: { team: { path: team, writable: true } },
      projects: { acme: { write: { bundle: "team" } } },
    } as never);
    const first = await runCliCapture(["remember", "base note", "--name", "base"]);
    expect(first.code).toBe(0);
    const ref = JSON.parse(first.stdout).ref as string;
    const second = await runCliCapture(["remember", "fix", "--project", "acme", "--supersedes", ref, "--name", "fix"]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).path.startsWith(team)).toBe(false);
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

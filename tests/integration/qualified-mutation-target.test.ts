import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { runCliCapture } from "../_helpers/cli";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let dirs: SandboxedDir[] = [];

function sandbox(prefix: string): string {
  const dir = makeSandboxDir(prefix);
  dirs.push(dir);
  return dir.dir;
}

function configure(team: string, defaultWriteTarget?: string): void {
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true },
      team: { path: team, writable: true },
    },
    defaultBundle: "stash",
    ...(defaultWriteTarget ? { defaultWriteTarget } : {}),
  });
}

function seed(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) dir.cleanup();
  storage.cleanup();
});

describe("qualified mutation targets", () => {
  test("a qualified env ref selects its bundle without --target", async () => {
    const team = sandbox("akm-qualified-env");
    configure(team);
    const value = seed(storage.root, "value.txt", "secret-value");

    const result = await runCliCapture([
      "env",
      "set",
      "team//env/prod",
      "API_TOKEN",
      "--from-file",
      value,
      "--format",
      "json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ref).toBe("team//env/prod");
    expect(fs.existsSync(path.join(team, "env", "prod.env"))).toBe(true);
    expect(fs.existsSync(path.join(storage.stashDir, "env", "prod.env"))).toBe(false);
  });

  test("a matching --target is accepted and a conflicting --target is a usage error", async () => {
    const team = sandbox("akm-qualified-match");
    configure(team);
    const value = seed(storage.root, "secret.txt", "secret-value");

    const matching = await runCliCapture([
      "secret",
      "set",
      "team//secrets/deploy-key",
      "--from-file",
      value,
      "--target",
      "team",
    ]);
    expect(matching.code).toBe(0);
    expect(JSON.parse(matching.stdout).ref).toBe("team//secrets/deploy-key");

    const conflicting = await runCliCapture([
      "env",
      "set",
      "team//env/conflict",
      "API_TOKEN",
      "--from-file",
      value,
      "--target",
      "stash",
    ]);
    expect(conflicting.code).toBe(2);
    expect(JSON.parse(conflicting.stderr).error).toContain("conflicts with --target");
    expect(fs.existsSync(path.join(team, "env", "conflict.env"))).toBe(false);
    expect(fs.existsSync(path.join(storage.stashDir, "env", "conflict.env"))).toBe(false);
  });

  test("a short ref retains defaultWriteTarget fallback and returns a qualified ref", async () => {
    const team = sandbox("akm-qualified-fallback");
    configure(team, "team");
    const value = seed(storage.root, "value.txt", "secret-value");

    const result = await runCliCapture(["env", "set", "prod", "API_TOKEN", "--from-file", value]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ref).toBe("team//env/prod");
    expect(fs.existsSync(path.join(team, "env", "prod.env"))).toBe(true);
  });

  test("the configured default bundle keeps the short display spelling", async () => {
    const team = sandbox("akm-qualified-default-display");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir }, team: { path: team } },
      defaultBundle: "team",
    });
    const value = seed(storage.root, "default-value.txt", "secret-value");

    const result = await runCliCapture(["secret", "set", "team//secrets/default-key", "--from-file", value]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ref).toBe("secrets/default-key");
  });

  test("a short env read resolves membership beyond the default bundle", async () => {
    const team = sandbox("akm-qualified-read-membership");
    configure(team);
    const teamEnv = seed(team, "env/team-only.env", "TEAM_ONLY=true\n");

    const result = await runCliCapture(["env", "path", "team-only", "--quiet"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(teamEnv);
  });

  test("remember and import return qualified refs for non-default write targets", async () => {
    const team = sandbox("akm-qualified-markdown");
    configure(team);

    const remembered = await runCliCapture([
      "remember",
      "Team deployment note",
      "--name",
      "deployment-note",
      "--target",
      "team",
    ]);
    expect(remembered.code).toBe(0);
    expect(JSON.parse(remembered.stdout).ref).toBe("team//memories/deployment-note");

    const source = seed(storage.root, "guide.md", "# Team guide\n");
    const imported = await runCliCapture(["import", source, "--target", "team"]);
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.stdout).ref).toBe("team//knowledge/guide");
  });

  test("qualified xref and supersedes refs disambiguate duplicate names", async () => {
    const team = sandbox("akm-qualified-duplicate");
    configure(team);
    seed(storage.stashDir, "knowledge/shared.md", "# Local shared\n");
    seed(team, "knowledge/shared.md", "# Team shared\n");
    const localOld = seed(storage.stashDir, "memories/old.md", "---\nbeliefState: asserted\n---\nLocal old.\n");
    const teamOld = seed(team, "memories/old.md", "---\nbeliefState: asserted\n---\nTeam old.\n");

    const cited = await runCliCapture([
      "remember",
      "Cites the team copy",
      "--name",
      "citation",
      "--xref",
      "team//knowledge/shared",
    ]);
    expect(cited.code).toBe(0);
    const citation = parseFrontmatter(fs.readFileSync(JSON.parse(cited.stdout).path, "utf8"));
    expect(citation.data.xrefs).toEqual(["team//knowledge/shared"]);

    const corrected = await runCliCapture([
      "remember",
      "Corrects the team copy",
      "--name",
      "correction",
      "--supersedes",
      "team//memories/old",
    ]);
    expect(corrected.code).toBe(0);
    expect(JSON.parse(corrected.stdout).ref).toBe("team//memories/correction");
    expect(parseFrontmatter(fs.readFileSync(teamOld, "utf8")).data.beliefState).toBe("superseded");
    expect(parseFrontmatter(fs.readFileSync(localOld, "utf8")).data.beliefState).toBe("asserted");
  });
});

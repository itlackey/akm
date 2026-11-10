import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitRepoUrl } from "../../src/sources/providers/git";
import { type CliResult, runCliCapture } from "../_helpers/cli";
import { withBundle, withEnv } from "../_helpers/sandbox";

// INTEGRATION TEST — real git subprocesses against temp repos and a local bare
// remote (#1500 file mode, #1501 sync credential, #1502 sync scope).

const tempDirs: string[] = [];
const TOKEN = "tok-sync-secret-1501";

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
}

function commitAll(dir: string, message = "seed"): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

/** A repo with a local bare `origin` and upstream tracking, seeded with `files`. */
function repoWithRemote(files: Record<string, string>, at?: string): { repo: string; remote: string } {
  const remote = tmp("akm-sync-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const repo = at ?? tmp("akm-sync-repo-");
  initRepo(repo);
  for (const [rel, content] of Object.entries(files)) write(repo, rel, content);
  commitAll(repo);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, remote };
}

function headFiles(dir: string, ref = "HEAD"): string[] {
  return git(dir, "show", "--name-only", "--format=", ref).split("\n").filter(Boolean).sort();
}

function lsTreeMode(dir: string, rel: string): string {
  return git(dir, "ls-tree", "HEAD", "--", rel).split(" ")[0] as string;
}

async function runSync(
  args: string[],
  opts: {
    bundleDir: string;
    bundles?: Record<string, unknown>;
    defaultBundle?: string;
    cacheHome?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<CliResult> {
  const config = tmp("akm-sync-cfg-");
  fs.mkdirSync(path.join(config, "akm"), { recursive: true });
  fs.writeFileSync(
    path.join(config, "akm", "config.json"),
    JSON.stringify({
      semanticSearchMode: "off",
      bundles: opts.bundles ?? {},
      ...(opts.defaultBundle ? { defaultBundle: opts.defaultBundle } : {}),
    }),
  );
  return withEnv(
    {
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: opts.cacheHome ?? tmp("akm-sync-cache-"),
      XDG_DATA_HOME: tmp("akm-sync-data-"),
      XDG_STATE_HOME: tmp("akm-sync-state-"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...opts.env,
    },
    () => withBundle(opts.bundleDir, () => runCliCapture(args)),
  );
}

/** `repo` as the writable default bundle, so `akm sync` may push. */
function primary(repo: string) {
  return { bundleDir: repo, bundles: { main: { path: repo, writable: true } }, defaultBundle: "main" };
}

describe("akm sync scope (#1502)", () => {
  const files = {
    ".gitignore": "ignored/\n",
    "README.md": "root\n",
    "knowledge/guide.md": "guide\n",
    "notes/project.md": "notes\n",
    "wikis/manual/page.md": "page\n",
    "attachments/diagram.svg": "<svg/>\n",
    "ignored/skip.md": "skip\n",
  };

  test("syncs root, custom-directory and attachment additions, edits and deletions", async () => {
    const { repo, remote } = repoWithRemote({ ...files, "notes/old.md": "old\n" });
    write(repo, "knowledge/guide.md", "guide 2\n");
    write(repo, "README.md", "root 2\n");
    write(repo, "notes/project.md", "notes 2\n");
    write(repo, "attachments/new.svg", "<svg>2</svg>\n");
    write(repo, "ignored/new.md", "never\n");
    fs.rmSync(path.join(repo, "notes/old.md"));

    const result = await runSync(["sync", "-m", "all"], primary(repo));
    expect(result.code).toBe(0);
    expect(headFiles(repo)).toEqual([
      "README.md",
      "attachments/new.svg",
      "knowledge/guide.md",
      "notes/old.md",
      "notes/project.md",
    ]);
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
  });

  test("a lone edit to a tracked root file is committed, not reported as nothing to commit", async () => {
    const { repo } = repoWithRemote(files);
    write(repo, "README.md", "root 2\n");
    const result = await runSync(["sync"], primary(repo));
    expect(JSON.parse(result.stdout).committed).toBe(true);
    expect(headFiles(repo)).toEqual(["README.md"]);
  });

  test("a named bundle at the repository root syncs the same way as the primary bundle", async () => {
    const { repo } = repoWithRemote(files);
    write(repo, "notes/project.md", "notes 2\n");
    const other = tmp("akm-sync-primary-");
    initRepo(other);
    const result = await runSync(["sync", "root-bundle"], {
      bundleDir: other,
      bundles: { "root-bundle": { path: repo } },
    });
    expect(JSON.parse(result.stdout).committed).toBe(true);
    expect(headFiles(repo)).toEqual(["notes/project.md"]);
  });

  test("a nested bundle never includes changes outside its content root, nor unrelated staged work", async () => {
    const { repo } = repoWithRemote({ ...files, "sub/knowledge/a.md": "a\n" });
    write(repo, "sub/notes/inside.md", "in\n");
    write(repo, "README.md", "root 2\n");
    write(repo, "staged.md", "staged\n");
    git(repo, "add", "staged.md");
    const other = tmp("akm-sync-primary-");
    initRepo(other);

    const result = await runSync(["sync", "nested"], {
      bundleDir: other,
      bundles: { nested: { path: path.join(repo, "sub") } },
    });
    expect(result.code).toBe(0);
    expect(headFiles(repo)).toEqual(["sub/notes/inside.md"]);
    expect(git(repo, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([
      " M README.md",
      "A  staged.md",
    ]);
  });

  test("a nested Git repository in a root bundle is skipped instead of failing the sync", async () => {
    const { repo } = repoWithRemote(files);
    const nested = path.join(repo, "tools");
    initRepo(nested);
    write(nested, "x.md", "x\n");
    commitAll(nested);
    write(repo, "README.md", "root 2\n");
    const result = await runSync(["sync"], primary(repo));
    expect(result.code).toBe(0);
    expect(headFiles(repo)).toEqual(["README.md"]);
  });

  test("--no-push commits root files without pushing", async () => {
    const { repo, remote } = repoWithRemote(files);
    const before = git(remote, "rev-parse", "main");
    write(repo, "README.md", "root 2\n");
    const result = await runSync(["sync", "--no-push"], primary(repo));
    expect(JSON.parse(result.stdout)).toMatchObject({ committed: true, pushed: false });
    expect(git(remote, "rev-parse", "main")).toBe(before);
  });
});

describe("akm sync file mode (#1500)", () => {
  function modeFixture(filemode: "true" | "false"): string {
    const repo = tmp("akm-sync-mode-");
    initRepo(repo);
    write(repo, "knowledge/plain.md", "plain\n");
    write(repo, "knowledge/tool.md", "tool\n");
    fs.chmodSync(path.join(repo, "knowledge/tool.md"), 0o755);
    commitAll(repo);
    git(repo, "config", "core.filemode", filemode);
    return repo;
  }

  test("filemode=false: a new file presented as 0777 commits as 100644", async () => {
    const repo = modeFixture("false");
    write(repo, "knowledge/new.md", "new\n");
    fs.chmodSync(path.join(repo, "knowledge/new.md"), 0o777);
    const result = await runSync(["sync"], { bundleDir: repo });
    expect(result.code).toBe(0);
    expect(lsTreeMode(repo, "knowledge/new.md")).toBe("100644");
    expect(git(repo, "show", "HEAD:knowledge/new.md")).toBe("new\n");
  });

  test("filemode=false: edits keep the tracked 100644 and 100755 modes whatever the filesystem presents", async () => {
    const repo = modeFixture("false");
    write(repo, "knowledge/plain.md", "plain 2\n");
    write(repo, "knowledge/tool.md", "tool 2\n");
    fs.chmodSync(path.join(repo, "knowledge/plain.md"), 0o777);
    fs.chmodSync(path.join(repo, "knowledge/tool.md"), 0o644);
    const result = await runSync(["sync"], { bundleDir: repo });
    expect(result.code).toBe(0);
    expect(lsTreeMode(repo, "knowledge/plain.md")).toBe("100644");
    expect(lsTreeMode(repo, "knowledge/tool.md")).toBe("100755");
    expect(git(repo, "show", "HEAD:knowledge/tool.md")).toBe("tool 2\n");
  });

  test("filemode=true: an executable-bit change is committed", async () => {
    const repo = modeFixture("true");
    fs.chmodSync(path.join(repo, "knowledge/plain.md"), 0o755);
    fs.chmodSync(path.join(repo, "knowledge/tool.md"), 0o644);
    const result = await runSync(["sync"], { bundleDir: repo });
    expect(result.code).toBe(0);
    expect(lsTreeMode(repo, "knowledge/plain.md")).toBe("100755");
    expect(lsTreeMode(repo, "knowledge/tool.md")).toBe("100644");
  });

  test("filemode=true: a concurrent mode change is still detected", async () => {
    const { saveGitStash } = await import("../../src/sources/providers/git");
    const repo = modeFixture("true");
    write(repo, "knowledge/plain.md", "plain 2\n");
    const oid = git(repo, "hash-object", "knowledge/plain.md").trim();
    expect(() =>
      saveGitStash(undefined, "m", true, {
        repoDir: repo,
        paths: ["knowledge/plain.md"],
        expectedSnapshots: { "knowledge/plain.md": { oid, mode: "100755" } },
      }),
    ).toThrow("Exact Git publication path changed while committing");
    expect(git(repo, "log", "--format=%s", "-1").trim()).toBe("seed");
  });

  test("filemode=false: a stale content snapshot is still rejected", async () => {
    const { saveGitStash } = await import("../../src/sources/providers/git");
    const repo = modeFixture("false");
    write(repo, "knowledge/plain.md", "plain 2\n");
    const stale = { oid: git(repo, "hash-object", "knowledge/tool.md").trim(), mode: "100644" as const };
    expect(() =>
      saveGitStash(undefined, "m", true, {
        repoDir: repo,
        paths: ["knowledge/plain.md"],
        expectedSnapshots: { "knowledge/plain.md": stale },
      }),
    ).toThrow("Exact Git publication path changed while committing");
    expect(git(repo, "log", "--format=%s", "-1").trim()).toBe("seed");
  });
});

describe("akm sync credential (#1501)", () => {
  /** A `git` shim that records the credential header and argv of each fetch/push, then runs real git. */
  function gitShim(): { dir: string; log: string } {
    const dir = tmp("akm-sync-shim-");
    const log = path.join(dir, "calls.log");
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(
      path.join(dir, "git"),
      `#!/bin/sh
for a in "$@"; do case "$a" in fetch|push) echo "$a|$GIT_CONFIG_KEY_0|$GIT_CONFIG_VALUE_0|$*" >> "${log}"; break;; esac; done
exec "${real}" "$@"
`,
      { mode: 0o755 },
    );
    return { dir, log };
  }

  function calls(log: string): string[][] {
    return fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("|"))
      : [];
  }

  const URL = "https://github.com/acme/private-stash";

  function cacheRepoDir(cacheHome: string): string {
    const key = createHash("sha256").update(parseGitRepoUrl(URL).canonicalUrl).digest("hex").slice(0, 16);
    return path.join(cacheHome, "akm", "registry-index", `git-${key}`, "repo");
  }

  async function syncWith(
    credential: string | undefined,
    args: string[],
    prepare: (repo: string) => void,
    bundleExtra: Record<string, unknown> = {},
    name = "priv",
    extraBundles: Record<string, unknown> = {},
  ) {
    const cacheHome = tmp("akm-sync-cache-");
    const { repo, remote } = repoWithRemote({ "knowledge/a.md": "a\n" }, cacheRepoDir(cacheHome));
    prepare(repo);
    const shim = gitShim();
    const other = tmp("akm-sync-primary-");
    initRepo(other);
    const result = await runSync(["sync", name, ...args], {
      bundleDir: other,
      cacheHome,
      bundles: {
        ...extraBundles,
        [name]: { git: URL, writable: true, ...(credential ? { credential } : {}), ...bundleExtra },
      },
      env: { PATH: `${shim.dir}:${process.env.PATH}`, AKM_TEST_GIT_TOKEN: TOKEN },
    });
    return { repo, remote, result, recorded: calls(shim.log) };
  }

  const header = `Authorization: Bearer ${TOKEN}`;

  test("a $VAR credential reaches both fetch and push, and never argv, output or git config", async () => {
    const { repo, result, recorded } = await syncWith("$AKM_TEST_GIT_TOKEN", [], (r) =>
      write(r, "knowledge/b.md", "b\n"),
    );
    expect(result.code).toBe(0);
    expect(recorded.map((c) => c[0])).toEqual(["fetch", "push"]);
    for (const call of recorded) {
      expect(call[1]).toBe("http.extraHeader");
      expect(call[2]).toBe(header);
      expect(call[3]).not.toContain(TOKEN);
    }
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(fs.readFileSync(path.join(repo, ".git", "config"), "utf8")).not.toContain(TOKEN);
  });

  test("a clean checkout that is already ahead retries the push with the credential", async () => {
    const { remote, repo, recorded } = await syncWith("$AKM_TEST_GIT_TOKEN", [], (r) => {
      write(r, "knowledge/b.md", "b\n");
      commitAll(r, "local only");
    });
    expect(recorded.map((c) => c[0])).toEqual(["fetch", "push"]);
    expect(recorded.every((c) => c[2] === header)).toBe(true);
    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
  });

  test("a secret-store ref credential resolves through an isolated secret store", async () => {
    const team = tmp("akm-sync-team-");
    initRepo(team);
    write(team, "secrets/sync_token", `${TOKEN}\n`);
    const { repo, remote, result, recorded } = await syncWith(
      ["$", "{team//secrets/sync_token}"].join(""),
      [],
      (r) => write(r, "knowledge/b.md", "b\n"),
      {},
      "priv",
      { team: { path: team } },
    );
    expect(result.stderr + result.stdout).toContain("committed");
    expect(recorded.map((c) => c[0])).toEqual(["fetch", "push"]);
    expect(recorded.every((c) => c[2] === header)).toBe(true);
    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
  });

  test("no configured credential leaves fetch and push untouched", async () => {
    const { recorded } = await syncWith(undefined, [], (r) => write(r, "knowledge/b.md", "b\n"));
    expect(recorded.map((c) => c[0])).toEqual(["fetch", "push"]);
    expect(recorded.every((c) => !c[2])).toBe(true);
  });

  test("--no-push and a read-only bundle never touch the network", async () => {
    const noPush = await syncWith("$AKM_TEST_GIT_TOKEN", ["--no-push"], (r) => write(r, "knowledge/b.md", "b\n"));
    expect(noPush.recorded).toEqual([]);
    const readOnly = await syncWith("$AKM_TEST_GIT_TOKEN", [], (r) => write(r, "knowledge/b.md", "b\n"), {
      writable: false,
    });
    expect(readOnly.recorded).toEqual([]);
  });

  test("the credential belongs to the selected bundle, not another configured one", async () => {
    const { recorded } = await syncWith(undefined, [], (r) => write(r, "knowledge/b.md", "b\n"), {}, "priv", {
      decoy: { git: "https://github.com/acme/decoy", credential: "$AKM_TEST_GIT_TOKEN" },
    });
    expect(recorded.length).toBe(2);
    expect(recorded.every((c) => !c[2])).toBe(true);
  });

  test("a rejected push keeps the local commit and does not leak the credential", async () => {
    const cacheHome = tmp("akm-sync-cache-");
    const { repo, remote } = repoWithRemote({ "knowledge/a.md": "a\n" }, cacheRepoDir(cacheHome));
    write(remote, "hooks/pre-receive", "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(remote, "hooks/pre-receive"), 0o755);
    write(repo, "knowledge/b.md", "b\n");
    const other = tmp("akm-sync-primary-");
    initRepo(other);
    const result = await runSync(["sync", "priv"], {
      bundleDir: other,
      cacheHome,
      bundles: { priv: { git: URL, writable: true, credential: "$AKM_TEST_GIT_TOKEN" } },
      env: { AKM_TEST_GIT_TOKEN: TOKEN },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(headFiles(repo)).toEqual(["knowledge/b.md"]);
  });

  test("an unresolvable credential still commits locally and reports the reference, never a value", async () => {
    const team = tmp("akm-sync-team-");
    initRepo(team);
    const { repo, remote, result, recorded } = await syncWith(
      ["$", "{team//secrets/missing}"].join(""),
      [],
      (r) => write(r, "knowledge/b.md", "b\n"),
      {},
      "priv",
      { team: { path: team } },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ committed: true, pushed: false });
    expect(JSON.parse(result.stdout).reason).toContain("not pushed");
    expect(recorded).toEqual([]);
    expect(headFiles(repo)).toEqual(["knowledge/b.md"]);
    expect(git(remote, "rev-parse", "main")).not.toBe(git(repo, "rev-parse", "HEAD"));
  });

  /** In-process unnamed `saveGitStash` for the cache checkout of the credentialed `priv` bundle. */
  async function unnamedSync(credential: string, extraBundles: Record<string, unknown> = {}) {
    const { saveGitStash } = await import("../../src/sources/providers/git");
    const cacheHome = tmp("akm-sync-cache-");
    const { repo, remote } = repoWithRemote({ "knowledge/a.md": "a\n" }, cacheRepoDir(cacheHome));
    write(repo, "knowledge/b.md", "b\n");
    const shim = gitShim();
    const config = tmp("akm-sync-cfg-");
    fs.mkdirSync(path.join(config, "akm"), { recursive: true });
    fs.writeFileSync(
      path.join(config, "akm", "config.json"),
      JSON.stringify({
        semanticSearchMode: "off",
        bundles: { ...extraBundles, priv: { git: URL, writable: true, credential } },
      }),
    );
    const result = await withEnv(
      {
        XDG_CONFIG_HOME: config,
        XDG_CACHE_HOME: cacheHome,
        XDG_DATA_HOME: tmp("akm-sync-data-"),
        XDG_STATE_HOME: tmp("akm-sync-state-"),
        PATH: `${shim.dir}:${process.env.PATH}`,
        AKM_TEST_GIT_TOKEN: TOKEN,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      () => saveGitStash(undefined, "auto", true, { repoDir: repo }),
    );
    return { repo, remote, result, recorded: calls(shim.log) };
  }

  test("the unnamed/automatic path uses the credential of the bundle whose checkout it syncs", async () => {
    const { repo, remote, result, recorded } = await unnamedSync("$AKM_TEST_GIT_TOKEN", {
      decoy: { git: "https://github.com/acme/decoy", credential: "$AKM_TEST_OTHER" },
    });
    expect(result).toMatchObject({ committed: true, pushed: true });
    expect(recorded.map((c) => c[0])).toEqual(["fetch", "push"]);
    expect(recorded.every((c) => c[2] === header)).toBe(true);
    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
  });

  test("the unnamed path with an unresolvable credential still commits and reports not pushed", async () => {
    const team = tmp("akm-sync-team-");
    initRepo(team);
    const { repo, result, recorded } = await unnamedSync(["$", "{team//secrets/missing}"].join(""), {
      team: { path: team },
    });
    expect(result).toMatchObject({ committed: true, pushed: false });
    expect(result.reason).toContain("not pushed");
    expect(recorded).toEqual([]);
    expect(headFiles(repo)).toEqual(["knowledge/b.md"]);
  });
});

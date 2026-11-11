import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { prepareWriteTargetForMutation } from "../../../src/core/write-source";
import type { ParsedGitRef } from "../../../src/registry/types";
import { classifyCloneFailure, cloneRepo, syncExistingWritableCheckout } from "../../../src/sources/providers/git";
import { buildInstallCacheDir } from "../../../src/sources/providers/provider-utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function makeTempDir(prefix = "akm-clone-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function makeWritableFixture(): { remote: string; author: string; checkout: string; contentRoot: string } {
  const root = makeTempDir("akm-writable-git-");
  const remote = path.join(root, "remote.git");
  const author = path.join(root, "author");
  const checkout = path.join(root, "checkout");
  git(["init", "--bare", remote]);
  git(["init", "-b", "main", author]);
  git(["-C", author, "config", "user.name", "AKM Test"]);
  git(["-C", author, "config", "user.email", "akm@example.test"]);
  fs.mkdirSync(path.join(author, "content", "lessons"), { recursive: true });
  fs.writeFileSync(path.join(author, "content", "lessons", "seed.md"), "seed\n", "utf8");
  git(["-C", author, "add", "."]);
  git(["-C", author, "commit", "-m", "seed"]);
  git(["-C", author, "remote", "add", "origin", remote]);
  git(["-C", author, "push", "-u", "origin", "main"]);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["clone", remote, checkout]);
  git(["-C", checkout, "config", "user.name", "AKM Test"]);
  git(["-C", checkout, "config", "user.email", "akm@example.test"]);
  return { remote, author, checkout, contentRoot: path.join(checkout, "content") };
}

function parsedRef(remote: string): ParsedGitRef {
  return { source: "git", ref: `git+${remote}#main`, id: `git:${remote}`, url: remote, requestedRef: "main" };
}

function resolvedRef(remote: string, revision: string) {
  return {
    id: `git:${remote}`,
    source: "git" as const,
    ref: `git+${remote}#main`,
    artifactUrl: remote,
    resolvedVersion: "main",
    resolvedRevision: revision,
  };
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cloneRepo: safe staging on failure", () => {
  test("leaves an existing destDir untouched when the remote is unreachable", () => {
    const destDir = makeTempDir("akm-clone-dest-");

    // Seed destDir with a sentinel file that proves the directory was already
    // populated before the failed clone attempt.
    const sentinelPath = path.join(destDir, "sentinel.txt");
    fs.writeFileSync(sentinelPath, "cached-content", "utf8");

    // A bogus git URL that will never succeed (no service listening on port 1).
    const bogusUrl = "git://127.0.0.1:1/nothing.git";

    // The clone must throw — network is down.
    expect(() => cloneRepo(bogusUrl, null, destDir)).toThrow();

    // Critical assertion: the previously-valid destDir must still be intact.
    expect(fs.existsSync(sentinelPath)).toBe(true);
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("cached-content");
  });

  test("does not leave orphaned temp dirs after a failed clone", () => {
    const parentDir = makeTempDir("akm-clone-parent-");
    const destDir = path.join(parentDir, "repo");
    // destDir does not pre-exist — fresh clone scenario.

    const bogusUrl = "git://127.0.0.1:1/nothing.git";

    expect(() => cloneRepo(bogusUrl, null, destDir)).toThrow();

    // Ensure no .tmp-* sibling was left behind.
    const siblings = fs.readdirSync(parentDir);
    const tmpSiblings = siblings.filter((f) => f.includes(".tmp-"));
    expect(tmpSiblings).toHaveLength(0);
  });
});

describe("classifyCloneFailure: credential redaction", () => {
  test("redacts embedded credentials in the reported clone URL", () => {
    const message = classifyCloneFailure(
      "https://token:super-secret@example.com/org/repo.git",
      "fatal: Authentication failed for 'https://token:super-secret@example.com/org/repo.git/'",
      undefined,
    );

    expect(message).toContain("https://[REDACTED]@example.com/org/repo.git");
    expect(message).not.toContain("super-secret");
    expect(message).not.toContain("token:");
  });

  test("redacts embedded credentials from fallback stderr detail", () => {
    const message = classifyCloneFailure(
      "https://token:super-secret@example.com/org/repo.git",
      "fatal: unable to access 'https://token:super-secret@example.com/org/repo.git/': TLS handshake failed",
      undefined,
    );

    expect(message).toContain("https://[REDACTED]@example.com/org/repo.git");
    expect(message).not.toContain("super-secret");
    expect(message).not.toContain("token:super-secret@");
  });
});

describe("writable Git checkout safety", () => {
  test("rejects a detached writable checkout requested by tag", () => {
    const fixture = makeWritableFixture();
    git(["-C", fixture.author, "tag", "v1"]);
    git(["-C", fixture.author, "push", "origin", "v1"]);
    git(["-C", fixture.checkout, "fetch", "origin", "tag", "v1"]);
    git(["-C", fixture.checkout, "checkout", "--detach", "v1"]);
    const revision = git(["-C", fixture.checkout, "rev-parse", "HEAD"]);
    const tagRef = { ...parsedRef(fixture.remote), ref: `git+${fixture.remote}#v1`, requestedRef: "v1" };

    expect(() =>
      syncExistingWritableCheckout(
        tagRef,
        { ...resolvedRef(fixture.remote, revision), ref: tagRef.ref, resolvedVersion: "v1" },
        fixture.contentRoot,
        "2026-01-01T00:00:00.000Z",
        [fixture.contentRoot],
      ),
    ).toThrow(/different branch|branch ref/i);
  });

  test("fast-forwards in place and retains the configured content root", () => {
    const fixture = makeWritableFixture();
    fs.writeFileSync(path.join(fixture.author, "content", "lessons", "seed.md"), "updated\n", "utf8");
    git(["-C", fixture.author, "add", "."]);
    git(["-C", fixture.author, "commit", "-m", "update"]);
    git(["-C", fixture.author, "push"]);
    const revision = git(["-C", fixture.author, "rev-parse", "HEAD"]);

    const result = syncExistingWritableCheckout(
      parsedRef(fixture.remote),
      resolvedRef(fixture.remote, revision),
      fixture.contentRoot,
      "2026-01-01T00:00:00.000Z",
      [fixture.contentRoot],
    );

    expect(result.contentDir).toBe(fixture.contentRoot);
    expect(result.resolvedRevision).toBe(revision);
    expect(fs.readFileSync(path.join(fixture.contentRoot, "lessons", "seed.md"), "utf8")).toBe("updated\n");
  });

  /** Commit `files` (path under content/ -> text) upstream and return the new revision. */
  function pushUpstream(fixture: { author: string }, files: Record<string, string>): string {
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(fixture.author, "content", rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, "utf8");
    }
    git(["-C", fixture.author, "add", "."]);
    git(["-C", fixture.author, "commit", "-m", "upstream"]);
    git(["-C", fixture.author, "push"]);
    return git(["-C", fixture.author, "rev-parse", "HEAD"]);
  }

  function update(fixture: { remote: string; contentRoot: string }, revision: string) {
    return syncExistingWritableCheckout(
      parsedRef(fixture.remote),
      resolvedRef(fixture.remote, revision),
      fixture.contentRoot,
      "2026-01-01T00:00:00.000Z",
    );
  }

  test("behind + unrelated unstaged edit fast-forwards and keeps the edit", () => {
    const fixture = makeWritableFixture();
    const edited = path.join(fixture.contentRoot, "lessons", "seed.md");
    fs.writeFileSync(edited, "local edit\n", "utf8");
    const revision = pushUpstream(fixture, { "lessons/new.md": "new\n" });

    expect(update(fixture, revision).resolvedRevision).toBe(revision);
    expect(fs.readFileSync(edited, "utf8")).toBe("local edit\n");
    expect(fs.readFileSync(path.join(fixture.contentRoot, "lessons", "new.md"), "utf8")).toBe("new\n");
    expect(git(["-C", fixture.checkout, "status", "--porcelain"])).toBe("M content/lessons/seed.md");
  });

  test("behind + unrelated staged edit fast-forwards and keeps the staged state", () => {
    const fixture = makeWritableFixture();
    const edited = path.join(fixture.contentRoot, "lessons", "seed.md");
    fs.writeFileSync(edited, "staged edit\n", "utf8");
    git(["-C", fixture.checkout, "add", "content/lessons/seed.md"]);
    const revision = pushUpstream(fixture, { "lessons/new.md": "new\n" });

    update(fixture, revision);
    expect(git(["-C", fixture.checkout, "rev-parse", "HEAD"])).toBe(revision);
    expect(fs.readFileSync(edited, "utf8")).toBe("staged edit\n");
    expect(git(["-C", fixture.checkout, "status", "--porcelain"])).toBe("M  content/lessons/seed.md");
  });

  test("refuses an incoming overwrite of an unstaged tracked edit without losing it", () => {
    const fixture = makeWritableFixture();
    const edited = path.join(fixture.contentRoot, "lessons", "seed.md");
    fs.writeFileSync(edited, "dirty work\n", "utf8");
    const before = git(["-C", fixture.checkout, "rev-parse", "HEAD"]);
    const revision = pushUpstream(fixture, { "lessons/seed.md": "upstream\n" });

    expect(() => update(fixture, revision)).toThrow(/cannot fast-forward without overwriting local work/);
    expect(fs.readFileSync(edited, "utf8")).toBe("dirty work\n");
    expect(git(["-C", fixture.checkout, "rev-parse", "HEAD"])).toBe(before);
  });

  test("refuses an incoming overwrite of a staged edit without losing it", () => {
    const fixture = makeWritableFixture();
    const edited = path.join(fixture.contentRoot, "lessons", "seed.md");
    fs.writeFileSync(edited, "staged work\n", "utf8");
    git(["-C", fixture.checkout, "add", "content/lessons/seed.md"]);
    const before = git(["-C", fixture.checkout, "rev-parse", "HEAD"]);
    const revision = pushUpstream(fixture, { "lessons/seed.md": "upstream\n" });

    expect(() => update(fixture, revision)).toThrow(/cannot fast-forward without overwriting local work/);
    expect(fs.readFileSync(edited, "utf8")).toBe("staged work\n");
    expect(git(["-C", fixture.checkout, "status", "--porcelain"])).toBe("M  content/lessons/seed.md");
    expect(git(["-C", fixture.checkout, "rev-parse", "HEAD"])).toBe(before);
  });

  test("refuses an incoming overwrite of an untracked file without losing it", () => {
    const fixture = makeWritableFixture();
    const local = path.join(fixture.contentRoot, "lessons", "new.md");
    fs.writeFileSync(local, "untracked work\n", "utf8");
    const before = git(["-C", fixture.checkout, "rev-parse", "HEAD"]);
    const revision = pushUpstream(fixture, { "lessons/new.md": "upstream\n" });

    expect(() => update(fixture, revision)).toThrow(fixture.contentRoot);
    expect(fs.readFileSync(local, "utf8")).toBe("untracked work\n");
    expect(git(["-C", fixture.checkout, "rev-parse", "HEAD"])).toBe(before);
  });

  test("refusal names the configured path, the blocking file and how to proceed", () => {
    const fixture = makeWritableFixture();
    fs.writeFileSync(path.join(fixture.contentRoot, "lessons", "seed.md"), "dirty work\n", "utf8");
    const revision = pushUpstream(fixture, { "lessons/seed.md": "upstream\n" });
    let error: (Error & { hint?: () => string | undefined }) | undefined;
    try {
      update(fixture, revision);
    } catch (err) {
      error = err as typeof error;
    }
    expect(error?.message).toContain(fixture.contentRoot);
    expect(error?.message).toContain("content/lessons/seed.md");
    expect(error?.hint?.()).toContain("akm bundle update");
    expect(error?.hint?.()).not.toContain("--help");
  });

  test("diverged history with dirty files refuses without merging, committing or pushing", () => {
    const fixture = makeWritableFixture();
    fs.writeFileSync(path.join(fixture.contentRoot, "lessons", "local.md"), "local commit\n", "utf8");
    git(["-C", fixture.checkout, "add", "."]);
    git(["-C", fixture.checkout, "commit", "-m", "local only"]);
    const localHead = git(["-C", fixture.checkout, "rev-parse", "HEAD"]);
    const edited = path.join(fixture.contentRoot, "lessons", "seed.md");
    fs.writeFileSync(edited, "dirty work\n", "utf8");
    const revision = pushUpstream(fixture, { "lessons/up.md": "upstream\n" });

    expect(() => update(fixture, revision)).toThrow(/local commits/);
    expect(git(["-C", fixture.checkout, "rev-parse", "HEAD"])).toBe(localHead);
    expect(git(["-C", fixture.checkout, "status", "--porcelain"])).toBe("M content/lessons/seed.md");
    expect(git(["--git-dir", fixture.remote, "rev-parse", "main"])).toBe(revision);
  });

  test("already current with dirty files is not refused and keeps the work", () => {
    const fixture = makeWritableFixture();
    const edited = path.join(fixture.contentRoot, "lessons", "seed.md");
    fs.writeFileSync(edited, "dirty work\n", "utf8");
    fs.writeFileSync(path.join(fixture.contentRoot, "lessons", "untracked.md"), "x\n", "utf8");
    const revision = git(["-C", fixture.checkout, "rev-parse", "HEAD"]);

    expect(update(fixture, revision).resolvedRevision).toBe(revision);
    expect(fs.readFileSync(edited, "utf8")).toBe("dirty work\n");
  });

  test("local ahead with dirty files is not refused and keeps the work", () => {
    const fixture = makeWritableFixture();
    fs.writeFileSync(path.join(fixture.contentRoot, "lessons", "local.md"), "local commit\n", "utf8");
    git(["-C", fixture.checkout, "add", "."]);
    git(["-C", fixture.checkout, "commit", "-m", "local only"]);
    const localHead = git(["-C", fixture.checkout, "rev-parse", "HEAD"]);
    const edited = path.join(fixture.contentRoot, "lessons", "seed.md");
    fs.writeFileSync(edited, "dirty work\n", "utf8");
    const remoteRevision = git(["-C", fixture.author, "rev-parse", "HEAD"]);

    expect(update(fixture, remoteRevision).resolvedRevision).toBe(localHead);
    expect(fs.readFileSync(edited, "utf8")).toBe("dirty work\n");
  });

  test("a wrong origin still refuses a dirty checkout untouched", () => {
    const fixture = makeWritableFixture();
    const edited = path.join(fixture.contentRoot, "lessons", "seed.md");
    fs.writeFileSync(edited, "dirty work\n", "utf8");
    git(["-C", fixture.checkout, "remote", "set-url", "origin", "https://example.org/other/repo.git"]);
    const revision = git(["-C", fixture.author, "rev-parse", "HEAD"]);

    expect(() => update(fixture, revision)).toThrow(/different origin/);
    expect(fs.readFileSync(edited, "utf8")).toBe("dirty work\n");
  });

  test("a failed fetch keeps local work and reports the failure", () => {
    const fixture = makeWritableFixture();
    const edited = path.join(fixture.contentRoot, "lessons", "seed.md");
    fs.writeFileSync(edited, "dirty work\n", "utf8");
    const revision = git(["-C", fixture.author, "rev-parse", "HEAD"]);
    fs.renameSync(fixture.remote, `${fixture.remote}.gone`);

    expect(() => update(fixture, revision)).toThrow(/could not fetch its expected origin/);
    expect(fs.readFileSync(edited, "utf8")).toBe("dirty work\n");
  });

  test("ahead with nothing to fast-forward (behind === 0) is a no-op, not a refusal", () => {
    const ahead = makeWritableFixture();
    fs.writeFileSync(path.join(ahead.contentRoot, "lessons", "local.md"), "local commit\n", "utf8");
    git(["-C", ahead.checkout, "add", "."]);
    git(["-C", ahead.checkout, "commit", "-m", "local only"]);
    const remoteRevision = git(["-C", ahead.author, "rev-parse", "HEAD"]);

    const result = syncExistingWritableCheckout(
      parsedRef(ahead.remote),
      resolvedRef(ahead.remote, remoteRevision),
      ahead.contentRoot,
      "2026-01-01T00:00:00.000Z",
    );

    expect(result.contentDir).toBe(ahead.contentRoot);
    expect(fs.existsSync(path.join(ahead.contentRoot, "lessons", "local.md"))).toBe(true);
  });

  test("still refuses when ahead AND behind (a real merge is needed)", () => {
    const both = makeWritableFixture();
    fs.writeFileSync(path.join(both.contentRoot, "lessons", "local.md"), "local commit\n", "utf8");
    git(["-C", both.checkout, "add", "."]);
    git(["-C", both.checkout, "commit", "-m", "local only"]);
    fs.writeFileSync(path.join(both.author, "content", "lessons", "upstream.md"), "upstream\n", "utf8");
    git(["-C", both.author, "add", "."]);
    git(["-C", both.author, "commit", "-m", "upstream commit"]);
    git(["-C", both.author, "push"]);
    const remoteRevision = git(["-C", both.author, "rev-parse", "HEAD"]);

    expect(() =>
      syncExistingWritableCheckout(
        parsedRef(both.remote),
        resolvedRef(both.remote, remoteRevision),
        both.contentRoot,
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow(/local commits/);
    expect(fs.existsSync(path.join(both.contentRoot, "lessons", "local.md"))).toBe(true);
  });

  test("rejects an upstream content-root removal before changing the checkout", () => {
    const fixture = makeWritableFixture();
    fs.rmSync(path.join(fixture.author, "content"), { recursive: true });
    fs.writeFileSync(path.join(fixture.author, "README.md"), "replacement\n", "utf8");
    git(["-C", fixture.author, "add", "-A"]);
    git(["-C", fixture.author, "commit", "-m", "remove content root"]);
    git(["-C", fixture.author, "push"]);
    const revision = git(["-C", fixture.author, "rev-parse", "HEAD"]);

    expect(() =>
      syncExistingWritableCheckout(
        parsedRef(fixture.remote),
        resolvedRef(fixture.remote, revision),
        fixture.contentRoot,
        "2026-01-01T00:00:00.000Z",
        [fixture.contentRoot],
      ),
    ).toThrow(/would remove configured content root/);
    expect(fs.readFileSync(path.join(fixture.contentRoot, "lessons", "seed.md"), "utf8")).toBe("seed\n");
  });

  test("rejects an upstream file that would overwrite ignored local content", () => {
    const fixture = makeWritableFixture();
    fs.appendFileSync(path.join(fixture.checkout, ".git", "info", "exclude"), "content/secrets/local.env\n");
    const localSecret = path.join(fixture.contentRoot, "secrets", "local.env");
    fs.mkdirSync(path.dirname(localSecret), { recursive: true });
    fs.writeFileSync(localSecret, "LOCAL SECRET\n", "utf8");
    expect(git(["-C", fixture.checkout, "check-ignore", "content/secrets/local.env"])).toBe(
      "content/secrets/local.env",
    );

    const upstreamSecret = path.join(fixture.author, "content", "secrets", "local.env");
    fs.mkdirSync(path.dirname(upstreamSecret), { recursive: true });
    fs.writeFileSync(upstreamSecret, "UPSTREAM VALUE\n", "utf8");
    git(["-C", fixture.author, "add", "."]);
    git(["-C", fixture.author, "commit", "-m", "add ignored collision"]);
    git(["-C", fixture.author, "push"]);
    const revision = git(["-C", fixture.author, "rev-parse", "HEAD"]);

    expect(() =>
      syncExistingWritableCheckout(
        parsedRef(fixture.remote),
        resolvedRef(fixture.remote, revision),
        fixture.contentRoot,
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow(/overwrite ignored local path/);
    expect(fs.readFileSync(localSecret, "utf8")).toBe("LOCAL SECRET\n");
    expect(git(["-C", fixture.checkout, "rev-parse", "HEAD"])).not.toBe(revision);
  });

  test("preserves ignored content created in the final pre-merge race window", () => {
    const fixture = makeWritableFixture();
    fs.appendFileSync(path.join(fixture.checkout, ".git", "info", "exclude"), "content/secrets/raced.env\n");
    const upstreamSecret = path.join(fixture.author, "content", "secrets", "raced.env");
    fs.mkdirSync(path.dirname(upstreamSecret), { recursive: true });
    fs.writeFileSync(upstreamSecret, "UPSTREAM VALUE\n", "utf8");
    git(["-C", fixture.author, "add", "."]);
    git(["-C", fixture.author, "commit", "-m", "add raced collision"]);
    git(["-C", fixture.author, "push"]);
    const revision = git(["-C", fixture.author, "rev-parse", "HEAD"]);
    const localSecret = path.join(fixture.contentRoot, "secrets", "raced.env");
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("git is required");
    const wrapperDir = makeTempDir("akm-git-wrapper-");
    const wrapper = path.join(wrapperDir, "git");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "merge" ]; then
    mkdir -p ${JSON.stringify(path.dirname(localSecret))}
    printf '%s\\n' 'RACED LOCAL SECRET' > ${JSON.stringify(localSecret)}
    break
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`,
      "utf8",
    );
    fs.chmodSync(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      expect(() =>
        syncExistingWritableCheckout(
          parsedRef(fixture.remote),
          resolvedRef(fixture.remote, revision),
          fixture.contentRoot,
          "2026-01-01T00:00:00.000Z",
        ),
      ).toThrow(/cannot fast-forward/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(fs.readFileSync(localSecret, "utf8")).toBe("RACED LOCAL SECRET\n");
    expect(git(["-C", fixture.checkout, "rev-parse", "HEAD"])).not.toBe(revision);
  });

  test("mutation preparation warns instead of refusing pre-existing unpushed commits", () => {
    const fixture = makeWritableFixture();
    fs.writeFileSync(path.join(fixture.contentRoot, "lessons", "local.md"), "local commit\n", "utf8");
    git(["-C", fixture.checkout, "add", "."]);
    git(["-C", fixture.checkout, "commit", "-m", "local only"]);

    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const prepared = prepareWriteTargetForMutation({
        source: {
          kind: "git",
          name: "team",
          path: fixture.contentRoot,
          repoPath: fixture.checkout,
          adapterId: "akm",
        },
        config: { type: "git", name: "team", path: fixture.contentRoot, writable: true },
      });
      expect(prepared.source.path).toBe(fixture.contentRoot);
      expect(warnings.some((w) => w.includes("unpushed commit"))).toBe(true);
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });

  test("writable cache ids remain distinct after slug sanitization", () => {
    const cache = makeTempDir("akm-cache-identity-");
    expect(buildInstallCacheDir(cache, "git", "github:foo/bar-baz", "writable")).not.toBe(
      buildInstallCacheDir(cache, "git", "github:foo-bar/baz", "writable"),
    );
  });
});

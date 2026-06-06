// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliCapture } from "./_helpers/cli";

// ── Environment helpers ──────────────────────────────────────────────────────

const originalGithubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalFetch = globalThis.fetch;
const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-submit-cli-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubToken;
  if (originalGhToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalGhToken;
  for (const dir of createdTmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── submit --help ─────────────────────────────────────────────────────────────

describe("akm submit --help", () => {
  test("lists metrics, registry, and feedback subcommands", async () => {
    const result = await runCliCapture(["submit", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("metrics");
    expect(result.stdout).toContain("registry");
    expect(result.stdout).toContain("feedback");
  });
});

// ── submit feedback ─────────────────────────────────────────────────────────

describe("akm submit feedback", () => {
  test("--dry-run prints payload with feedback label and target repo, no network call", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;

    const result = await runCliCapture([
      "submit",
      "feedback",
      "--dry-run",
      "--title",
      "Docs typo",
      "--body",
      "There is a typo in setup.",
    ]);

    expect(result.code).toBe(0);
    expect(fetchCalled).toBe(false);
    const payload = JSON.parse(result.stdout);
    expect(payload.dryRun).toBe(true);
    expect(payload.title).toBe("Docs typo");
    expect(payload.body).toBe("There is a typo in setup.");
    expect(payload.labels).toEqual(["feedback"]);
    expect(payload.repo).toBe("itlackey/akm");
  });

  test("creates an issue against a mocked GitHub API and surfaces the issue URL", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token";
    let captured: { url: string; body: unknown } | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured = { url, body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({ number: 42, html_url: "https://github.com/itlackey/akm/issues/42", title: "Docs typo" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await runCliCapture(["submit", "feedback", "--title", "Docs typo", "--body", "Body here"]);

    expect(result.code).toBe(0);
    expect(captured?.url).toContain("/repos/itlackey/akm/issues");
    expect((captured?.body as { labels: string[] }).labels).toEqual(["feedback"]);
    const payload = JSON.parse(result.stdout);
    expect(payload.number).toBe(42);
    expect(payload.url).toBe("https://github.com/itlackey/akm/issues/42");
    expect(payload.labels).toEqual(["feedback"]);
  });

  test("fails with a clear error and non-zero exit when title is missing", async () => {
    const result = await runCliCapture(["submit", "feedback", "--body", "no title"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("title is required");
  });

  test("surfaces a clear non-zero error when the GitHub API rejects the request", async () => {
    // Set a token so the request reaches the API; the API then rejects it.
    // (The pure no-token path is covered deterministically in github.test.ts,
    // where `gh auth token` is mocked; here a real `gh` may supply a token.)
    process.env.GITHUB_TOKEN = "ghp_test_token";
    globalThis.fetch = (async () => new Response("Bad credentials", { status: 401 })) as unknown as typeof fetch;
    const result = await runCliCapture(["submit", "feedback", "--title", "X", "--body", "Y", "--repo", "o/r"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("401");
  });

  test("rejects a malformed --repo", async () => {
    const result = await runCliCapture(["submit", "feedback", "--title", "X", "--repo", "not-a-repo"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Invalid --repo");
  });
});

// ── submit registry ─────────────────────────────────────────────────────────

describe("akm submit registry", () => {
  test("writes a structured entry with derived source to the manual-entries file", async () => {
    const dir = createTmpDir();
    const out = path.join(dir, "manual-entries.json");
    const result = await runCliCapture([
      "submit",
      "registry",
      "npm:@scope/my-stash",
      "--name",
      "My Stash",
      "--description",
      "A stash",
      "--out",
      out,
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.added).toBe(true);
    expect(payload.entry.source).toBe("npm");
    expect(payload.entry.ref).toBe("npm:@scope/my-stash");

    const onDisk = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(onDisk.stashes).toHaveLength(1);
    expect(onDisk.stashes[0].name).toBe("My Stash");
    expect(onDisk.stashes[0].id).toBe("npm:@scope/my-stash");
  });

  test("replaces an existing entry with the same id (idempotent upsert)", async () => {
    const dir = createTmpDir();
    const out = path.join(dir, "manual-entries.json");
    await runCliCapture(["submit", "registry", "npm:pkg", "--name", "First", "--out", out]);
    const result = await runCliCapture(["submit", "registry", "npm:pkg", "--name", "Second", "--out", out]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.replaced).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(onDisk.stashes).toHaveLength(1);
    expect(onDisk.stashes[0].name).toBe("Second");
  });

  test("fails with a clear error when the source cannot be determined", async () => {
    const dir = createTmpDir();
    const out = path.join(dir, "manual-entries.json");
    const result = await runCliCapture(["submit", "registry", "no-prefix-ref", "--out", out]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--source");
  });
});

// ── submit metrics (feature-gated stub) ──────────────────────────────────────

describe("akm submit metrics", () => {
  test("fails with a clear not-available error when flags are missing", async () => {
    const result = await runCliCapture(["submit", "metrics"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not available");
  });

  test("still fails (no silent send) even when endpoint and opt-in are provided", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runCliCapture(["submit", "metrics", "--endpoint", "https://example.com/ingest", "--opt-in"]);
    expect(result.code).toBe(2);
    expect(fetchCalled).toBe(false);
  });
});

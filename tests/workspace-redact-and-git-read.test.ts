// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Pure helpers behind the workspace operations: config redaction and the git reads. */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { isSecretKey, redactUrlCredentials } from "../src/core/redaction";
import { readBundleGitStatus, readRecentCommits } from "../src/workspace/git-read";
import { redactForUi, scrubUrlCredentials } from "../src/workspace/redact";
import { git, makeGitRepo } from "./_helpers/git";

// biome-ignore lint/suspicious/noExplicitAny: redacted trees are asserted field by field below
type Json = Record<string, any>;

describe("redactForUi", () => {
  test("masks secret-like string values by key, keeps symbolic references and numbers", () => {
    const redacted = redactForUi({
      connections: {
        a: { apiKey: "sk-live-1", apiKeyFile: "/run/key", maxTokens: 4096, model: "m" },
        b: { apiKey: "$B_KEY", credential: "${secrets/deploy}" },
      },
      webhookToken: "tok",
      password: "pw",
      authorization: "Bearer x",
    }) as Json;
    expect(redacted.connections.a.apiKey).toBe("[redacted]");
    expect(redacted.connections.a.maxTokens).toBe(4096);
    expect(redacted.connections.a.model).toBe("m");
    expect(redacted.connections.b).toEqual({ apiKey: "$B_KEY", credential: "${secrets/deploy}" });
    expect(redacted.webhookToken).toBe("[redacted]");
    expect(redacted.password).toBe("[redacted]");
    expect(redacted.authorization).toBe("[redacted]");
  });

  test("masks every value under an env or secrets key", () => {
    const redacted = redactForUi({ run: { env: { FOO: "bar", N: 3, ok: true } }, secrets: ["a", "b"] }) as Json;
    expect(redacted.run.env).toEqual({ FOO: "[redacted]", N: "[redacted]", ok: "[redacted]" });
    expect(redacted.secrets).toEqual(["[redacted]", "[redacted]"]);
  });
});

describe("URL credentials", () => {
  test("userinfo and credential query parameters are masked; other URLs are untouched", () => {
    expect(redactUrlCredentials("https://user:pw@example.com/path")).toBe("https://example.com/path");
    expect(redactUrlCredentials("https://example.com/v1?token=abc&q=1")).toBe(
      "https://example.com/v1?token=%5Bredacted%5D&q=1",
    );
    expect(redactUrlCredentials("https://example.com/v1?q=1")).toBe("https://example.com/v1?q=1");
    expect(redactUrlCredentials("not a url")).toBe("not a url");
  });

  test("scrubUrlCredentials finds URLs inside longer strings, at any depth", () => {
    const scrubbed = scrubUrlCredentials({
      a: [{ b: "llm default: https://h.test/x?api_key=SECRET (see docs)" }],
      n: 1,
    });
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
    expect(JSON.stringify(scrubbed)).toContain("llm default: https://h.test/x?api_key=");
  });

  test("environment variable names that hold credentials are recognised, and config keys that only contain a word are not", () => {
    expect(isSecretKey("AKM_LLM_API_KEY", "")).toBe(true);
    expect(isSecretKey("AKM_BUNDLE_DIR", "")).toBe(false);
    for (const key of ["tokenizer", "prompt_cache_key", "monkey-small"]) expect(isSecretKey(key, "x")).toBe(false);
    expect(isSecretKey("maxTokens", 64)).toBe(false);
    expect(isSecretKey("headers_token", "x")).toBe(true);
    for (const key of ["accesstoken", "clientsecret", "dbpassword", "secretkey"])
      expect(isSecretKey(key, "x")).toBe(true);
    expect((redactForUi({ models: { "token-small": "m" }, token: "t" }) as Json).models["token-small"]).toBe("m");
  });
});

describe("a git read that fails is reported, not read as a pristine repository", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = () => makeGitRepo({ register: (dir) => made.push(dir) });

  test("a .git that git cannot open carries git's own message, in status and in history", async () => {
    const dir = repo();
    fs.rmSync(`${dir}/.git`, { recursive: true });
    fs.mkdirSync(`${dir}/.git`);
    const status = await readBundleGitStatus(dir);
    expect(status?.error).toContain("not a git repository");
    expect((await readRecentCommits(dir, 5))?.error).toContain("not a git repository");
    expect((await readRecentCommits(dir, 5))?.commits).toEqual([]);
  });

  test("history lists each commit's own sha, author, date and subject, and judges no origin from the subject", async () => {
    const dir = repo();
    fs.writeFileSync(`${dir}/note.md`, "x\n");
    git(dir, ["add", "note.md"]);
    git(dir, ["commit", "-q", "-m", "Remember to rotate the key"]);
    const read = await readRecentCommits(dir, 1);
    const commit = read?.commits[0];
    expect(commit).toMatchObject({ subject: "Remember to rotate the key", paths: ["note.md"], pathCount: 1 });
    expect(commit?.author).toBeTruthy();
    expect(Date.parse(commit?.time ?? "")).not.toBeNaN();
    expect(commit).not.toHaveProperty("origin");
  });

  test("a detached HEAD and a repository with no commits are answers, not failures", async () => {
    const dir = repo();
    git(dir, ["checkout", "-q", "--detach"]);
    expect(await readBundleGitStatus(dir)).toMatchObject({ error: null, branch: null, uncommitted: 0 });
    const empty = makeGitRepo({ register: (d) => made.push(d) });
    git(empty, ["update-ref", "-d", "HEAD"]);
    fs.rmSync(`${empty}/.git/refs/heads`, { recursive: true, force: true });
    fs.mkdirSync(`${empty}/.git/refs/heads`);
    expect(await readBundleGitStatus(empty)).toMatchObject({ error: null, lastCommit: null });
    expect(await readRecentCommits(empty, 5)).toEqual({ commits: [], error: null });
  });
});

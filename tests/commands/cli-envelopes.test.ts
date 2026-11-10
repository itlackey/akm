// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProposal } from "../../src/commands/proposal/repository";
import { isSkippableBundleUpdateLock } from "../../src/commands/sources/bundle-cli";
import { TransientError, UsageError } from "../../src/core/errors";
import { slugForPath } from "../../src/indexer/installations";
import { runCliStatus as runCli, runCliStatusWithBundleDir } from "../_helpers/cli";
import { durableItemRef } from "../_helpers/durable-ref";
import { installFakeOpencodeRuntime } from "../_helpers/fake-opencode-runtime";
import {
  type Cleanup,
  makeSandboxDir,
  type SandboxedDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
  writeSandboxConfig,
} from "../_helpers/sandbox";

describe("secret-cli-envelope", () => {
  const SECRET_VALUE = "super-secret-token-value";

  let stashCleanup: Cleanup = () => {};
  let stashDir = "";

  function seedSecret(name: string): string {
    const dir = path.join(stashDir, "secrets");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}`);
    fs.writeFileSync(file, SECRET_VALUE);
    return file;
  }

  beforeEach(() => {
    const stash = sandboxStashDir();
    stashDir = stash.dir;
    stashCleanup = stash.cleanup;
    writeSandboxConfig({ semanticSearchMode: "off" });
  });

  afterEach(() => {
    stashCleanup();
    stashCleanup = () => {};
    stashDir = "";
  });

  describe("akm secret — JSON envelope", () => {
    test("secret list: envelope wraps refs under `secrets`; the value never appears", async () => {
      seedSecret("deploy-key");
      const { stdout, status } = await runCli(["secret", "list"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(Array.isArray(env.secrets)).toBe(true);
      const entry = env.secrets.find((s: { ref: string }) => s.ref === "secrets/deploy-key");
      expect(entry).toBeDefined();
      // The whole file IS the value — it must never leak into structured output.
      expect(stdout).not.toContain(SECRET_VALUE);
    });
  });
});

describe("observability-cli-envelope", () => {
  let stashCleanup: Cleanup = () => {};

  beforeEach(() => {
    // Chain sandboxXdgDataHome onto sandboxStashDir so `index.db` (which lives
    // under XDG_DATA_HOME, see src/core/paths.ts:getDataDir) is isolated
    // per-test too — not just AKM_BUNDLE_DIR.
    const stash = sandboxStashDir();
    const data = sandboxXdgDataHome(stash.cleanup);
    stashCleanup = data.cleanup;
    writeSandboxConfig({ semanticSearchMode: "off" });
  });

  afterEach(() => {
    stashCleanup();
    stashCleanup = () => {};
  });

  describe("akm observability cluster — JSON envelope", () => {
    test("log: success envelope carries events array + totalCount + nextOffset", async () => {
      const { stdout, status } = await runCli(["log"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(Array.isArray(env.events)).toBe(true);
      expect(typeof env.totalCount).toBe("number");
      expect(typeof env.nextOffset).toBe("number");
    });

    test("hints: prints the short guide; --detail is accepted and ignored", async () => {
      const bare = await runCli(["hints"]);
      const short = await runCli(["hints", "--detail", "brief"]);
      const full = await runCli(["hints", "--detail", "full"]);
      expect(bare.status).toBe(0);
      expect(short.status).toBe(0);
      expect(full.status).toBe(0);
      expect(bare.stdout).toBe(short.stdout);
      expect(bare.stdout).toBe(full.stdout);
    });
  });
});

describe("env-cli-envelope", () => {
  let stashCleanup: Cleanup = () => {};
  let stashDir = "";

  beforeEach(() => {
    const stash = sandboxStashDir();
    stashDir = stash.dir;
    stashCleanup = stash.cleanup;
    writeSandboxConfig({ semanticSearchMode: "off" });
  });

  afterEach(() => {
    stashCleanup();
    stashCleanup = () => {};
    stashDir = "";
    delete process.env.AKM_TEST_ENV_VALUE;
  });

  describe("akm env — JSON envelope", () => {
    test("env create: success envelope carries the env ref", async () => {
      const { stdout, status } = await runCli(["env", "create", "env/prod"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.ref).toBe("env/prod");
      expect(fs.existsSync(path.join(stashDir, "env", "prod.env"))).toBe(true);
    });

    test("env list: envelope wraps entries under `envs` with key NAMES but no values", async () => {
      fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
      fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_URL=https://example\nTOKEN=topsecret-value\n");
      const { stdout, status } = await runCli(["env", "list"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(Array.isArray(env.envs)).toBe(true);
      const prod = env.envs.find((e: { ref: string }) => e.ref === "env/prod");
      expect(prod).toBeDefined();
      expect(prod.keys).toEqual(["API_URL", "TOKEN"]);
      // VALUE must never appear in structured output.
      expect(stdout).not.toContain("topsecret-value");
      expect(stdout).not.toContain("https://example");
    });

    test("env remove: envelope carries ref + removed=true (with --yes)", async () => {
      fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
      fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "TOKEN=topsecret-value\n");
      const { stdout, status } = await runCli(["env", "remove", "env/prod", "--yes"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.ref).toBe("env/prod");
      expect(env.removed).toBe(true);
      expect(stdout).not.toContain("topsecret-value");
      expect(fs.existsSync(path.join(stashDir, "env", "prod.env"))).toBe(false);
    });
  });
});

describe("stash-cli-envelope", () => {
  let envCleanup: Cleanup = () => {};

  beforeEach(() => {
    const dataResult = sandboxXdgDataHome();
    const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const stashResult = sandboxStashDir(cfgResult.cleanup);
    envCleanup = stashResult.cleanup;
    writeSandboxConfig({ semanticSearchMode: "off" });
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
  });

  describe("akm stash-lifecycle cluster — JSON envelope", () => {
    test("info: success envelope carries version + assetTypes array (exit 0)", async () => {
      const { stdout, status } = await runCli(["info"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(typeof env.version).toBe("string");
      expect(Array.isArray(env.assetTypes)).toBe(true);
      expect(typeof env.schemaVersion).toBe("number");
    });

    test("index --enrich / --re-enrich (removed flags): an unknown-flag usage error (exit 2)", async () => {
      for (const flag of ["--enrich", "--re-enrich"]) {
        const { stderr, status } = await runCli(["index", flag]);
        expect(status, flag).toBe(2);
        expect(stderr, flag).toContain(`Unknown flag "${flag}"`);
      }
    });

    test("import --name with '/': assertFlatAssetName → {ok:false} usage envelope on stderr (exit 2)", async () => {
      const { stderr, status } = await runCli(["import", "-", "--name", "nested/bad"]);
      expect(status).toBe(2);
      const env = JSON.parse(stderr);
      expect(env.ok).toBe(false);
      expect(typeof env.code).toBe("string");
    });
  });
});

describe("config-cli-envelope", () => {
  let stashCleanup: Cleanup = () => {};

  beforeEach(() => {
    const stash = sandboxStashDir();
    stashCleanup = stash.cleanup;
    writeSandboxConfig({ semanticSearchMode: "off" });
  });

  afterEach(() => {
    stashCleanup();
    stashCleanup = () => {};
  });

  describe("akm config — JSON envelope", () => {
    test("config list: success envelope carries config v2 engine/strategy semantics", async () => {
      const { stdout, status } = await runCli(["config", "list"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.semanticSearchMode).toBe("off");
      expect(env.profiles).toBeUndefined();
      // #918: every success envelope carries ok:true, matching the {ok:false,...}
      // shape a failure throws before output() is reached.
      expect(env.ok).toBe(true);
    });

    test("config get: returns the requested key value", async () => {
      const { stdout, status } = await runCli(["config", "get", "semanticSearchMode"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env).toBe("off");
    });

    test("config set: persists and dumps the merged config", async () => {
      const { stdout, status } = await runCli(["config", "set", "semanticSearchMode", "auto"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.semanticSearchMode).toBe("auto");
      // #918: `ok: true` alongside the config dump so a caller branching on
      // `.ok` no longer reads a successful set as a failure.
      expect(env.ok).toBe(true);
    });

    test("config unset: persists and dumps the merged config with ok:true", async () => {
      await runCli(["config", "set", "--silent", "semanticSearchMode", "auto"]);
      const { stdout, status } = await runCli(["config", "unset", "semanticSearchMode"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.ok).toBe(true);
      expect(env.semanticSearchMode).toBe("off"); // falls back to DEFAULT_CONFIG
    });

    test("config set --silent: suppresses the post-write dump entirely (empty stdout, exit 0)", async () => {
      const { stdout, status } = await runCli(["config", "set", "semanticSearchMode", "auto", "--silent"]);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("");
    });

    test("config unset --silent: suppresses the post-write dump entirely (empty stdout, exit 0)", async () => {
      await runCli(["config", "set", "--silent", "semanticSearchMode", "auto"]);
      const { stdout, status } = await runCli(["config", "unset", "semanticSearchMode", "--silent"]);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("");
    });

    test("config path: prints the bare config file path", async () => {
      const { stdout, status } = await runCli(["config", "path"]);
      expect(status).toBe(0);
      expect(stdout.trim()).toContain("config.json");
    });
  });
});

describe("proposal-cli-envelope", () => {
  const disposers: SandboxedDir[] = [];

  afterEach(() => {
    for (const d of disposers.splice(0)) d.cleanup();
  });

  function makeStashDir(): string {
    const d = makeSandboxDir("akm-proposal-envelope-");
    disposers.push(d);
    for (const sub of ["lessons", "skills", "memories", "knowledge"]) {
      fs.mkdirSync(path.join(d.dir, sub), { recursive: true });
    }
    const bundleId = slugForPath(d.dir);
    writeSandboxConfig({
      bundles: { [bundleId]: { path: d.dir, writable: true } },
      defaultBundle: bundleId,
    });
    return d.dir;
  }

  const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos\n---\n\nPrefer rg.\n`;

  function seedProposal(stash: string, ref = "lessons/rg-over-grep"): string {
    const result = createProposal(stash, {
      ref,
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    return result.id;
  }

  describe("akm proposal — JSON envelope", () => {
    test("proposal list: envelope shape is pinned (success path)", async () => {
      const stash = makeStashDir();
      seedProposal(stash);
      const { stdout, status } = await runCliStatusWithBundleDir(["proposal", "list"], stash);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      // Pin the top-level shape (keys + types) without binding to the volatile id.
      expect(env.totalCount).toBe(1);
      expect(Array.isArray(env.proposals)).toBe(true);
      const [p] = env.proposals;
      expect(p.ref).toBe(durableItemRef(stash, "lesson", "rg-over-grep"));
      expect(p.source).toBe("reflect");
      expect(p.status).toBe("pending");
    });

    test("proposal list: invalid --status → byte-identical {ok:false} error envelope on stderr", async () => {
      const stash = makeStashDir();
      const { stderr, status } = await runCliStatusWithBundleDir(["proposal", "list", "--status", "bogus"], stash);
      expect(status).toBe(2);
      const env = JSON.parse(stderr);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("INVALID_FLAG_VALUE");
      expect(env.error).toBe(
        'Invalid --status value: "bogus". Expected one of: pending, accepted, rejected, reverted.',
      );
    });

    test("proposal show: envelope carries proposal + validation report", async () => {
      const stash = makeStashDir();
      const id = seedProposal(stash);
      const { stdout, status } = await runCliStatusWithBundleDir(["proposal", "show", id], stash);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.proposal.id).toBe(id);
      expect(env.proposal.ref).toBe(durableItemRef(stash, "lesson", "rg-over-grep"));
      expect(env.validation.ok).toBe(true);
    });

    test("proposal accept: success envelope materialises asset", async () => {
      const stash = makeStashDir();
      const id = seedProposal(stash);
      const { stdout, status } = await runCliStatusWithBundleDir(["proposal", "accept", id], stash);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.ok).toBe(true);
      expect(fs.existsSync(env.assetPath as string)).toBe(true);
    });
  });
});

describe("bundle-cli-envelope", () => {
  let envCleanup: Cleanup = () => {};
  const createdTmpDirs: string[] = [];

  beforeEach(() => {
    const dataResult = sandboxXdgDataHome();
    const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const stashResult = sandboxStashDir(cfgResult.cleanup);
    envCleanup = stashResult.cleanup;
    writeSandboxConfig({ semanticSearchMode: "off" });
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
    for (const dir of createdTmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("akm bundle group — JSON envelope snapshot (S7)", () => {
    test("update --skip-if-locked recognizes only update-relevant transient lock failures (#976)", () => {
      for (const code of ["INDEX_DB_CONTENDED", "STATE_DB_CONTENDED"] as const) {
        expect(isSkippableBundleUpdateLock(new TransientError("busy", code))).toBe(true);
      }
      expect(isSkippableBundleUpdateLock(new TransientError("busy", "IMPROVE_LOCK_HELD"))).toBe(false);
      expect(isSkippableBundleUpdateLock(new UsageError("bad input"))).toBe(false);
    });

    test("create: success envelope carries bundleDir + created + bundle-create shape (exit 0)", async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bundle-create-"));
      createdTmpDirs.push(parent);
      const stashDir = path.join(parent, "newstash");
      const { stdout, status } = await runCli(["bundle", "create", "--dir", stashDir]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.bundleDir).toBe(stashDir);
      expect(env.created).toBe(true);
      expect(env.shape).toBe("bundle-create");
      expect(fs.existsSync(path.join(stashDir, "lessons"))).toBe(true);
    });

    test("list: success envelope carries sources array + totalSources + list shape", async () => {
      const { stdout, status } = await runCli(["bundle", "list"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(Array.isArray(env.sources)).toBe(true);
      expect(typeof env.totalSources).toBe("number");
      expect(env.shape).toBe("list");
    });

    test("list --kind <valid>: filter is accepted (exit 0, list shape)", async () => {
      const { stdout, status } = await runCli(["bundle", "list", "--kind", "filesystem"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.shape).toBe("list");
      expect(Array.isArray(env.sources)).toBe(true);
    });

    test("list --kind <bogus>: parseKindFilter → {ok:false} usage envelope on stderr (exit 2)", async () => {
      const { stderr, status } = await runCli(["bundle", "list", "--kind", "bogus"]);
      expect(status).toBe(2);
      const env = JSON.parse(stderr);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("INVALID_FLAG_VALUE");
      expect(env.error).toMatch(/Invalid --kind value/);
    });

    test("show <name>: not found → {ok:false} not-found envelope on stderr (exit 1)", async () => {
      const { stderr, status } = await runCli(["bundle", "show", "does-not-exist"]);
      expect(status).toBe(1);
      const env = JSON.parse(stderr);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("SOURCE_NOT_FOUND");
    });
  });
});

describe("contribute-cli-envelope", () => {
  let stashCleanup: Cleanup = () => {};

  beforeEach(() => {
    const stash = sandboxStashDir();
    stashCleanup = stash.cleanup;
    writeSandboxConfig({ semanticSearchMode: "off" });
  });

  afterEach(() => {
    stashCleanup();
    stashCleanup = () => {};
  });

  describe("akm contribution cluster — JSON envelope", () => {
    test("agent (nothing configured): {ok:false} AGENT_NOT_CONFIGURED naming `akm setup` on stderr", async () => {
      const { stderr, status } = await withEnv({ PATH: "" }, () => runCli(["agent"]));
      expect(status).not.toBe(0);
      const env = JSON.parse(stderr);
      expect(env).toMatchObject({ ok: false, code: "AGENT_NOT_CONFIGURED" });
      expect(env.hint).toContain("akm setup");
    });

    test("agent (a connection configured, no prompt): nothing to start, so a usage envelope naming --prompt and a harness (exit 2)", async () => {
      writeSandboxConfig({
        semanticSearchMode: "off",
        connections: { lab: { endpoint: "http://127.0.0.1:1/v1", models: { fast: "fixture" } } },
      });
      const host = installFakeOpencodeRuntime({ reply: () => "hello" });
      const { stderr, status } = await withEnv({ PATH: "" }, () => runCli(["agent"]));
      expect(status).toBe(2);
      const env = JSON.parse(stderr);
      expect(env).toMatchObject({ ok: false, code: "MISSING_REQUIRED_ARGUMENT" });
      expect(env.error).toMatch(/connection.*--prompt.*harness/is);
      // No billed empty turn.
      expect(host.calls).toHaveLength(0);
    });

    test("agent --prompt (a connection configured): runs on akm's own runtime, with no binary or PATH check (exit 0)", async () => {
      writeSandboxConfig({
        semanticSearchMode: "off",
        connections: { lab: { endpoint: "http://127.0.0.1:1/v1", models: { fast: "fixture" } } },
      });
      const host = installFakeOpencodeRuntime({ reply: () => "hello" });
      const { stdout, status } = await withEnv({ PATH: "" }, () => runCli(["agent", "--prompt", "say hello"]));
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env).toMatchObject({ ok: true, engine: "lab", stdout: "hello" });
      expect(host.calls).toHaveLength(1);
    });

    test("lint: success envelope carries fixed/flagged arrays + summary (exit 0)", async () => {
      const { stdout, status } = await runCli(["lint"]);
      expect(status).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.ok).toBe(true);
      expect(Array.isArray(env.fixed)).toBe(true);
      expect(Array.isArray(env.flagged)).toBe(true);
      expect(typeof env.summary).toBe("object");
      expect(typeof env.summary.flagged).toBe("number");
    });

    test("proposal new (missing args): {ok:false} usage envelope on stderr (exit 2)", async () => {
      const { stderr, status } = await runCli(["proposal", "new"]);
      expect(status).toBe(2);
      const env = JSON.parse(stderr);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
      expect(env.error).toMatch(/Usage: akm proposal new/);
    });

    test("proposal new (both --task and --file): {ok:false} INVALID_FLAG_VALUE on stderr (exit 2)", async () => {
      const { stderr, status } = await runCli([
        "proposal",
        "new",
        "skill",
        "demo",
        "--task",
        "do a thing",
        "--file",
        "/tmp/does-not-matter.txt",
      ]);
      expect(status).toBe(2);
      const env = JSON.parse(stderr);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("INVALID_FLAG_VALUE");
      expect(env.error).toMatch(/exactly one of --task or --file/);
    });

    test("proposal new (--file that does not exist): {ok:false} FILE_NOT_FOUND on stderr (exit 1, not 70)", async () => {
      const { stderr, status } = await runCli([
        "proposal",
        "new",
        "skill",
        "demo",
        "--file",
        "/nonexistent/akm-task.txt",
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stderr)).toMatchObject({ ok: false, code: "FILE_NOT_FOUND" });
    });
  });
});

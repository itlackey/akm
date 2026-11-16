// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration (ORG-03/04/05/06): opens the real index database via `akm index`.
 *
 * `akm bundle create` writes a `.gitignore` listing `env/` and `secrets/` so
 * credentials are never committed. The indexer walker skips git-ignored files,
 * which used to leave env and secret assets of a default bundle out of the
 * index (`akm show env/<name>` found nothing while `env list` / `env run`
 * worked). The walker now indexes files under `env/` and `secrets/` even when
 * git ignores them; values stay out of the index (key names / names only).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setSecret } from "../../../src/commands/env/secret";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../../src/llm/embedder";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../../_helpers/sandbox";

const ENV_VALUE = "postgres://user:hunter2-do-not-leak@db.internal/app";
const SECRET_VALUE = "correct-horse-battery-staple-secret-do-not-leak";

const disposers: SandboxedDir[] = [];

function makeTempDir(prefix: string): string {
  const d = makeSandboxDir(prefix);
  disposers.push(d);
  return d.dir;
}

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

describe("git-ignored env/ and secrets/ are indexed", () => {
  test("a bundle made by `akm bundle create` finds its env and secret assets by `akm show`", async () => {
    const bundleDir = path.join(makeTempDir("akm-env-ignored-bundle-"), "bundle");

    await withEnv(
      {
        AKM_BUNDLE_DIR: bundleDir,
        HOME: makeTempDir("akm-env-ignored-home-"),
        XDG_CONFIG_HOME: makeTempDir("akm-env-ignored-config-"),
        XDG_CACHE_HOME: makeTempDir("akm-env-ignored-cache-"),
        XDG_DATA_HOME: makeTempDir("akm-env-ignored-data-"),
        XDG_STATE_HOME: makeTempDir("akm-env-ignored-state-"),
      },
      async () => {
        clearEmbeddingCache();
        resetLocalEmbedder();
        writeSandboxConfig({ semanticSearchMode: "off" });

        const created = await runCliCapture(["bundle", "create"]);
        expect(created.code).toBe(0);

        // The default scaffold ignores both directories.
        const gitignore = fs.readFileSync(path.join(bundleDir, ".gitignore"), "utf8");
        expect(gitignore).toContain("env/");
        expect(gitignore).toContain("secrets/");

        fs.mkdirSync(path.join(bundleDir, "env"), { recursive: true });
        fs.writeFileSync(path.join(bundleDir, "env", "staging.env"), `DATABASE_URL=${ENV_VALUE}\nLOG_LEVEL=debug\n`);
        setSecret(path.join(bundleDir, "secrets", "deploy-key"), Buffer.from(SECRET_VALUE));

        // Both files really are git-ignored.
        for (const rel of ["env/staging.env", "secrets/deploy-key"]) {
          const ignored = spawnSync("git", ["check-ignore", "-q", rel], { cwd: bundleDir });
          expect(ignored.status).toBe(0);
        }

        const indexed = await runCliCapture(["index", "--full"]);
        expect(indexed.code).toBe(0);

        const shownEnv = await runCliCapture(["show", "env/staging", "--format=json"]);
        expect(shownEnv.code).toBe(0);
        expect(shownEnv.stdout).toContain("DATABASE_URL");
        expect(shownEnv.stdout).toContain("LOG_LEVEL");
        expect(shownEnv.stdout).not.toContain(ENV_VALUE);

        const searchedEnv = await runCliCapture(["search", "--type", "env", "--format=json"]);
        expect(searchedEnv.code).toBe(0);
        const envHits = (JSON.parse(searchedEnv.stdout) as { hits: Array<{ ref?: string }> }).hits;
        expect(envHits.some((hit) => hit.ref?.endsWith("env/staging"))).toBe(true);

        const shownSecret = await runCliCapture(["show", "secrets/deploy-key", "--format=json"]);
        expect(shownSecret.code).toBe(0);
        expect(shownSecret.stdout).toContain("deploy-key");
        expect(shownSecret.stdout).not.toContain(SECRET_VALUE);
      },
    );
  });
});

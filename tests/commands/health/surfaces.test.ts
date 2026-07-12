// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 08 "surfaces" advisory group for `akm health` (secret-file-perms,
 * binary-config-skew, orphan-stores, egress-endpoints). Every collector is
 * silent (`undefined`) when there is nothing to report, mirroring the shipped
 * `stash-git-exposure` advisory; only `egress-endpoints` emits a pass-status
 * informational entry whenever any remote endpoint is configured.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectConfigSkewAdvisory,
  collectEgressAdvisory,
  collectOrphanStoresAdvisory,
  collectSecretPermsAdvisory,
} from "../../../src/commands/health/surfaces";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("collectSecretPermsAdvisory (08-F4)", () => {
  test("warns on group/other-readable env files and dirs", () => {
    const stashDir = makeTempDir("akm-surfaces-perms-");
    const cacheDir = makeTempDir("akm-surfaces-cache-");
    fs.mkdirSync(path.join(stashDir, "env"), { mode: 0o755 });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "K=v", { mode: 0o644 });

    const adv = collectSecretPermsAdvisory({ stashDir, cacheDir }, "linux");
    expect(adv?.name).toBe("secret-file-perms");
    expect(adv?.status).toBe("warn");
    const offenders = adv?.evidence?.offenders as string[];
    expect(offenders.some((o) => o.includes("env"))).toBe(true);
    expect(offenders.some((o) => o.includes("prod.env"))).toBe(true);
  });

  test("silent when env/secrets/backups are 0600/0700 (or absent)", () => {
    const stashDir = makeTempDir("akm-surfaces-perms-");
    const cacheDir = makeTempDir("akm-surfaces-cache-");
    fs.mkdirSync(path.join(stashDir, "secrets"), { mode: 0o700 });
    fs.writeFileSync(path.join(stashDir, "secrets", "signing.key"), "s", { mode: 0o600 });
    const backups = path.join(cacheDir, "config-backups");
    fs.mkdirSync(backups, { mode: 0o700 });
    fs.writeFileSync(path.join(backups, "config-1.json"), "{}", { mode: 0o600 });

    expect(collectSecretPermsAdvisory({ stashDir, cacheDir }, "linux")).toBeUndefined();
  });

  test("silent on win32 (POSIX modes are meaningless there)", () => {
    const stashDir = makeTempDir("akm-surfaces-perms-");
    fs.mkdirSync(path.join(stashDir, "env"), { mode: 0o755 });
    expect(collectSecretPermsAdvisory({ stashDir, cacheDir: stashDir }, "win32")).toBeUndefined();
  });
});

describe("collectConfigSkewAdvisory (08-F3)", () => {
  test("warns when the on-disk configVersion is newer than this binary's", () => {
    const dir = makeTempDir("akm-surfaces-skew-");
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ configVersion: "99.0.0" }));

    const adv = collectConfigSkewAdvisory(configPath);
    expect(adv?.name).toBe("binary-config-skew");
    expect(adv?.status).toBe("warn");
    expect(adv?.message).toContain("99.0.0");
  });

  test("warns on an unorderable configVersion written by a foreign akm", () => {
    const dir = makeTempDir("akm-surfaces-skew-");
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ configVersion: "not-a-version" }));

    const adv = collectConfigSkewAdvisory(configPath);
    expect(adv?.status).toBe("warn");
  });

  test("silent when configVersion matches or predates the binary (auto-migration handles it)", () => {
    const dir = makeTempDir("akm-surfaces-skew-");
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ configVersion: "0.8.0" }));
    expect(collectConfigSkewAdvisory(configPath)).toBeUndefined();

    fs.writeFileSync(configPath, JSON.stringify({ configVersion: 1 }));
    expect(collectConfigSkewAdvisory(configPath)).toBeUndefined();
  });

  test("silent when the config file is missing or malformed", () => {
    const dir = makeTempDir("akm-surfaces-skew-");
    expect(collectConfigSkewAdvisory(path.join(dir, "missing.json"))).toBeUndefined();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{nope");
    expect(collectConfigSkewAdvisory(bad)).toBeUndefined();
  });
});

describe("collectOrphanStoresAdvisory (08-F4/F7)", () => {
  test("warns on legacy config-backups dirs and a 0-byte stash state.db decoy", () => {
    const dataDir = makeTempDir("akm-surfaces-data-");
    const configDir = makeTempDir("akm-surfaces-config-");
    const stashDir = makeTempDir("akm-surfaces-stash-");
    fs.mkdirSync(path.join(dataDir, "config-backups"));
    fs.mkdirSync(path.join(configDir, "config-backups"));
    fs.mkdirSync(path.join(stashDir, ".akm"));
    fs.writeFileSync(path.join(stashDir, ".akm", "state.db"), "");

    const adv = collectOrphanStoresAdvisory({ dataDir, configDir, stashDir });
    expect(adv?.name).toBe("orphan-stores");
    expect(adv?.status).toBe("warn");
    const orphans = adv?.evidence?.orphans as string[];
    expect(orphans).toHaveLength(3);
  });

  test("silent when no orphan stores exist (non-empty stash state.db is not a decoy)", () => {
    const dataDir = makeTempDir("akm-surfaces-data-");
    const configDir = makeTempDir("akm-surfaces-config-");
    const stashDir = makeTempDir("akm-surfaces-stash-");
    fs.mkdirSync(path.join(stashDir, ".akm"));
    fs.writeFileSync(path.join(stashDir, ".akm", "state.db"), "not-empty");

    expect(collectOrphanStoresAdvisory({ dataDir, configDir, stashDir })).toBeUndefined();
  });
});

describe("collectEgressAdvisory (08 surfaces 3/9)", () => {
  test("lists enabled registries, remote sources, LLM and embedding endpoints", () => {
    const adv = collectEgressAdvisory({
      registries: [
        { url: "https://example.com/index.json", name: "reg", enabled: true },
        { url: "https://disabled.example.com", name: "off", enabled: false },
      ],
      sources: [
        { type: "git", url: "https://github.com/x/y.git", name: "team" },
        { type: "filesystem", path: "/stash", name: "local" },
      ],
      engines: {
        judge: { kind: "llm", endpoint: "http://127.0.0.1:1234/v1/chat/completions" },
        agent: { kind: "agent" },
      },
      embedding: { endpoint: "http://127.0.0.1:8080" },
    });
    expect(adv?.name).toBe("egress-endpoints");
    expect(adv?.status).toBe("pass");
    const endpoints = adv?.evidence?.endpoints as string[];
    expect(endpoints).toContain("registry reg: https://example.com/index.json");
    expect(endpoints).toContain("source team (git): https://github.com/x/y.git");
    expect(endpoints).toContain("llm judge: http://127.0.0.1:1234/v1/chat/completions");
    expect(endpoints).toContain("embedding: http://127.0.0.1:8080");
    expect(endpoints.some((e) => e.includes("disabled.example.com"))).toBe(false);
    expect(endpoints.some((e) => e.includes("/stash"))).toBe(false);
  });

  test("silent when no remote endpoints are configured", () => {
    expect(collectEgressAdvisory({ sources: [{ type: "filesystem", path: "/stash" }] })).toBeUndefined();
    expect(collectEgressAdvisory(undefined)).toBeUndefined();
  });
});

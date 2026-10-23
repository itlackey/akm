// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ExecutionSourceLookup,
  loadAdapterExecutionSource,
} from "../../src/commands/command/execution-source-loader";
import { adapterForId } from "../../src/core/adapter/registry";
import { slugForPath } from "../../src/core/bundle-id";
import type { AkmConfig } from "../../src/core/config/config-types";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { createAdapterRenderedExecutionSource } from "../../src/execution/source";
import type { IndexEntry } from "../../src/indexer/indexer";
import { withEnv } from "../_helpers/sandbox";

const FIXTURES = path.resolve("tests/fixtures/execution-contracts/native");
const roots: string[] = [];

function tempRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `akm-command-loader-${name}-`));
  roots.push(root);
  return root;
}

function installFixture(adapter: "akm" | "claude" | "opencode", kind: "command" | "persona") {
  const root = tempRoot(`${adapter}-${kind}`);
  const collection = kind === "command" ? "commands" : "agents";
  const name = kind === "command" ? "contract-review" : "contract-reviewer";
  const source = path.join(FIXTURES, adapter, collection, `${name}.md`);
  const destination = path.join(root, collection, `${name}.md`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return { root, destination, bytes: fs.readFileSync(destination), conceptId: `${collection}/${name}` };
}

function fixtureConfig(root: string, adapter: string): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    defaultBundle: "fixture",
    bundles: {
      fixture: {
        path: root,
        components: { main: { root: ".", adapter } },
      },
    },
  };
}

function lookupFor(entry: IndexEntry): ExecutionSourceLookup {
  return async () => entry;
}

function entryFor(root: string, filePath: string, adapterId: string, conceptId: string, type: string): IndexEntry {
  return {
    filePath,
    stashDir: root,
    type,
    name: path.basename(conceptId),
    adapterId,
    itemRef: `fixture//${conceptId}`,
    bundleId: "fixture",
    conceptId,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("adapter-owned execution source loading", () => {
  for (const adapter of ["akm", "claude", "opencode"] as const) {
    for (const kind of ["command", "persona"] as const) {
      test(`${adapter} ${kind} loads body-only bytes without mutating the native file`, async () => {
        const fixture = installFixture(adapter, kind);
        const entry = entryFor(
          fixture.root,
          fixture.destination,
          adapter,
          fixture.conceptId,
          kind === "persona" ? "agent" : kind,
        );
        const options = {
          config: fixtureConfig(fixture.root, adapter),
          lookup: lookupFor(entry),
        };
        const loaded =
          kind === "command"
            ? await loadAdapterExecutionSource(`fixture//${fixture.conceptId}`, "command", options)
            : await loadAdapterExecutionSource(`fixture//${fixture.conceptId}`, "persona", options);

        expect(loaded.kind).toBe(kind);
        expect(loaded.content).toStartWith("# Contract review");
        expect(loaded.content).not.toStartWith("---");
        expect(loaded.identity).toMatchObject({
          ref: `fixture//${fixture.conceptId}`,
          bundle: "fixture",
          adapter,
          file: `${kind === "command" ? "commands/contract-review" : "agents/contract-reviewer"}.md`,
        });
        expect(fs.readFileSync(fixture.destination)).toEqual(fixture.bytes);
      });
    }
  }

  test("loads a command that is a symlink to a file outside its bundle (#1237)", async () => {
    const fixture = installFixture("akm", "command");
    const outside = tempRoot("outside");
    const target = path.join(outside, "contract-review.md");
    fs.renameSync(fixture.destination, target);
    fs.symlinkSync(target, fixture.destination);
    const entry = entryFor(fixture.root, fixture.destination, "akm", fixture.conceptId, "command");

    const loaded = await loadAdapterExecutionSource(`fixture//${fixture.conceptId}`, "command", {
      config: fixtureConfig(fixture.root, "akm"),
      lookup: lookupFor(entry),
    });

    expect(loaded.kind).toBe("command");
    expect(loaded.content).toStartWith("# Contract review");
  });

  test("loads an indexed persona from the canonical implicit AKM_BUNDLE_DIR source", async () => {
    const fixture = installFixture("akm", "persona");
    const bundleId = slugForPath(fixture.root);
    const entry = {
      ...entryFor(fixture.root, fixture.destination, "akm", fixture.conceptId, "agent"),
      itemRef: `${bundleId}//${fixture.conceptId}`,
      bundleId,
    };

    const loaded = await withEnv({ AKM_BUNDLE_DIR: fixture.root }, () =>
      loadAdapterExecutionSource(`${bundleId}//${fixture.conceptId}`, "persona", {
        config: { configVersion: "0.9.0", semanticSearchMode: "off" },
        lookup: lookupFor(entry),
      }),
    );

    expect(loaded.content).toStartWith("# Contract reviewer");
    expect(loaded.identity).toMatchObject({
      ref: `${bundleId}//${fixture.conceptId}`,
      bundle: bundleId,
      adapter: "akm",
      file: "agents/contract-reviewer.md",
    });
  });

  test("rejects wrong types, unknown adapters, missing runtime facets, and renderer abstention", async () => {
    const fixture = installFixture("akm", "command");
    const config = fixtureConfig(fixture.root, "akm");
    const base = entryFor(fixture.root, fixture.destination, "akm", fixture.conceptId, "command");

    await expect(
      loadAdapterExecutionSource("fixture//commands/contract-review", "persona", {
        config,
        lookup: lookupFor(base),
      }),
    ).rejects.toThrow(/expected.*persona|expected.*agent|resolves to type/i);
    await expect(
      loadAdapterExecutionSource("fixture//commands/contract-review", "command", {
        config: fixtureConfig(fixture.root, "missing-adapter"),
        lookup: lookupFor({ ...base, adapterId: "missing-adapter" }),
      }),
    ).rejects.toThrow(/adapter.*missing-adapter/i);
    await expect(
      loadAdapterExecutionSource("fixture//commands/contract-review", "command", {
        config: fixtureConfig(fixture.root, "akm-task"),
        lookup: lookupFor({ ...base, adapterId: "akm-task" }),
      }),
    ).rejects.toThrow(/does not support.*execution/i);

    const knowledgePath = path.join(fixture.root, "knowledge", "guide.md");
    fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
    fs.writeFileSync(knowledgePath, "# Guide\n");
    await expect(
      loadAdapterExecutionSource("fixture//knowledge/guide", "command", {
        config,
        lookup: lookupFor(entryFor(fixture.root, knowledgePath, "akm", "knowledge/guide", "command")),
      }),
    ).rejects.toThrow(/did not render.*command|renderer/i);
  });

  test("warns and re-resolves from the indexed source on root drift, configured adapter drift, and an unresolvable configured source", async () => {
    const fixture = installFixture("akm", "command");
    const config = fixtureConfig(fixture.root, "akm");
    const base = entryFor(fixture.root, fixture.destination, "akm", fixture.conceptId, "command");
    const other = tempRoot("other");

    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const rootDrifted = await loadAdapterExecutionSource("fixture//commands/contract-review", "command", {
        config: fixtureConfig(other, "akm"),
        lookup: lookupFor(base),
      });
      expect(rootDrifted.content).toStartWith("# Contract review");
      expect(warnings.some((w) => /root/i.test(w) && /drift|re-resolving/i.test(w))).toBe(true);

      warnings.length = 0;
      const adapterDrifted = await loadAdapterExecutionSource("fixture//commands/contract-review", "command", {
        config: fixtureConfig(fixture.root, "claude"),
        lookup: lookupFor(base),
      });
      expect(adapterDrifted.content).toStartWith("# Contract review");
      expect(adapterDrifted.identity.adapter).toBe("akm");
      expect(warnings.some((w) => /adapter/i.test(w) && /drift|re-resolving/i.test(w))).toBe(true);

      warnings.length = 0;
      const unresolvedSource = await loadAdapterExecutionSource("fixture//commands/contract-review", "command", {
        config: {
          ...config,
          bundles: {
            fixture: {
              components: { main: { root: ".", adapter: "akm" } },
            },
          },
        },
        lookup: lookupFor(base),
      });
      expect(unresolvedSource.content).toStartWith("# Contract review");
      expect(warnings.some((w) => /configured source|materialized/i.test(w))).toBe(true);
    } finally {
      _setWarnSinkForTests(undefined);
    }

    const outside = path.join(other, "outside.md");
    fs.writeFileSync(outside, "# Outside\n");
    await expect(
      loadAdapterExecutionSource("fixture//commands/contract-review", "command", {
        config: fixtureConfig(fixture.root, "akm"),
        lookup: lookupFor({ ...base, filePath: outside }),
      }),
    ).rejects.toThrow(/outside|escape|contain/i);

    fs.unlinkSync(fixture.destination);
    await expect(
      loadAdapterExecutionSource("fixture//commands/contract-review", "command", {
        config: fixtureConfig(fixture.root, "akm"),
        lookup: lookupFor(base),
      }),
    ).rejects.toThrow(/stale|missing|not.*read/i);
  });

  test("still rejects a configured source that resolves to a real path but is not actually materialized there", async () => {
    const fixture = installFixture("akm", "command");
    const config = fixtureConfig(fixture.root, "akm");
    const base = entryFor(fixture.root, fixture.destination, "akm", fixture.conceptId, "command");

    await expect(
      loadAdapterExecutionSource("fixture//commands/contract-review", "command", {
        config: {
          ...config,
          bundles: {
            fixture: {
              git: "https://example.invalid/fixture-never-cloned.git",
              components: { main: { root: ".", adapter: "akm" } },
            },
          },
        },
        lookup: lookupFor(base),
      }),
    ).rejects.toThrow(/missing|unreadable|materialized/i);
  });

  test("rejects configured component roots that lexically or physically escape their materialized source", async () => {
    const container = tempRoot("component-containment");
    const sourceRoot = path.join(container, "source");
    const outsideRoot = path.join(container, "outside");
    const outsideFile = path.join(outsideRoot, "commands", "escaped.md");
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(outsideFile, "# Escaped command\n");
    const entry = entryFor(outsideRoot, outsideFile, "akm", "commands/escaped", "command");

    await expect(
      loadAdapterExecutionSource("fixture//commands/escaped", "command", {
        config: {
          configVersion: "0.9.0",
          semanticSearchMode: "off",
          defaultBundle: "fixture",
          bundles: {
            fixture: {
              path: sourceRoot,
              components: { main: { root: "../outside", adapter: "akm" } },
            },
          },
        },
        lookup: lookupFor(entry),
      }),
    ).rejects.toThrow(/component root.*outside|escape|contain/i);

    const symlink = path.join(sourceRoot, "linked-component");
    fs.symlinkSync(outsideRoot, symlink, "dir");
    await expect(
      loadAdapterExecutionSource("fixture//commands/escaped", "command", {
        config: {
          configVersion: "0.9.0",
          semanticSearchMode: "off",
          defaultBundle: "fixture",
          bundles: {
            fixture: {
              path: sourceRoot,
              components: { main: { root: "linked-component", adapter: "akm" } },
            },
          },
        },
        lookup: lookupFor(entry),
      }),
    ).rejects.toThrow(/component root.*outside|escape|contain/i);
  });

  test("rejects fragments and missing indexed refs before any renderer runs", async () => {
    const fixture = installFixture("akm", "command");
    const config = fixtureConfig(fixture.root, "akm");
    let lookups = 0;
    await expect(
      loadAdapterExecutionSource("fixture//commands/contract-review#section", "command", {
        config,
        lookup: async () => {
          lookups += 1;
          return null;
        },
      }),
    ).rejects.toThrow(/fragment/i);
    expect(lookups).toBe(0);

    await expect(
      loadAdapterExecutionSource("fixture//commands/missing", "command", {
        config,
        lookup: async () => null,
      }),
    ).rejects.toThrow(/not found|index/i);
  });

  test("rejects renderer file and hash identity drift", async () => {
    const fixture = installFixture("akm", "command");
    const entry = entryFor(fixture.root, fixture.destination, "akm", fixture.conceptId, "command");
    const adapter = adapterForId("akm");
    if (!adapter) throw new Error("missing built-in akm adapter");

    await expect(
      loadAdapterExecutionSource("fixture//commands/contract-review", "command", {
        config: fixtureConfig(fixture.root, "akm"),
        lookup: lookupFor(entry),
        adapterFor: () => ({
          ...adapter,
          renderExecutionSource: () =>
            createAdapterRenderedExecutionSource({
              kind: "command",
              content: "forged body",
              identity: {
                ref: entry.itemRef,
                bundle: entry.bundleId,
                adapter: entry.adapterId,
                file: "commands/other.md",
                hash: "b".repeat(64),
              },
            }),
        }),
      }),
    ).rejects.toThrow(/identity drift|hash|file/i);
  });
});

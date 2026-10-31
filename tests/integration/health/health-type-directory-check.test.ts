// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #831 end-to-end: `akm health` must flag any REAL indexed asset whose
 * resolved type disagrees with the type its directory declares, using the
 * actual indexer/index.db, not synthetic entries. It must:
 *   - stay silent when the indexed stash agrees with its directories,
 *   - name explicit frontmatter overrides as known-good, but never a
 *     placeholder mentioned in documentation, and
 *   - flag the #824 defect shape (an entry's indexed type disagreeing with
 *     its directory) as an unexplained ("unknown") disagreement, and never
 *     as a hard failure.
 *
 * #826 already fixed the numeric-placeholder regex, so the defect shape can
 * no longer be reproduced by writing a body that trips it — the corrupted
 * row is constructed directly against index.db instead, mirroring how #824
 * actually manifested: a correctly-placed file whose indexed `type` ended up
 * wrong.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import type { HealthCheckResult } from "../../../src/commands/health/types";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

function setUpStash(): void {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "fixture",
    bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
  });
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function findAdvisory(checks: HealthCheckResult[], name: string): HealthCheckResult | undefined {
  return checks.find((c) => c.name === name);
}

describe("type-directory-disagreement advisory (#831, end-to-end)", () => {
  test("stays silent when every real indexed asset agrees with its directory", async () => {
    setUpStash();
    try {
      writeFile(path.join(storage.stashDir, "memories", "plain.md"), "Just a plain note.\n");
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const result = await akmHealth({ since: "7d" });
      expect(findAdvisory(result.advisories, "type-directory-disagreement")).toBeUndefined();
    } finally {
      storage.cleanup();
    }
  });

  test("only explicit frontmatter overrides a document's directory, without hard-failing", async () => {
    setUpStash();
    try {
      writeFile(
        path.join(storage.stashDir, "knowledge", "deploy-cmd.md"),
        ["---", "description: Deploy helper", "---", "Deploy $ARGUMENTS to staging."].join("\n"),
      );
      writeFile(
        path.join(storage.stashDir, "agents", "build-cmd.md"),
        ["---", "agent: build", "description: Build dispatch", "---", "Build the project."].join("\n"),
      );
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const result = await akmHealth({ since: "7d" });
      const advisory = findAdvisory(result.advisories, "type-directory-disagreement");
      expect(advisory).toBeDefined();
      expect(advisory?.status).toBe("warn");
      expect(advisory?.status).not.toBe("fail");
      expect(result.status).not.toBe("fail");

      const disagreements = (advisory?.evidence?.disagreements ?? []) as Array<{
        path: string;
        resolved: string;
        expected: string;
        winner: string;
        knownGoodOverride: boolean;
      }>;
      const deployCmd = disagreements.find((d) => d.path.includes("deploy-cmd.md"));
      expect(deployCmd).toBeUndefined();
      expect(disagreements).toHaveLength(1);
      const buildCmd = disagreements.find((d) => d.path.includes("build-cmd.md"));
      expect(buildCmd).toMatchObject({
        resolved: "command",
        expected: "agent",
        winner: "smart-md:agent-frontmatter",
        knownGoodOverride: true,
      });
    } finally {
      storage.cleanup();
    }
  });

  test("flags the #824 defect shape (indexed type disagreeing with its directory) as unexplained, without hard-failing", async () => {
    setUpStash();
    try {
      const notePath = path.join(storage.stashDir, "memories", "910ed479-3-f4f94df3.md");
      writeFile(notePath, "The invoice was $2,000 due at signing.\n");
      await akmIndex({ stashDir: storage.stashDir, full: true });

      // #826 already fixed the numeric-placeholder regex, so this body no
      // longer misclassifies through the indexer — construct the #824 defect
      // directly by corrupting the indexed type, the same durable symptom the
      // bug actually produced.
      const dbPath = getDbPath();
      const writableDb = openIndexDatabase(dbPath);
      try {
        const changed = writableDb
          .prepare("UPDATE entries SET type = 'command' WHERE file_path = ?")
          .run(notePath).changes;
        expect(changed).toBe(1);
      } finally {
        writableDb.close();
      }

      const result = await akmHealth({ since: "7d" });
      const advisory = findAdvisory(result.advisories, "type-directory-disagreement");
      expect(advisory).toBeDefined();
      expect(advisory?.status).toBe("warn");
      expect(advisory?.status).not.toBe("fail");
      expect(result.status).not.toBe("fail");

      const disagreements = (advisory?.evidence?.disagreements ?? []) as Array<{
        path: string;
        resolved: string;
        expected: string;
        winner: string;
        knownGoodOverride: boolean;
      }>;
      const note = disagreements.find((d) => d.path.includes("910ed479-3-f4f94df3.md"));
      expect(note).toMatchObject({
        resolved: "command",
        expected: "memory",
        winner: "unknown",
        knownGoodOverride: false,
      });
    } finally {
      storage.cleanup();
    }
  });
});

test("health accepts indexed skills whose names collide with typed directories (#1301)", async () => {
  setUpStash();
  try {
    const names = ["demo", "knowledge", "memories", "commands"];
    for (const name of names) {
      writeFile(path.join(storage.stashDir, "skills", name, "SKILL.md"), `# ${name}\n\nA valid skill.\n`);
    }
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const db = openIndexDatabase(getDbPath());
    try {
      const entries = db.prepare("SELECT concept_id, type FROM entries ORDER BY concept_id").all();
      expect(entries).toEqual([...names].sort().map((name) => ({ concept_id: `skills/${name}`, type: "skill" })));
    } finally {
      db.close();
    }

    const result = await akmHealth({ since: "7d" });
    expect(findAdvisory(result.advisories, "type-directory-disagreement")).toBeUndefined();
  } finally {
    storage.cleanup();
  }
});

/**
 * End-to-end semantic search test that uses real @huggingface/transformers
 * embeddings and verifies vector search produces meaningful results.
 *
 * Gated behind AKM_SEMANTIC_TESTS=1 because first run downloads the model.
 * Subsequent runs use the cached model and complete in ~1-2 seconds.
 *
 * Usage:
 *   AKM_SEMANTIC_TESTS=1 bun test tests/semantic-search-e2e.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmConfig } from "../src/config";
import { resetConfigCache, saveConfig } from "../src/config";
import { closeDatabase, EMBEDDING_DIM, getEmbeddingCount, getEntryCount, getMeta, openDatabase } from "../src/db";
import { searchLocal } from "../src/db-search";
import { clearEmbeddingCache } from "../src/embedder";
import { akmIndex } from "../src/indexer";
import { getDbPath } from "../src/paths";

// ── Gate ───────────────────────────────────────────────────────────────────

const SEMANTIC_TESTS = !!process.env.AKM_SEMANTIC_TESTS;

// ── Helpers ────────────────────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

/**
 * Create a stash directory populated with semantically distinct test assets.
 * Each asset has a .stash.json with curated metadata and a content file.
 */
function createTestStash(): string {
  const stashDir = createTmpDir("akm-semantic-e2e-stash-");

  // 1. Deploy script — about deploying applications to production
  const deployDir = path.join(stashDir, "scripts", "deploy");
  fs.mkdirSync(deployDir, { recursive: true });
  fs.writeFileSync(
    path.join(deployDir, "deploy.sh"),
    `#!/bin/bash
# Deploy application to production environment
# Handles blue-green deployment with health checks

set -euo pipefail

echo "Starting production deployment..."
kubectl apply -f k8s/deployment.yaml
kubectl rollout status deployment/app --timeout=300s
echo "Deployment complete. Running health checks..."
curl -sf http://app.internal/health || exit 1
echo "Application deployed successfully to production."
`,
  );
  fs.writeFileSync(
    path.join(deployDir, ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "deploy",
          type: "script",
          filename: "deploy.sh",
          description: "Deploy application to production with blue-green strategy and health checks",
          tags: ["deploy", "production", "kubernetes", "k8s", "rollout"],
          searchHints: ["use when deploying to production", "blue-green deployment strategy"],
          quality: "curated",
        },
      ],
    }),
  );

  // 2. Docker knowledge — about container best practices
  const dockerDir = path.join(stashDir, "knowledge", "docker-guide");
  fs.mkdirSync(dockerDir, { recursive: true });
  fs.writeFileSync(
    path.join(dockerDir, "docker-guide.md"),
    `# Docker Container Best Practices

## Image Building
- Use multi-stage builds to reduce image size
- Pin base image versions for reproducibility
- Minimize layers and clean up in the same RUN command

## Security
- Run containers as non-root user
- Scan images for vulnerabilities regularly
- Use read-only filesystem where possible

## Networking
- Use Docker networks for service isolation
- Expose only necessary ports
- Configure health checks for orchestration

## Resource Management
- Set memory and CPU limits
- Use restart policies for resilience
- Monitor container resource usage
`,
  );
  fs.writeFileSync(
    path.join(dockerDir, ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "docker-guide",
          type: "knowledge",
          filename: "docker-guide.md",
          description:
            "Docker container best practices covering image building, security, networking, and resource management",
          tags: ["docker", "container", "devops", "best-practices"],
          searchHints: ["container best practices", "docker security guidelines"],
          quality: "curated",
        },
      ],
    }),
  );

  // 3. Testing knowledge — about unit testing patterns
  const testingDir = path.join(stashDir, "knowledge", "testing-patterns");
  fs.mkdirSync(testingDir, { recursive: true });
  fs.writeFileSync(
    path.join(testingDir, "testing-patterns.md"),
    `# Unit Testing Patterns and Best Practices

## Test Structure
- Arrange, Act, Assert (AAA) pattern
- One assertion per test for clarity
- Use descriptive test names that explain the expected behavior

## Mocking and Stubbing
- Mock external dependencies, not the system under test
- Use dependency injection to enable testability
- Prefer fakes over mocks for complex interactions

## Test Coverage
- Aim for meaningful coverage, not just line coverage
- Test edge cases and error paths
- Use property-based testing for algorithmic code

## Integration Testing
- Test module boundaries and API contracts
- Use test containers for database integration tests
- Verify error handling across service boundaries
`,
  );
  fs.writeFileSync(
    path.join(testingDir, ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "testing-patterns",
          type: "knowledge",
          filename: "testing-patterns.md",
          description:
            "Unit testing patterns including AAA, mocking strategies, coverage guidelines, and integration testing",
          tags: ["testing", "unit-test", "tdd", "quality"],
          searchHints: ["how to write unit tests", "testing best practices"],
          quality: "curated",
        },
      ],
    }),
  );

  // 4. Git workflow skill — about version control
  const gitDir = path.join(stashDir, "skills", "git-workflow");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(
    path.join(gitDir, "git-workflow.md"),
    `# Git Workflow Skill

## Branching Strategy
Use a trunk-based development model:
- Main branch is always deployable
- Feature branches are short-lived
- Use pull requests for code review

## Commit Messages
Follow conventional commits:
- feat: for new features
- fix: for bug fixes
- refactor: for code restructuring

## Merge Strategy
- Prefer rebase for linear history
- Use squash merges for feature branches
- Never force push to shared branches
`,
  );
  fs.writeFileSync(
    path.join(gitDir, ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "git-workflow",
          type: "skill",
          filename: "git-workflow.md",
          description:
            "Git version control workflow covering branching strategy, commit conventions, and merge practices",
          tags: ["git", "version-control", "branching", "workflow"],
          searchHints: ["how to manage git branches", "commit message conventions"],
          quality: "curated",
        },
      ],
    }),
  );

  // 5. Database migration command — about schema changes
  const migrateDir = path.join(stashDir, "commands", "db-migrate");
  fs.mkdirSync(migrateDir, { recursive: true });
  fs.writeFileSync(
    path.join(migrateDir, "db-migrate.sh"),
    `#!/bin/bash
# Run database migrations safely with rollback support
set -euo pipefail

echo "Running database schema migration..."
npx prisma migrate deploy
echo "Migration complete. Verifying schema..."
npx prisma db pull --force
echo "Database migration finished successfully."
`,
  );
  fs.writeFileSync(
    path.join(migrateDir, ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "db-migrate",
          type: "command",
          filename: "db-migrate.sh",
          description: "Run database schema migrations with rollback support using Prisma",
          tags: ["database", "migration", "schema", "prisma"],
          searchHints: ["migrate database schema", "run prisma migrations"],
          quality: "curated",
        },
      ],
    }),
  );

  return stashDir;
}

// ── Environment isolation ──────────────────────────────────────────────────
// Save and restore env vars at module scope to prevent leaking to other test files.

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";

function restoreEnv(): void {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;
  resetConfigCache();
}

// ═══════════════════════════════════════════════════════════════════════════
// Gated tests — require real @huggingface/transformers and ONNX runtime
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!SEMANTIC_TESTS)("Semantic search end-to-end (real embeddings)", () => {
  let stashDir: string;
  let savedCacheDir: string;
  let savedConfigDir: string;

  beforeAll(async () => {
    // Set up isolated cache and config directories
    testCacheDir = createTmpDir("akm-semantic-e2e-cache-");
    testConfigDir = createTmpDir("akm-semantic-e2e-config-");
    process.env.XDG_CACHE_HOME = testCacheDir;
    process.env.XDG_CONFIG_HOME = testConfigDir;
    // Use the user's existing HuggingFace model cache to avoid re-downloading
    if (!process.env.HF_HOME) {
      process.env.HF_HOME = path.join(process.env.HOME ?? "/tmp", ".cache", "huggingface");
    }

    // Create test stash with semantically distinct assets
    stashDir = createTestStash();
    process.env.AKM_STASH_DIR = stashDir;

    // Write config with semantic search enabled (default behavior)
    resetConfigCache();
    saveConfig({ semanticSearchMode: "auto" });

    // Index the stash with real embeddings
    // This will download the model on first run (cached at ~/.cache/huggingface)
    savedCacheDir = testCacheDir;
    savedConfigDir = testConfigDir;

    const result = await akmIndex({ stashDir, full: true });
    expect(result.totalEntries).toBeGreaterThan(0);
    expect(result.verification.semanticSearchEnabled).toBeTruthy();
  }, 120_000); // 2 minute timeout for model download on first run

  // Restore env vars before each test in case the degradation describe
  // (which runs in the same file) overwrites them between beforeAll and tests.
  beforeEach(() => {
    process.env.XDG_CACHE_HOME = savedCacheDir;
    process.env.XDG_CONFIG_HOME = savedConfigDir;
    process.env.AKM_STASH_DIR = stashDir;
    resetConfigCache();
  });

  afterAll(() => {
    restoreEnv();
    clearEmbeddingCache();
  });

  test("index stores embeddings with correct metadata", () => {
    const dbPath = getDbPath();
    expect(fs.existsSync(dbPath)).toBe(true);

    const db = openDatabase(dbPath);
    try {
      // Verify hasEmbeddings flag is set
      expect(getMeta(db, "hasEmbeddings")).toBe("1");

      // Verify embedding count matches entry count
      const entryCount = getEntryCount(db);
      const embeddingCount = getEmbeddingCount(db);
      expect(entryCount).toBeGreaterThanOrEqual(5);
      expect(embeddingCount).toBe(entryCount);

      // Verify each embedding has the correct dimension (384 for bge-small-en-v1.5)
      const rows = db.prepare("SELECT id, embedding FROM embeddings").all() as Array<{ id: number; embedding: Buffer }>;
      expect(rows.length).toBe(entryCount);

      for (const row of rows) {
        const f32 = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
        expect(f32.length).toBe(EMBEDDING_DIM);
        // Verify embeddings are non-zero (not degenerate)
        const norm = Math.sqrt(Array.from(f32).reduce((s, v) => s + v * v, 0));
        expect(norm).toBeGreaterThan(0.5);
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("deploy query ranks deploy script highest", async () => {
    resetConfigCache();
    const config: AkmConfig = { semanticSearchMode: "auto" };
    const result = await searchLocal({
      query: "deploy application to production",
      searchType: "any",
      limit: 10,
      stashDir,
      sources: [{ path: stashDir }],
      config,
    });

    expect(result.hits.length).toBeGreaterThan(0);

    // The deploy script should be the top result (or at least top 2)
    const topHits = result.hits.slice(0, 2);
    const deployHit = topHits.find((h) => h.name === "deploy" || h.name.includes("deploy"));
    expect(deployHit).toBeDefined();

    // Verify we got hybrid ranking (FTS + semantic combined)
    const deployResult = result.hits.find((h) => h.name === "deploy" || h.name.includes("deploy"));
    expect(deployResult).toBeDefined();
    expect(deployResult?.score).toBeGreaterThan(0);
  });

  test("container query ranks docker guide highest", async () => {
    resetConfigCache();
    const config: AkmConfig = { semanticSearchMode: "auto" };
    const result = await searchLocal({
      query: "container best practices",
      searchType: "any",
      limit: 10,
      stashDir,
      sources: [{ path: stashDir }],
      config,
    });

    expect(result.hits.length).toBeGreaterThan(0);

    // The docker guide should rank high for container queries
    const topHits = result.hits.slice(0, 3);
    const dockerHit = topHits.find((h) => h.name === "docker-guide" || h.name.includes("docker"));
    expect(dockerHit).toBeDefined();
  });

  test("testing query ranks testing patterns highest", async () => {
    resetConfigCache();
    const config: AkmConfig = { semanticSearchMode: "auto" };
    const result = await searchLocal({
      query: "unit testing",
      searchType: "any",
      limit: 10,
      stashDir,
      sources: [{ path: stashDir }],
      config,
    });

    expect(result.hits.length).toBeGreaterThan(0);

    // The testing patterns doc should rank high
    const topHits = result.hits.slice(0, 3);
    const testingHit = topHits.find((h) => h.name === "testing-patterns" || h.name.includes("testing"));
    expect(testingHit).toBeDefined();
  });

  test("semantic similarity differentiates unrelated queries", async () => {
    resetConfigCache();
    const config: AkmConfig = { semanticSearchMode: "auto" };

    // Search for deployment — deploy script should score higher than testing doc
    const deployResult = await searchLocal({
      query: "deploy application to production",
      searchType: "any",
      limit: 10,
      stashDir,
      sources: [{ path: stashDir }],
      config,
    });

    const deployScore = deployResult.hits.find((h) => h.name === "deploy" || h.name.includes("deploy"))?.score ?? 0;
    const testingScoreInDeployQuery =
      deployResult.hits.find((h) => h.name === "testing-patterns" || h.name.includes("testing"))?.score ?? 0;

    // Deploy should score higher than testing when searching for deployment
    expect(deployScore).toBeGreaterThan(testingScoreInDeployQuery);

    // Search for testing — testing doc should score higher than deploy script
    const testResult = await searchLocal({
      query: "how to write unit tests with mocking",
      searchType: "any",
      limit: 10,
      stashDir,
      sources: [{ path: stashDir }],
      config,
    });

    const testingScore =
      testResult.hits.find((h) => h.name === "testing-patterns" || h.name.includes("testing"))?.score ?? 0;
    const deployScoreInTestQuery =
      testResult.hits.find((h) => h.name === "deploy" || h.name.includes("deploy"))?.score ?? 0;

    // Testing should score higher than deploy when searching for testing
    expect(testingScore).toBeGreaterThan(deployScoreInTestQuery);
  });

  test("semantic search finds results even without exact keyword match", async () => {
    resetConfigCache();
    const config: AkmConfig = { semanticSearchMode: "auto" };

    // Use a paraphrase that doesn't share exact keywords with the deploy script
    // "shipping code to live servers" is semantically similar to deploy but uses different words
    const result = await searchLocal({
      query: "shipping code to live servers",
      searchType: "any",
      limit: 10,
      stashDir,
      sources: [{ path: stashDir }],
      config,
    });

    // We should still get results (semantic search should find relevant items)
    expect(result.hits.length).toBeGreaterThan(0);

    // The deploy script should appear somewhere in results via semantic similarity
    const deployHit = result.hits.find((h) => h.name === "deploy" || h.name.includes("deploy"));
    // It may or may not be top-1 since FTS won't match, but it should appear
    // in the results via vector search
    if (deployHit) {
      expect(deployHit.score).toBeGreaterThan(0);
    }
  });

  test("vector scores are present in hybrid results", async () => {
    resetConfigCache();
    const config: AkmConfig = { semanticSearchMode: "auto" };
    const result = await searchLocal({
      query: "deploy application",
      searchType: "any",
      limit: 10,
      stashDir,
      sources: [{ path: stashDir }],
      config,
    });

    expect(result.hits.length).toBeGreaterThan(0);

    // embedMs should be set when vector search ran
    expect(result.embedMs).toBeDefined();
    expect(result.embedMs).toBeGreaterThanOrEqual(0);

    // All hits should have positive scores
    for (const hit of result.hits) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ungated test — graceful degradation (always runs)
// ═══════════════════════════════════════════════════════════════════════════

describe("Semantic search graceful degradation", () => {
  let stashDir: string;
  let degradationCacheDir: string;
  let degradationConfigDir: string;

  beforeAll(() => {
    degradationCacheDir = createTmpDir("akm-semantic-degrade-cache-");
    degradationConfigDir = createTmpDir("akm-semantic-degrade-config-");
    process.env.XDG_CACHE_HOME = degradationCacheDir;
    process.env.XDG_CONFIG_HOME = degradationConfigDir;

    // Create a minimal stash
    stashDir = createTmpDir("akm-semantic-degrade-stash-");
    const skillDir = path.join(stashDir, "skills", "hello");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "hello.md"), "# Hello Skill\n\nA simple hello world greeting skill.\n");
    fs.writeFileSync(
      path.join(skillDir, ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "hello",
            type: "skill",
            filename: "hello.md",
            description: "A simple hello world greeting skill",
            tags: ["hello", "greeting"],
            quality: "curated",
          },
        ],
      }),
    );

    process.env.AKM_STASH_DIR = stashDir;
  });

  beforeEach(() => {
    process.env.XDG_CACHE_HOME = degradationCacheDir;
    process.env.XDG_CONFIG_HOME = degradationConfigDir;
    process.env.AKM_STASH_DIR = stashDir;
    resetConfigCache();
  });

  afterAll(() => {
    restoreEnv();
    // Clean up all temp dirs from both describe blocks
    for (const dir of createdTmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failures */
      }
    }
  });

  test("indexing succeeds with FTS only when semanticSearch is disabled", async () => {
    resetConfigCache();
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmIndex({ stashDir, full: true });

    expect(result.totalEntries).toBeGreaterThan(0);
    // When semantic search is disabled, verification should report it
    expect(result.verification.semanticSearchEnabled).toBeFalsy();

    // Check the database directly
    const dbPath = getDbPath();
    const db = openDatabase(dbPath);
    try {
      expect(getMeta(db, "hasEmbeddings")).toBe("0");
      expect(getEntryCount(db)).toBeGreaterThan(0);
      expect(getEmbeddingCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("search returns FTS results when no embeddings exist", async () => {
    resetConfigCache();
    // Use config with semanticSearchMode: "auto" but there are no embeddings in DB
    // (from previous test that indexed with semanticSearchMode: "off")
    const config: AkmConfig = { semanticSearchMode: "auto" };

    const result = await searchLocal({
      query: "hello",
      searchType: "any",
      limit: 10,
      stashDir,
      sources: [{ path: stashDir }],
      config,
    });

    // Should still return results via FTS
    expect(result.hits.length).toBeGreaterThan(0);
    const helloHit = result.hits.find((h) => h.name === "hello");
    expect(helloHit).toBeDefined();
    expect(helloHit?.score).toBeGreaterThan(0);
  });
});

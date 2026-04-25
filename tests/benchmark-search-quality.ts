#!/usr/bin/env bun
/**
 * Search quality benchmark for akm.
 *
 * Standalone script (NOT a bun:test suite) that:
 *   1. Creates a temp stash with ~20 well-defined assets
 *   2. Indexes them via akmIndex
 *   3. Runs 10 benchmark queries via akmSearch
 *   4. Computes MRR, Recall@5, per-query metrics
 *   5. Outputs deterministic JSON results
 *
 * Usage:
 *   bun run tests/benchmark-search-quality.ts
 *   bun run tests/benchmark-search-quality.ts --json   # machine-readable output only
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import { akmIndex } from "../src/indexer";
import { akmSearch } from "../src/source-search";
import type { SourceSearchHit } from "../src/source-types";

// ── CLI flags ────────────────────────────────────────────────────────────────

const jsonOnly = process.argv.includes("--json");

// ── Environment isolation ────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-"));
const testCacheDir = path.join(tmpRoot, "cache");
const testConfigDir = path.join(tmpRoot, "config");
fs.mkdirSync(testCacheDir, { recursive: true });
fs.mkdirSync(testConfigDir, { recursive: true });

const origXdgCache = process.env.XDG_CACHE_HOME;
const origXdgConfig = process.env.XDG_CONFIG_HOME;
const origStashDir = process.env.AKM_STASH_DIR;

process.env.XDG_CACHE_HOME = testCacheDir;
process.env.XDG_CONFIG_HOME = testConfigDir;

function cleanup() {
  if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = origXdgCache;
  if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdgConfig;
  if (origStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = origStashDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ── Asset definitions ────────────────────────────────────────────────────────

interface AssetDef {
  /** Relative path under the stash dir (determines type via directory) */
  dir: string;
  filename: string;
  fileContent: string;
  stashEntry: {
    name: string;
    type: string;
    description: string;
    tags?: string[];
    searchHints?: string[];
    aliases?: string[];
    filename: string;
  };
}

const ASSETS: AssetDef[] = [
  // ── Skills ──
  {
    dir: "skills/k8s-deploy",
    filename: "SKILL.md",
    fileContent: "# Kubernetes Deployment\n\nDeploy applications to Kubernetes clusters using kubectl.\n",
    stashEntry: {
      name: "k8s-deploy",
      type: "skill",
      description: "Deploy applications to Kubernetes clusters",
      tags: ["kubernetes", "deploy", "k8s", "containers"],
      searchHints: ["deploy to kubernetes", "kubectl apply", "container orchestration"],
      aliases: ["kube-deploy"],
      filename: "SKILL.md",
    },
  },
  {
    dir: "skills/code-review",
    filename: "SKILL.md",
    fileContent: "# Code Review\n\nReview pull requests for code quality and best practices.\n",
    stashEntry: {
      name: "code-review",
      type: "skill",
      description: "Review code for quality issues and best practices",
      tags: ["review", "quality", "pull-request"],
      searchHints: ["review pull request", "check code quality"],
      filename: "SKILL.md",
    },
  },
  {
    dir: "skills/api-design",
    filename: "SKILL.md",
    fileContent: "# API Design\n\nDesign RESTful APIs following best practices.\n",
    stashEntry: {
      name: "api-design",
      type: "skill",
      description: "Design RESTful APIs with OpenAPI specifications",
      tags: ["api", "rest", "openapi", "design"],
      searchHints: ["design a REST API", "create API specification"],
      filename: "SKILL.md",
    },
  },
  {
    dir: "skills/refactor",
    filename: "SKILL.md",
    fileContent: "# Code Refactoring\n\nRefactor code to improve readability and performance.\n",
    stashEntry: {
      name: "refactor",
      type: "skill",
      description: "Refactor code to improve structure and maintainability",
      tags: ["refactor", "clean-code", "maintenance"],
      searchHints: ["improve code structure", "clean up codebase"],
      filename: "SKILL.md",
    },
  },
  {
    dir: "skills/security-audit",
    filename: "SKILL.md",
    fileContent: "# Security Audit\n\nAudit applications for security vulnerabilities.\n",
    stashEntry: {
      name: "security-audit",
      type: "skill",
      description: "Audit code and infrastructure for security vulnerabilities",
      tags: ["security", "audit", "vulnerability", "pentest"],
      searchHints: ["find security vulnerabilities", "security scan"],
      filename: "SKILL.md",
    },
  },

  // ── Commands ──
  {
    dir: "commands",
    filename: "test-runner.md",
    fileContent: "---\ndescription: Run test suites across the project\n---\n# Test Runner\n\nRun all tests.\n",
    stashEntry: {
      name: "test-runner",
      type: "command",
      description: "Run test suites across the project",
      tags: ["test", "testing", "ci", "runner"],
      searchHints: ["run tests", "execute test suite"],
      filename: "test-runner.md",
    },
  },
  {
    dir: "commands",
    filename: "lint-check.md",
    fileContent: "---\ndescription: Run linting checks on the codebase\n---\n# Lint Check\n\nLint code.\n",
    stashEntry: {
      name: "lint-check",
      type: "command",
      description: "Run linting checks on the codebase",
      tags: ["lint", "eslint", "code-quality"],
      searchHints: ["lint code", "check for style issues"],
      filename: "lint-check.md",
    },
  },
  {
    dir: "commands",
    filename: "git-summary.md",
    fileContent: "---\ndescription: Summarize recent git changes\n---\n# Git Summary\n\nSummarize git log.\n",
    stashEntry: {
      name: "git-summary",
      type: "command",
      description: "Summarize recent git changes and commit history",
      tags: ["git", "summary", "changelog"],
      searchHints: ["summarize git commits", "show recent changes"],
      filename: "git-summary.md",
    },
  },
  {
    dir: "commands",
    filename: "deploy-status.md",
    fileContent: "---\ndescription: Check deployment status\n---\n# Deploy Status\n\nCheck deploy status.\n",
    stashEntry: {
      name: "deploy-status",
      type: "command",
      description: "Check the current deployment status of services",
      tags: ["deploy", "status", "monitoring"],
      searchHints: ["check deployment", "is service deployed"],
      filename: "deploy-status.md",
    },
  },

  // ── Scripts ──
  {
    dir: "scripts/pg-backup",
    filename: "pg-backup.sh",
    fileContent: "#!/bin/bash\n# Backup PostgreSQL database\npg_dump $DATABASE_URL > backup.sql\n",
    stashEntry: {
      name: "pg-backup",
      type: "script",
      description: "Backup PostgreSQL database to a SQL dump file",
      tags: ["database", "backup", "postgresql", "postgres"],
      searchHints: ["backup database", "export postgres data", "pg_dump"],
      filename: "pg-backup.sh",
    },
  },
  {
    dir: "scripts/docker-clean",
    filename: "docker-clean.sh",
    fileContent: "#!/bin/bash\n# Clean up Docker resources\ndocker system prune -af\n",
    stashEntry: {
      name: "docker-clean",
      type: "script",
      description: "Clean up unused Docker images, containers, and volumes",
      tags: ["docker", "cleanup", "containers"],
      searchHints: ["clean docker", "remove unused images"],
      filename: "docker-clean.sh",
    },
  },
  {
    dir: "scripts/ssl-renew",
    filename: "ssl-renew.sh",
    fileContent: "#!/bin/bash\n# Renew SSL certificates\ncertbot renew\n",
    stashEntry: {
      name: "ssl-renew",
      type: "script",
      description: "Renew SSL/TLS certificates using certbot",
      tags: ["ssl", "tls", "certificate", "certbot"],
      searchHints: ["renew certificates", "ssl renewal"],
      filename: "ssl-renew.sh",
    },
  },
  {
    dir: "scripts/log-rotate",
    filename: "log-rotate.sh",
    fileContent: "#!/bin/bash\n# Rotate application logs\nlogrotate /etc/logrotate.conf\n",
    stashEntry: {
      name: "log-rotate",
      type: "script",
      description: "Rotate and compress application log files",
      tags: ["logs", "rotation", "maintenance"],
      searchHints: ["rotate logs", "compress old logs"],
      filename: "log-rotate.sh",
    },
  },
  {
    dir: "scripts/env-setup",
    filename: "env-setup.sh",
    fileContent: "#!/bin/bash\n# Set up development environment\nnpm install && cp .env.example .env\n",
    stashEntry: {
      name: "env-setup",
      type: "script",
      description: "Set up local development environment with dependencies",
      tags: ["setup", "environment", "development", "onboarding"],
      searchHints: ["set up dev environment", "install dependencies"],
      filename: "env-setup.sh",
    },
  },

  // ── Knowledge ──
  {
    dir: "knowledge",
    filename: "architecture-guide.md",
    fileContent:
      "---\ndescription: System architecture overview\n---\n# Architecture Guide\n\n## Microservices\n\nOverview of service boundaries.\n\n## Data Flow\n\nHow data moves through the system.\n",
    stashEntry: {
      name: "architecture-guide",
      type: "knowledge",
      description: "System architecture overview and design decisions",
      tags: ["architecture", "design", "microservices"],
      searchHints: ["system architecture", "how the system works"],
      filename: "architecture-guide.md",
    },
  },
  {
    dir: "knowledge",
    filename: "runbook-incidents.md",
    fileContent:
      "---\ndescription: Incident response runbook\n---\n# Incident Runbook\n\n## Severity Levels\n\n## Escalation\n\n## Post-mortem\n",
    stashEntry: {
      name: "runbook-incidents",
      type: "knowledge",
      description: "Incident response procedures and escalation paths",
      tags: ["incident", "runbook", "on-call", "ops"],
      searchHints: ["handle incident", "escalation procedure"],
      filename: "runbook-incidents.md",
    },
  },
  {
    dir: "knowledge",
    filename: "coding-standards.md",
    fileContent:
      "---\ndescription: Team coding standards\n---\n# Coding Standards\n\n## Naming Conventions\n\n## Error Handling\n\n## Testing Requirements\n",
    stashEntry: {
      name: "coding-standards",
      type: "knowledge",
      description: "Team coding standards and conventions",
      tags: ["standards", "conventions", "style-guide"],
      searchHints: ["coding style", "naming conventions"],
      filename: "coding-standards.md",
    },
  },

  // ── Agents ──
  {
    dir: "agents",
    filename: "devops-engineer.md",
    fileContent:
      "---\ndescription: DevOps engineering agent\n---\nYou are a DevOps engineer specializing in CI/CD pipelines and infrastructure automation.\n",
    stashEntry: {
      name: "devops-engineer",
      type: "agent",
      description: "DevOps engineering agent for CI/CD and infrastructure",
      tags: ["devops", "ci-cd", "infrastructure", "automation"],
      searchHints: ["automate infrastructure", "CI/CD pipeline"],
      filename: "devops-engineer.md",
    },
  },
  {
    dir: "agents",
    filename: "data-analyst.md",
    fileContent:
      "---\ndescription: Data analysis agent\n---\nYou are a data analyst who helps explore datasets and generate insights.\n",
    stashEntry: {
      name: "data-analyst",
      type: "agent",
      description: "Data analysis agent for exploring datasets and generating insights",
      tags: ["data", "analysis", "statistics", "insights"],
      searchHints: ["analyze data", "generate reports"],
      filename: "data-analyst.md",
    },
  },
  {
    dir: "agents",
    filename: "technical-writer.md",
    fileContent:
      "---\ndescription: Technical writing agent\n---\nYou are a technical writer who creates clear documentation.\n",
    stashEntry: {
      name: "technical-writer",
      type: "agent",
      description: "Technical writing agent for creating documentation",
      tags: ["documentation", "writing", "technical"],
      searchHints: ["write documentation", "create technical docs"],
      filename: "technical-writer.md",
    },
  },
];

// ── Benchmark query definitions ──────────────────────────────────────────────

interface BenchmarkQuery {
  /** Human-readable label for the query */
  label: string;
  /** The search query string */
  query: string;
  /** Expected asset name that should rank highest (or near the top) */
  expectedName: string;
  /** Expected asset type */
  expectedType: string;
  /** What this query is testing */
  testingAspect: string;
}

const BENCHMARK_QUERIES: BenchmarkQuery[] = [
  {
    label: "exact-match-deploy-k8s",
    query: "deploy to kubernetes",
    expectedName: "k8s-deploy",
    expectedType: "skill",
    testingAspect: "Exact match on description and searchHints",
  },
  {
    label: "exact-match-database-backup",
    query: "database backup",
    expectedName: "pg-backup",
    expectedType: "script",
    testingAspect: "Exact match on tags and description",
  },
  {
    label: "exact-match-run-tests",
    query: "run tests",
    expectedName: "test-runner",
    expectedType: "command",
    testingAspect: "Exact match on searchHints",
  },
  {
    label: "prefix-match-kube",
    query: "kube",
    expectedName: "k8s-deploy",
    expectedType: "skill",
    testingAspect: "Prefix matching on alias 'kube-deploy'",
  },
  {
    label: "tag-match-docker",
    query: "docker",
    expectedName: "docker-clean",
    expectedType: "script",
    testingAspect: "Tag-based matching",
  },
  {
    label: "description-match-incident",
    query: "incident response",
    expectedName: "runbook-incidents",
    expectedType: "knowledge",
    testingAspect: "Description matching",
  },
  {
    label: "multi-word-ci-cd-pipeline",
    query: "ci cd pipeline",
    expectedName: "devops-engineer",
    expectedType: "agent",
    testingAspect: "Multi-word query matching tags",
  },
  {
    label: "hint-match-analyze-data",
    query: "analyze data",
    expectedName: "data-analyst",
    expectedType: "agent",
    testingAspect: "Search hint matching",
  },
  {
    label: "natural-language-ssl-cert",
    query: "renew ssl certificate",
    expectedName: "ssl-renew",
    expectedType: "script",
    testingAspect: "Natural language matching description and tags",
  },
  {
    label: "concept-match-code-quality",
    query: "code quality",
    expectedName: "code-review",
    expectedType: "skill",
    testingAspect: "Concept matching via tags and description",
  },
];

// ── Stash setup ──────────────────────────────────────────────────────────────

function createBenchmarkStash(): string {
  const stashDir = path.join(tmpRoot, "stash");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }

  for (const asset of ASSETS) {
    const dirPath = path.join(stashDir, asset.dir);
    fs.mkdirSync(dirPath, { recursive: true });

    // Write the asset file
    fs.writeFileSync(path.join(dirPath, asset.filename), asset.fileContent);

    // Write the .stash.json metadata
    const stashJsonPath = path.join(dirPath, ".stash.json");
    // For assets in a shared directory (commands, knowledge), we need to
    // merge entries into one .stash.json
    let entries: (typeof asset.stashEntry)[] = [];
    if (fs.existsSync(stashJsonPath)) {
      const existing = JSON.parse(fs.readFileSync(stashJsonPath, "utf8"));
      entries = existing.entries;
    }
    entries.push(asset.stashEntry);
    fs.writeFileSync(stashJsonPath, JSON.stringify({ entries }, null, 2));
  }

  return stashDir;
}

// ── Metric computation ───────────────────────────────────────────────────────

interface QueryResult {
  label: string;
  query: string;
  expectedName: string;
  expectedType: string;
  testingAspect: string;
  /** 1-based rank of the expected result, or null if not found */
  rank: number | null;
  /** Reciprocal rank (1/rank), or 0 if not found */
  reciprocalRank: number;
  /** Whether the expected result appeared in top 5 */
  inTop5: boolean;
  /** Score of the expected result, or null if not found */
  score: number | null;
  /** whyMatched of the expected result, or null if not found */
  whyMatched: string[] | null;
  /** Total number of results returned */
  totalResults: number;
  /** Top 5 results for inspection */
  top5: Array<{
    rank: number;
    name: string;
    type: string;
    score: number | undefined;
    whyMatched: string[] | undefined;
  }>;
}

interface BenchmarkResults {
  timestamp: string;
  gitBranch: string;
  gitCommit: string;
  assetCount: number;
  queryCount: number;
  metrics: {
    /** Mean Reciprocal Rank across all queries */
    mrr: number;
    /** Fraction of queries where expected result was in top 5 */
    recallAt5: number;
    /** Average score of expected results (excluding misses) */
    avgExpectedScore: number;
    /** Number of queries where expected result was rank 1 */
    rank1Count: number;
    /** Number of queries where expected result was not found */
    missCount: number;
  };
  queries: QueryResult[];
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function gitInfo(): { branch: string; commit: string } {
  try {
    const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: import.meta.dir,
    })
      .stdout.toString()
      .trim();
    const commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dir,
    })
      .stdout.toString()
      .trim();
    return { branch, commit };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

// ── Main benchmark ───────────────────────────────────────────────────────────

async function runBenchmark(): Promise<BenchmarkResults> {
  const { branch, commit } = gitInfo();

  // 1. Create the stash and index it
  const stashDir = createBenchmarkStash();
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off", registries: [] });

  if (!jsonOnly) {
    process.stderr.write("Indexing benchmark stash...\n");
  }
  const indexResult = await akmIndex({ stashDir, full: true });
  if (!jsonOnly) {
    process.stderr.write(`  Indexed ${indexResult.totalEntries} entries in ${indexResult.timing?.totalMs ?? "?"}ms\n`);
  }

  // 2. Run each benchmark query
  const queryResults: QueryResult[] = [];

  for (const bq of BENCHMARK_QUERIES) {
    if (!jsonOnly) {
      process.stderr.write(`  Running query: "${bq.query}" ...\n`);
    }

    const result = await akmSearch({ query: bq.query, source: "stash", limit: 20 });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    // Find rank of expected result
    const expectedIndex = hits.findIndex((h) => h.name === bq.expectedName);
    const rank = expectedIndex >= 0 ? expectedIndex + 1 : null;
    const reciprocalRank = rank !== null ? 1 / rank : 0;
    const inTop5 = rank !== null && rank <= 5;

    const expectedHit = expectedIndex >= 0 ? hits[expectedIndex] : null;

    const top5 = hits.slice(0, 5).map((h, i) => ({
      rank: i + 1,
      name: h.name,
      type: h.type,
      score: h.score,
      whyMatched: h.whyMatched,
    }));

    queryResults.push({
      label: bq.label,
      query: bq.query,
      expectedName: bq.expectedName,
      expectedType: bq.expectedType,
      testingAspect: bq.testingAspect,
      rank,
      reciprocalRank,
      inTop5,
      score: expectedHit?.score ?? null,
      whyMatched: expectedHit?.whyMatched ?? null,
      totalResults: hits.length,
      top5,
    });
  }

  // 3. Compute aggregate metrics
  const mrr = queryResults.reduce((sum, q) => sum + q.reciprocalRank, 0) / queryResults.length;

  const recallAt5 = queryResults.filter((q) => q.inTop5).length / queryResults.length;

  const scoredResults = queryResults.filter((q) => q.score !== null);
  const avgExpectedScore =
    scoredResults.length > 0 ? scoredResults.reduce((sum, q) => sum + (q.score ?? 0), 0) / scoredResults.length : 0;

  const rank1Count = queryResults.filter((q) => q.rank === 1).length;
  const missCount = queryResults.filter((q) => q.rank === null).length;

  return {
    timestamp: new Date().toISOString(),
    gitBranch: branch,
    gitCommit: commit,
    assetCount: ASSETS.length,
    queryCount: BENCHMARK_QUERIES.length,
    metrics: {
      mrr: Math.round(mrr * 10000) / 10000,
      recallAt5: Math.round(recallAt5 * 10000) / 10000,
      avgExpectedScore: Math.round(avgExpectedScore * 10000) / 10000,
      rank1Count,
      missCount,
    },
    queries: queryResults,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

try {
  const results = await runBenchmark();

  // Output JSON
  const jsonOutput = JSON.stringify(results, null, 2);
  console.log(jsonOutput);

  // Human-readable summary to stderr
  if (!jsonOnly) {
    process.stderr.write("\n");
    process.stderr.write("=== Search Quality Benchmark Results ===\n");
    process.stderr.write(`Branch: ${results.gitBranch} (${results.gitCommit})\n`);
    process.stderr.write(`Assets: ${results.assetCount}, Queries: ${results.queryCount}\n`);
    process.stderr.write("\n");
    process.stderr.write(`  MRR:             ${results.metrics.mrr}\n`);
    process.stderr.write(`  Recall@5:        ${results.metrics.recallAt5}\n`);
    process.stderr.write(`  Avg Score:       ${results.metrics.avgExpectedScore}\n`);
    process.stderr.write(`  Rank 1 hits:     ${results.metrics.rank1Count}/${results.queryCount}\n`);
    process.stderr.write(`  Misses:          ${results.metrics.missCount}/${results.queryCount}\n`);
    process.stderr.write("\n");

    process.stderr.write("Per-query breakdown:\n");
    for (const q of results.queries) {
      const status = q.rank === 1 ? "OK" : q.rank !== null ? `rank ${q.rank}` : "MISS";
      const scoreStr = q.score !== null ? ` score=${q.score}` : "";
      process.stderr.write(`  [${status.padEnd(7)}] "${q.query}" -> ${q.expectedName}${scoreStr}\n`);
    }
  }
} finally {
  cleanup();
}

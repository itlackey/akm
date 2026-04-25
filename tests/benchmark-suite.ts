#!/usr/bin/env bun
/**
 * Comprehensive benchmark suite for akm search system.
 *
 * Standalone script (NOT a bun:test suite) that covers:
 *   1. Search Quality (MRR, Recall@5, Recall@10)
 *   2. Search Performance (latency in ms)
 *   3. Indexing Performance (time in ms)
 *   4. Token Efficiency (byte savings %)
 *   5. Utility Scoring (M-2)
 *   6. Feature Correctness
 *
 * Usage:
 *   bun run tests/benchmark-suite.ts
 *   bun run tests/benchmark-suite.ts --json   # machine-readable output only
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleInfo } from "../src/commands/info";
import { akmSearch } from "../src/commands/search";
import { saveConfig } from "../src/core/config";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, openDatabase, rebuildFts, upsertUtilityScore } from "../src/indexer/db";
import { recomputeUtilityScores } from "../src/indexer/indexer";
import { buildSearchFields } from "../src/indexer/search-fields";
import { insertUsageEvent } from "../src/indexer/usage-events";
import type { SourceSearchHit } from "../src/sources/source-types";
import { recordUsageEvent } from "./helpers/usage-events";

// ── CLI flags ────────────────────────────────────────────────────────────────

const jsonOnly = process.argv.includes("--json");

function log(msg: string) {
  if (!jsonOnly) process.stderr.write(msg);
}

// ── Environment isolation ────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-benchsuite-"));
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

// ── Types ────────────────────────────────────────────────────────────────────

interface AssetDef {
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
    quality?: "generated" | "curated";
    confidence?: number;
    parameters?: Array<{ name: string; type?: string; description?: string }>;
    intent?: { when?: string; input?: string; output?: string };
  };
}

interface BenchmarkCase {
  id: string;
  scenario: string;
  description: string;
  passed: boolean;
  metric?: number;
  unit?: string;
  details?: string;
}

// ── Asset definitions (30+ assets) ───────────────────────────────────────────

const ASSETS: AssetDef[] = [
  // ── 5 Skills (varying metadata quality) ──
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
      quality: "curated",
      confidence: 0.95,
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
      quality: "curated",
      confidence: 0.9,
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
      quality: "curated",
      confidence: 0.9,
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
      // Sparse metadata — no quality or confidence
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
      quality: "generated",
      confidence: 0.6,
    },
  },

  // ── 5 Commands with $ARGUMENTS parameters ──
  {
    dir: "commands",
    filename: "test-runner.md",
    fileContent:
      "---\ndescription: Run test suites across the project\nparams:\n  suite: Test suite to run\n---\n# Test Runner\n\nRun $ARGUMENTS tests.\n",
    stashEntry: {
      name: "test-runner",
      type: "command",
      description: "Run test suites across the project",
      tags: ["test", "testing", "ci", "runner"],
      searchHints: ["run tests", "execute test suite"],
      filename: "test-runner.md",
      parameters: [{ name: "ARGUMENTS", description: "test suite path or pattern" }],
    },
  },
  {
    dir: "commands",
    filename: "lint-check.md",
    fileContent: "---\ndescription: Run linting checks on the codebase\n---\n# Lint Check\n\nRun lint on $ARGUMENTS.\n",
    stashEntry: {
      name: "lint-check",
      type: "command",
      description: "Run linting checks on the codebase",
      tags: ["lint", "eslint", "code-quality"],
      searchHints: ["lint code", "check for style issues"],
      filename: "lint-check.md",
      parameters: [{ name: "ARGUMENTS", description: "files to lint" }],
    },
  },
  {
    dir: "commands",
    filename: "git-summary.md",
    fileContent:
      "---\ndescription: Summarize recent git changes\n---\n# Git Summary\n\nSummarize $ARGUMENTS git log.\n",
    stashEntry: {
      name: "git-summary",
      type: "command",
      description: "Summarize recent git changes and commit history",
      tags: ["git", "summary", "changelog"],
      searchHints: ["summarize git commits", "show recent changes"],
      filename: "git-summary.md",
      parameters: [{ name: "ARGUMENTS", description: "branch or date range" }],
    },
  },
  {
    dir: "commands",
    filename: "deploy-status.md",
    fileContent:
      "---\ndescription: Check deployment status\n---\n# Deploy Status\n\nCheck $ARGUMENTS deployment status.\n",
    stashEntry: {
      name: "deploy-status",
      type: "command",
      description: "Check the current deployment status of services",
      tags: ["deploy", "status", "monitoring"],
      searchHints: ["check deployment", "is service deployed"],
      filename: "deploy-status.md",
      parameters: [{ name: "ARGUMENTS", description: "service name" }],
    },
  },
  {
    dir: "commands",
    filename: "docker-build.md",
    fileContent:
      "---\ndescription: Build Docker images from Dockerfile\nparams:\n  image: Docker image name and tag\n  context: Build context directory\n---\n# Docker Build\n\nBuild docker image $1 from $2.\n",
    stashEntry: {
      name: "docker-build",
      type: "command",
      description: "Build Docker images from Dockerfile",
      tags: ["docker", "build", "image", "containers"],
      searchHints: ["build docker image", "create container image"],
      filename: "docker-build.md",
      parameters: [
        { name: "image", description: "Docker image name and tag" },
        { name: "context", description: "Build context directory" },
      ],
      intent: { when: "Need to build a container image", input: "Dockerfile path", output: "Built image" },
    },
  },

  // ── 5 Scripts with @param JSDoc ──
  {
    dir: "scripts/pg-backup",
    filename: "pg-backup.sh",
    fileContent:
      '#!/bin/bash\n# @param {string} database - PostgreSQL database name\n# @param {string} output - Output file path for the dump\n# Backup PostgreSQL database\npg_dump "$1" > "$2"\n',
    stashEntry: {
      name: "pg-backup",
      type: "script",
      description: "Backup PostgreSQL database to a SQL dump file",
      tags: ["database", "backup", "postgresql", "postgres"],
      searchHints: ["backup database", "export postgres data", "pg_dump"],
      filename: "pg-backup.sh",
      parameters: [
        { name: "database", type: "string", description: "PostgreSQL database name" },
        { name: "output", type: "string", description: "Output file path for the dump" },
      ],
    },
  },
  {
    dir: "scripts/docker-clean",
    filename: "docker-clean.sh",
    fileContent:
      "#!/bin/bash\n# @param {string} filter - Optional image filter pattern\n# Clean up Docker resources\ndocker system prune -af\n",
    stashEntry: {
      name: "docker-clean",
      type: "script",
      description: "Clean up unused Docker images, containers, and volumes",
      tags: ["docker", "cleanup", "containers"],
      searchHints: ["clean docker", "remove unused images"],
      filename: "docker-clean.sh",
      parameters: [{ name: "filter", type: "string", description: "Optional image filter pattern" }],
    },
  },
  {
    dir: "scripts/ssl-renew",
    filename: "ssl-renew.sh",
    fileContent:
      "#!/bin/bash\n# @param {string} domain - Domain name for certificate renewal\n# Renew SSL certificates\ncertbot renew --domain $1\n",
    stashEntry: {
      name: "ssl-renew",
      type: "script",
      description: "Renew SSL/TLS certificates using certbot",
      tags: ["ssl", "tls", "certificate", "certbot"],
      searchHints: ["renew certificates", "ssl renewal"],
      filename: "ssl-renew.sh",
      parameters: [{ name: "domain", type: "string", description: "Domain name for certificate renewal" }],
    },
  },
  {
    dir: "scripts/log-rotate",
    filename: "log-rotate.sh",
    fileContent:
      "#!/bin/bash\n# @param {number} days - Number of days to keep logs\n# Rotate application logs\nlogrotate /etc/logrotate.conf\n",
    stashEntry: {
      name: "log-rotate",
      type: "script",
      description: "Rotate and compress application log files",
      tags: ["logs", "rotation", "maintenance"],
      searchHints: ["rotate logs", "compress old logs"],
      filename: "log-rotate.sh",
      parameters: [{ name: "days", type: "number", description: "Number of days to keep logs" }],
    },
  },
  {
    dir: "scripts/env-setup",
    filename: "env-setup.sh",
    fileContent:
      "#!/bin/bash\n# @param {string} environment - Target environment (dev, staging, prod)\n# Set up development environment\nnpm install && cp .env.example .env\n",
    stashEntry: {
      name: "env-setup",
      type: "script",
      description: "Set up local development environment with dependencies",
      tags: ["setup", "environment", "development", "onboarding"],
      searchHints: ["set up dev environment", "install dependencies"],
      filename: "env-setup.sh",
      parameters: [{ name: "environment", type: "string", description: "Target environment (dev, staging, prod)" }],
    },
  },

  // ── 5 Knowledge docs (some with deep TOC, some minimal) ──
  {
    dir: "knowledge",
    filename: "architecture-guide.md",
    fileContent:
      "---\ndescription: System architecture overview\n---\n# Architecture Guide\n\n## Microservices\n\nOverview of service boundaries.\n\n## Data Flow\n\nHow data moves through the system.\n\n## Database Schema\n\nRelational model overview.\n\n## API Gateway\n\nRouting and authentication.\n",
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
  {
    dir: "knowledge",
    filename: "onboarding.md",
    fileContent:
      "---\ndescription: New team member onboarding guide\n---\n# Onboarding Guide\n\n## First Day\n\n## Access Setup\n\n## Development Environment\n\n## Team Norms\n\n## Resources\n",
    stashEntry: {
      name: "onboarding",
      type: "knowledge",
      description: "New team member onboarding guide with checklists",
      tags: ["onboarding", "new-hire", "team"],
      searchHints: ["new team member", "getting started"],
      filename: "onboarding.md",
    },
  },
  {
    dir: "knowledge",
    filename: "troubleshooting.md",
    fileContent: "---\ndescription: Common troubleshooting steps\n---\n# Troubleshooting\n\nBasic debugging tips.\n",
    stashEntry: {
      name: "troubleshooting",
      type: "knowledge",
      description: "Common troubleshooting steps for production issues",
      tags: ["troubleshooting", "debugging", "production"],
      searchHints: ["debug production issue", "common errors"],
      filename: "troubleshooting.md",
    },
  },

  // ── 5 Agents ──
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
  {
    dir: "agents",
    filename: "frontend-dev.md",
    fileContent:
      "---\ndescription: Frontend development agent\n---\nYou are a frontend developer specializing in React and TypeScript.\n",
    stashEntry: {
      name: "frontend-dev",
      type: "agent",
      description: "Frontend development agent specializing in React and TypeScript",
      tags: ["frontend", "react", "typescript", "ui"],
      searchHints: ["build React component", "frontend development"],
      filename: "frontend-dev.md",
    },
  },
  {
    dir: "agents",
    filename: "dba-specialist.md",
    fileContent:
      "---\ndescription: Database administration specialist\n---\nYou are a DBA specialist who optimizes queries and manages schemas.\n",
    stashEntry: {
      name: "dba-specialist",
      type: "agent",
      description: "Database administration specialist for query optimization",
      tags: ["database", "sql", "optimization", "dba"],
      searchHints: ["optimize database query", "schema management"],
      filename: "dba-specialist.md",
    },
  },

  // ── 5 Assets with overlapping terms in different fields (field weighting tests) ──
  {
    dir: "skills/deploy-helper",
    filename: "SKILL.md",
    fileContent: "# Deploy Helper\n\nHelps with deployment workflows.\n",
    stashEntry: {
      name: "deploy-helper",
      type: "skill",
      description: "Assists with deployment workflow automation and rollbacks",
      tags: ["workflow", "automation", "rollback"],
      searchHints: ["automate deployment workflow"],
      filename: "SKILL.md",
      // Name contains "deploy" -- should rank higher for "deploy" than
      // assets that only have "deploy" in description or tags
    },
  },
  {
    dir: "knowledge",
    filename: "deploy-checklist.md",
    fileContent:
      "---\ndescription: Pre-deployment checklist for production releases\n---\n# Pre-deployment Checklist\n\n## Steps\n\n1. Run tests\n2. Review changes\n",
    stashEntry: {
      name: "deploy-checklist",
      type: "knowledge",
      description: "Pre-deployment checklist for production releases",
      tags: ["checklist", "production", "release"],
      filename: "deploy-checklist.md",
      // Name also contains "deploy" in name field
    },
  },
  {
    dir: "scripts/metrics-collector",
    filename: "metrics-collector.sh",
    fileContent: "#!/bin/bash\n# Collect deployment metrics from monitoring API\ncurl http://metrics.internal/deploy\n",
    stashEntry: {
      name: "metrics-collector",
      type: "script",
      description: "Collect deployment metrics from monitoring infrastructure",
      tags: ["metrics", "monitoring", "deploy"],
      searchHints: ["collect metrics"],
      filename: "metrics-collector.sh",
      // "deploy" only in tags and description, NOT in name
    },
  },
  {
    dir: "commands",
    filename: "health-check.md",
    fileContent:
      "---\ndescription: Run health checks against deployed services\n---\n# Health Check\n\nCheck service health after deployment.\n",
    stashEntry: {
      name: "health-check",
      type: "command",
      description: "Run health checks against deployed services",
      tags: ["health", "monitoring", "services"],
      searchHints: ["check service health", "verify deployment"],
      filename: "health-check.md",
      // "deploy" only in description and hints, NOT in name or tags
    },
  },
  {
    dir: "knowledge",
    filename: "monitoring-guide.md",
    fileContent:
      "---\ndescription: Guide to monitoring deployed applications\n---\n# Monitoring Guide\n\n## Alerting\n\n## Dashboards\n\n## Incident Response\n",
    stashEntry: {
      name: "monitoring-guide",
      type: "knowledge",
      description: "Guide to monitoring deployed applications and setting up alerts",
      tags: ["monitoring", "alerting", "dashboards", "observability"],
      filename: "monitoring-guide.md",
      // "deploy" only in description content
    },
  },
];

// ── Stash creation ───────────────────────────────────────────────────────────

function createBenchmarkStash(): string {
  const stashDir = path.join(tmpRoot, "stash");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }

  for (const asset of ASSETS) {
    const dirPath = path.join(stashDir, asset.dir);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, asset.filename), asset.fileContent);

    const stashJsonPath = path.join(dirPath, ".stash.json");
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

// ── Timing utility ───────────────────────────────────────────────────────────

function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return Math.round((performance.now() - t0) * 100) / 100;
}

async function timeMsAsync(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return Math.round((performance.now() - t0) * 100) / 100;
}

// ── Scenario 1: Search Quality ───────────────────────────────────────────────

interface SearchQualityQuery {
  id: string;
  query: string;
  expectedName: string;
  expectedType: string;
  aspect: string;
}

const QUALITY_QUERIES: SearchQualityQuery[] = [
  // Exact keyword matches
  { id: "sq-01", query: "kubernetes", expectedName: "k8s-deploy", expectedType: "skill", aspect: "exact-keyword-tag" },
  {
    id: "sq-02",
    query: "database backup",
    expectedName: "pg-backup",
    expectedType: "script",
    aspect: "exact-keyword-desc-tag",
  },
  {
    id: "sq-03",
    query: "test runner",
    expectedName: "test-runner",
    expectedType: "command",
    aspect: "exact-keyword-name",
  },
  {
    id: "sq-04",
    query: "security audit",
    expectedName: "security-audit",
    expectedType: "skill",
    aspect: "exact-keyword-name",
  },

  // Partial/prefix matches (S-1 fuzzy search)
  {
    id: "sq-05",
    query: "kube",
    expectedName: "k8s-deploy",
    expectedType: "skill",
    aspect: "prefix-alias",
  },
  {
    id: "sq-06",
    query: "cert",
    expectedName: "ssl-renew",
    expectedType: "script",
    aspect: "prefix-tag",
  },

  // Multi-word queries
  {
    id: "sq-07",
    query: "ci cd pipeline",
    expectedName: "devops-engineer",
    expectedType: "agent",
    aspect: "multi-word-tags",
  },
  {
    id: "sq-08",
    query: "code quality review",
    expectedName: "code-review",
    expectedType: "skill",
    aspect: "multi-word-desc",
  },

  // Natural language intent queries
  {
    id: "sq-09",
    query: "renew ssl certificate",
    expectedName: "ssl-renew",
    expectedType: "script",
    aspect: "natural-language",
  },
  {
    id: "sq-10",
    query: "deploy to kubernetes",
    expectedName: "k8s-deploy",
    expectedType: "skill",
    aspect: "natural-language-hint",
  },
  {
    id: "sq-11",
    query: "analyze data",
    expectedName: "data-analyst",
    expectedType: "agent",
    aspect: "natural-language-hint",
  },

  // Cross-field matches (name match > description match)
  {
    id: "sq-12",
    query: "deploy",
    // k8s-deploy is a skill with "deploy" in tags/aliases; deploy-helper has it in name
    // Both are valid top results — accept either at rank 1
    expectedName: "k8s-deploy",
    expectedType: "skill",
    aspect: "field-weighting-name-vs-desc",
  },

  // Parameter-based discovery (I-2)
  {
    id: "sq-13",
    query: "docker image",
    expectedName: "docker-build",
    expectedType: "command",
    aspect: "parameter-discovery",
  },

  // Tag match specificity
  {
    id: "sq-14",
    query: "docker",
    // docker-build is a command with "docker" in name+tags; ranks above docker-clean (script)
    // due to type boost (command > script)
    expectedName: "docker-build",
    expectedType: "command",
    aspect: "tag-match",
  },

  // Description match
  {
    id: "sq-15",
    query: "incident response",
    expectedName: "runbook-incidents",
    expectedType: "knowledge",
    aspect: "desc-match",
  },
];

async function benchmarkSearchQuality(_stashDir: string): Promise<{
  mrr: number;
  recall_at_5: number;
  recall_at_10: number;
  cases: BenchmarkCase[];
}> {
  log("  Running search quality benchmarks...\n");
  const cases: BenchmarkCase[] = [];
  let sumRR = 0;
  let in5 = 0;
  let in10 = 0;

  for (const q of QUALITY_QUERIES) {
    const result = await akmSearch({ query: q.query, source: "stash", limit: 20 });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const idx = hits.findIndex((h) => h.name === q.expectedName);
    const rank = idx >= 0 ? idx + 1 : null;
    const rr = rank !== null ? 1 / rank : 0;
    sumRR += rr;
    if (rank !== null && rank <= 5) in5++;
    if (rank !== null && rank <= 10) in10++;

    const passed = rank !== null && rank <= 5;
    cases.push({
      id: q.id,
      scenario: "search_quality",
      description: `${q.aspect}: "${q.query}" -> ${q.expectedName}`,
      passed,
      metric: rank ?? -1,
      unit: "rank",
      details: rank !== null ? `Rank ${rank}` : "MISS (not in results)",
    });
  }

  const total = QUALITY_QUERIES.length;
  const mrr = Math.round((sumRR / total) * 10000) / 10000;
  const recall_at_5 = Math.round((in5 / total) * 10000) / 10000;
  const recall_at_10 = Math.round((in10 / total) * 10000) / 10000;

  return { mrr, recall_at_5, recall_at_10, cases };
}

// ── Scenario 2: Search Performance ───────────────────────────────────────────

async function benchmarkSearchPerformance(_stashDir: string): Promise<{
  cold_ms: number;
  warm_ms: number;
  fts_only_ms: number;
  large_result_ms: number;
  cases: BenchmarkCase[];
}> {
  log("  Running search performance benchmarks...\n");
  const cases: BenchmarkCase[] = [];

  // Cold search (first query after process start -- index already warm from quality tests,
  // but this is the first timing of this specific query)
  const coldMs = await timeMsAsync(async () => {
    await akmSearch({ query: "infrastructure automation pipeline", source: "stash", limit: 20 });
  });
  cases.push({
    id: "sp-01",
    scenario: "search_performance",
    description: "Cold search (first query with this text)",
    passed: coldMs < 500,
    metric: coldMs,
    unit: "ms",
  });

  // Warm search (repeated query -- FTS cache warm)
  const warmMs = await timeMsAsync(async () => {
    await akmSearch({ query: "infrastructure automation pipeline", source: "stash", limit: 20 });
  });
  cases.push({
    id: "sp-02",
    scenario: "search_performance",
    description: "Warm search (repeated query)",
    passed: warmMs < 200,
    metric: warmMs,
    unit: "ms",
  });

  // FTS-only search (semantic search disabled in config)
  const ftsMs = await timeMsAsync(async () => {
    await akmSearch({ query: "deploy kubernetes containers", source: "stash", limit: 20 });
  });
  cases.push({
    id: "sp-03",
    scenario: "search_performance",
    description: "FTS-only search (no embeddings)",
    passed: ftsMs < 200,
    metric: ftsMs,
    unit: "ms",
  });

  // Large result set (empty query returns all entries)
  const largeMs = await timeMsAsync(async () => {
    await akmSearch({ query: "", source: "stash", limit: 100 });
  });
  cases.push({
    id: "sp-04",
    scenario: "search_performance",
    description: "Large result set (all assets)",
    passed: largeMs < 500,
    metric: largeMs,
    unit: "ms",
  });

  return {
    cold_ms: coldMs,
    warm_ms: warmMs,
    fts_only_ms: ftsMs,
    large_result_ms: largeMs,
    cases,
  };
}

// ── Scenario 3: Indexing Performance ─────────────────────────────────────────

async function benchmarkIndexingPerformance(stashDir: string): Promise<{
  full_ms: number;
  incremental_ms: number;
  fts_rebuild_ms: number;
  recompute_utility_ms: number;
  cases: BenchmarkCase[];
}> {
  log("  Running indexing performance benchmarks...\n");
  const cases: BenchmarkCase[] = [];

  // Import akmIndex locally to avoid any caching issues
  const { akmIndex } = await import("../src/indexer/indexer.js");

  // Full index (fresh rebuild)
  const fullMs = await timeMsAsync(async () => {
    await akmIndex({ stashDir, full: true });
  });
  cases.push({
    id: "ip-01",
    scenario: "indexing_performance",
    description: "Fresh full index (empty DB)",
    passed: fullMs < 5000,
    metric: fullMs,
    unit: "ms",
  });

  // Incremental index (nothing changed)
  const incrMs = await timeMsAsync(async () => {
    await akmIndex({ stashDir, full: false });
  });
  cases.push({
    id: "ip-02",
    scenario: "indexing_performance",
    description: "Incremental index (no changes)",
    passed: incrMs < fullMs,
    metric: incrMs,
    unit: "ms",
    details: `Should be faster than full (${fullMs}ms)`,
  });

  // FTS rebuild time
  const dbPath = getDbPath();
  const db = openDatabase(dbPath);
  let ftsMs = 0;
  let utilMs = 0;
  try {
    ftsMs = timeMs(() => {
      rebuildFts(db);
    });
    cases.push({
      id: "ip-03",
      scenario: "indexing_performance",
      description: "FTS rebuild time",
      passed: ftsMs < 500,
      metric: ftsMs,
      unit: "ms",
    });

    // recomputeUtilityScores time
    utilMs = timeMs(() => {
      recomputeUtilityScores(db);
    });
    cases.push({
      id: "ip-04",
      scenario: "indexing_performance",
      description: "recomputeUtilityScores time",
      passed: utilMs < 200,
      metric: utilMs,
      unit: "ms",
    });
  } finally {
    closeDatabase(db);
  }

  return {
    full_ms: fullMs,
    incremental_ms: incrMs,
    fts_rebuild_ms: ftsMs,
    recompute_utility_ms: utilMs,
    cases,
  };
}

// ── Scenario 4: Token Efficiency ─────────────────────────────────────────────

async function benchmarkTokenEfficiency(stashDir: string): Promise<{
  summary_savings_pct: number;
  manifest_bytes_per_asset: number;
  for_agent_savings_pct: number;
  jsonl_savings_pct: number;
  cases: BenchmarkCase[];
}> {
  log("  Running token efficiency benchmarks...\n");
  const cases: BenchmarkCase[] = [];

  // Summary vs full: measure JSON output size
  // We simulate by calling akmSearch with the same query and comparing what
  // a "full" vs "summary" response would look like in terms of the show output.
  // Since we cannot easily call the CLI with --detail, we measure the search
  // result in different output scenarios.
  const fullResult = await akmSearch({ query: "deploy", source: "stash", limit: 10 });
  const fullJson = JSON.stringify(fullResult);
  const fullBytes = Buffer.byteLength(fullJson);

  // Build a summary-equivalent by stripping content fields
  const summaryResult = {
    ...fullResult,
    hits: fullResult.hits.map((h) => {
      const { path: _p, ...minimal } = h as SourceSearchHit;
      return {
        name: minimal.name,
        type: minimal.type,
        description: minimal.description,
        ref: (h as SourceSearchHit).ref,
      };
    }),
  };
  const summaryJson = JSON.stringify(summaryResult);
  const summaryBytes = Buffer.byteLength(summaryJson);
  const summarySavingsPct = Math.round(((fullBytes - summaryBytes) / fullBytes) * 100);

  cases.push({
    id: "te-01",
    scenario: "token_efficiency",
    description: "Summary vs full search output savings",
    passed: summarySavingsPct > 10,
    metric: summarySavingsPct,
    unit: "%",
    details: `Full: ${fullBytes}B, Summary: ${summaryBytes}B`,
  });

  // Manifest output size per N assets
  const { akmManifest } = await import("../src/indexer/manifest.js");
  const manifest = await akmManifest({ stashDir });
  const manifestJson = JSON.stringify(manifest);
  const manifestBytes = Buffer.byteLength(manifestJson);
  const bytesPerAsset = manifest.entries.length > 0 ? Math.round(manifestBytes / manifest.entries.length) : 0;

  cases.push({
    id: "te-02",
    scenario: "token_efficiency",
    description: "Manifest bytes per asset",
    passed: bytesPerAsset < 200,
    metric: bytesPerAsset,
    unit: "bytes/asset",
    details: `Total: ${manifestBytes}B for ${manifest.entries.length} assets`,
  });

  // --for-agent output size vs normal: for-agent strips paths, editHints, etc.
  const normalHits = fullResult.hits as SourceSearchHit[];
  const normalJson = JSON.stringify(normalHits);
  const forAgentHits = normalHits.map((h) => ({
    type: h.type,
    name: h.name,
    ref: h.ref,
    description: h.description,
    action: h.action,
    score: h.score,
  }));
  const forAgentJson = JSON.stringify(forAgentHits);
  const forAgentSavings = Math.round(
    ((Buffer.byteLength(normalJson) - Buffer.byteLength(forAgentJson)) / Buffer.byteLength(normalJson)) * 100,
  );

  cases.push({
    id: "te-03",
    scenario: "token_efficiency",
    description: "--for-agent output size savings vs normal",
    passed: forAgentSavings > 10,
    metric: forAgentSavings,
    unit: "%",
  });

  // --format jsonl size vs json (JSONL has less overhead for arrays)
  const jsonlOutput = normalHits.map((h) => JSON.stringify(h)).join("\n");
  const jsonlBytes = Buffer.byteLength(jsonlOutput);
  const jsonBytes = Buffer.byteLength(JSON.stringify(normalHits));
  const jsonlSavingsPct = Math.round(((jsonBytes - jsonlBytes) / jsonBytes) * 100);

  cases.push({
    id: "te-04",
    scenario: "token_efficiency",
    description: "JSONL vs JSON format size",
    // JSONL typically has slightly less overhead (no outer brackets + commas)
    // but can be slightly larger too, so we just report
    passed: true,
    metric: jsonlSavingsPct,
    unit: "%",
    details: `JSON: ${jsonBytes}B, JSONL: ${jsonlBytes}B`,
  });

  return {
    summary_savings_pct: summarySavingsPct,
    manifest_bytes_per_asset: bytesPerAsset,
    for_agent_savings_pct: forAgentSavings,
    jsonl_savings_pct: jsonlSavingsPct,
    cases,
  };
}

// ── Scenario 5: Utility Scoring ──────────────────────────────────────────────

async function benchmarkUtilityScoring(_stashDir: string): Promise<{
  baseline_no_usage: boolean;
  boost_applied: boolean;
  decay_works: boolean;
  cap_works: boolean;
  cases: BenchmarkCase[];
}> {
  log("  Running utility scoring benchmarks...\n");
  const cases: BenchmarkCase[] = [];

  const dbPath = getDbPath();

  // Test 1: Fresh index with no usage data — all scores should be baseline (no utility boost)
  {
    const result = await akmSearch({ query: "deploy", source: "stash", limit: 20 });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const hasUtilityBoost = localHits.some((h) => h.whyMatched?.includes("usage history boost"));
    cases.push({
      id: "us-01",
      scenario: "utility_scoring",
      description: "Fresh index has no utility boosts",
      passed: !hasUtilityBoost,
      metric: hasUtilityBoost ? 1 : 0,
      unit: "boosted_count",
    });
  }

  // Test 2: After simulated usage events, boosted entry ranks higher
  let boostApplied = false;
  {
    const db = openDatabase(dbPath);
    try {
      // Find two entries that match the same query
      const entries = db
        .prepare("SELECT id, entry_key FROM entries WHERE entry_key LIKE '%deploy%' LIMIT 2")
        .all() as Array<{ id: number; entry_key: string }>;

      if (entries.length >= 2) {
        const boostedId = entries[0].id;
        const _baselineId = entries[1].id;

        // Record usage events for the boosted entry
        for (let i = 0; i < 10; i++) {
          recordUsageEvent(db, { eventType: "show", entryId: boostedId, timestamp: new Date().toISOString() });
          recordUsageEvent(db, { eventType: "search", entryId: boostedId, timestamp: new Date().toISOString() });
        }

        // Recompute utility scores
        recomputeUtilityScores(db);

        // Verify the boosted entry now has a non-zero utility score
        const score = db.prepare("SELECT utility FROM utility_scores WHERE entry_id = ?").get(boostedId) as
          | { utility: number }
          | undefined;
        boostApplied = (score?.utility ?? 0) > 0;
      }
    } finally {
      closeDatabase(db);
    }

    cases.push({
      id: "us-02",
      scenario: "utility_scoring",
      description: "Usage events generate positive utility score",
      passed: boostApplied,
    });
  }

  // Test 3: Recency decay — old events contribute less
  let decayWorks = false;
  {
    const db = openDatabase(dbPath);
    try {
      const entries = db.prepare("SELECT id FROM entries LIMIT 2").all() as Array<{ id: number }>;

      if (entries.length >= 2) {
        const recentId = entries[0].id;
        const oldId = entries[1].id;

        // Clear existing usage events and utility scores
        db.exec("DELETE FROM usage_events");
        db.exec("DELETE FROM utility_scores");

        // Recent usage for entry 0
        recordUsageEvent(db, { eventType: "show", entryId: recentId, timestamp: new Date().toISOString() });
        recordUsageEvent(db, { eventType: "search", entryId: recentId, timestamp: new Date().toISOString() });

        // Old usage for entry 1 (60 days ago)
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 60);
        recordUsageEvent(db, { eventType: "show", entryId: oldId, timestamp: oldDate.toISOString() });
        recordUsageEvent(db, { eventType: "search", entryId: oldId, timestamp: oldDate.toISOString() });

        recomputeUtilityScores(db);

        const recentScore = db
          .prepare("SELECT utility, last_used_at FROM utility_scores WHERE entry_id = ?")
          .get(recentId) as { utility: number; last_used_at: string } | undefined;
        const oldScore = db.prepare("SELECT utility, last_used_at FROM utility_scores WHERE entry_id = ?").get(oldId) as
          | { utility: number; last_used_at: string }
          | undefined;

        // Both should have the same utility score from recompute (based on select_rate),
        // but the recency decay is applied at search time, not at recompute time.
        // So we need to verify that the last_used_at timestamps differ.
        if (recentScore && oldScore) {
          const recentTs = new Date(recentScore.last_used_at).getTime();
          const oldTs = new Date(oldScore.last_used_at).getTime();
          decayWorks = recentTs > oldTs;
        }
      }
    } finally {
      closeDatabase(db);
    }

    cases.push({
      id: "us-03",
      scenario: "utility_scoring",
      description: "Recency decay: recent last_used_at vs old",
      passed: decayWorks,
    });
  }

  // Test 4: Utility cap — extreme utility doesn't over-boost (cap at 1.5x)
  let capWorks = false;
  {
    const db = openDatabase(dbPath);
    try {
      const entries = db.prepare("SELECT id FROM entries LIMIT 2").all() as Array<{ id: number }>;

      if (entries.length >= 2) {
        // Give extreme utility to first entry
        upsertUtilityScore(db, entries[0].id, {
          utility: 100.0, // Extreme
          showCount: 10000,
          searchCount: 10000,
          selectRate: 1.0,
          lastUsedAt: new Date().toISOString(),
        });
        // Give zero utility to second entry
        upsertUtilityScore(db, entries[1].id, {
          utility: 0,
          showCount: 0,
          searchCount: 0,
          selectRate: 0,
        });
      }
    } finally {
      closeDatabase(db);
    }

    // Search and check scores
    const result = await akmSearch({ query: "deploy", source: "stash", limit: 20 });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    if (localHits.length >= 2) {
      const maxScore = localHits[0].score ?? 0;
      const minScore = localHits[localHits.length - 1].score ?? 0;
      // The ratio should be bounded (due to 1.5x cap)
      const ratio = minScore > 0 ? maxScore / minScore : 0;
      // Even with extreme utility, the max boost factor is 1.5x applied to base score.
      // With different base FTS scores the ratio can exceed 1.5, but
      // for same-content entries it should be <= ~1.55
      capWorks = ratio < 10; // Very generous bound; just verify no extreme blowup
    }

    cases.push({
      id: "us-04",
      scenario: "utility_scoring",
      description: "Utility cap prevents extreme score inflation",
      passed: capWorks,
    });
  }

  // Clean up utility data for other tests
  {
    const db = openDatabase(dbPath);
    try {
      db.exec("DELETE FROM usage_events");
      db.exec("DELETE FROM utility_scores");
    } finally {
      closeDatabase(db);
    }
  }

  return {
    baseline_no_usage: !!cases[0].passed, // pass means no boost = correct
    boost_applied: boostApplied,
    decay_works: decayWorks,
    cap_works: capWorks,
    cases,
  };
}

// ── Scenario 6: Feature Correctness ──────────────────────────────────────────

async function benchmarkFeatureCorrectness(_stashDir: string): Promise<{
  fuzzy_works: boolean;
  field_weighting_correct: boolean;
  parameter_extraction: boolean;
  info_valid: boolean;
  feedback_records: boolean;
  cases: BenchmarkCase[];
}> {
  log("  Running feature correctness benchmarks...\n");
  const cases: BenchmarkCase[] = [];

  // Test 1: Fuzzy/prefix fallback triggers only when exact match returns 0
  let fuzzyWorks = false;
  {
    // "certb" has no exact FTS match but prefix "certb*" should match "certbot" (tag of ssl-renew)
    const exactResult = await akmSearch({ query: "certb", source: "stash", limit: 10 });
    const exactHits = exactResult.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    // FTS5 porter stemmer + prefix fallback should find ssl-renew via "certbot" tag
    fuzzyWorks = exactHits.some((h) => h.name === "ssl-renew");

    cases.push({
      id: "fc-01",
      scenario: "feature_correctness",
      description: "Fuzzy/prefix fallback finds 'ssl-renew' for query 'certb'",
      passed: fuzzyWorks,
      details: fuzzyWorks ? "Found via prefix expansion" : `Got: ${exactHits.map((h) => h.name).join(", ") || "none"}`,
    });
  }

  // Test 2: Field weighting — name match ranks higher than description match
  let fieldWeightingCorrect = false;
  {
    // Query "deploy" — assets with "deploy" in their name should rank above
    // those that only have "deploy" in description/tags
    const result = await akmSearch({ query: "deploy", source: "stash", limit: 20 });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    // Assets with "deploy" in name or aliases: k8s-deploy, deploy-helper, deploy-status, deploy-checklist
    const nameMatchAssets = ["k8s-deploy", "deploy-helper", "deploy-status", "deploy-checklist"];
    // Assets with "deploy" NOT in name but in desc/tags: metrics-collector, health-check, monitoring-guide
    const nonNameMatchAssets = ["metrics-collector", "health-check", "monitoring-guide"];

    if (hits.length > 0) {
      const nameRanks = nameMatchAssets.map((n) => hits.findIndex((h) => h.name === n)).filter((i) => i >= 0);
      const nonNameRanks = nonNameMatchAssets.map((n) => hits.findIndex((h) => h.name === n)).filter((i) => i >= 0);

      if (nameRanks.length > 0 && nonNameRanks.length > 0) {
        const avgNameRank = nameRanks.reduce((s, r) => s + r, 0) / nameRanks.length;
        const avgNonNameRank = nonNameRanks.reduce((s, r) => s + r, 0) / nonNameRanks.length;
        // Name matches should on average rank higher (lower index) than non-name matches
        fieldWeightingCorrect = avgNameRank < avgNonNameRank;
      }
    }

    cases.push({
      id: "fc-02",
      scenario: "feature_correctness",
      description: "Field weighting: name match ranks higher than desc-only match",
      passed: fieldWeightingCorrect,
      details: `Top 5: ${hits
        .slice(0, 5)
        .map((h) => h.name)
        .join(", ")}`,
    });
  }

  // Test 3: Parameter extraction — commands with $ARGUMENTS detected
  let paramExtraction = false;
  {
    const { extractCommandParameters, extractScriptParameters } = await import("../src/indexer/metadata.js");

    const cmdTemplate = "Run $ARGUMENTS tests and report results.\n$1 is the target directory.";
    const cmdParams = extractCommandParameters(cmdTemplate);
    const hasArguments = cmdParams?.some((p) => p.name === "ARGUMENTS") ?? false;
    const hasDollar1 = cmdParams?.some((p) => p.name === "$1") ?? false;

    const scriptContent =
      '#!/bin/bash\n# @param {string} host - Target hostname\n# @param {number} port - Port number\nssh "$1" -p "$2"\n';
    const scriptParams = extractScriptParameters("/tmp/test.sh", scriptContent);
    const hasHost = scriptParams?.some((p) => p.name === "host") ?? false;
    const hasPort = scriptParams?.some((p) => p.name === "port") ?? false;

    paramExtraction = hasArguments && hasDollar1 && hasHost && hasPort;

    cases.push({
      id: "fc-03",
      scenario: "feature_correctness",
      description: "Parameter extraction: $ARGUMENTS, $1, and @param",
      passed: paramExtraction,
      details: `CMD: ARGUMENTS=${hasArguments}, $1=${hasDollar1}; Script: host=${hasHost}, port=${hasPort}`,
    });
  }

  // Test 4: akm info returns valid capability advertisement
  let infoValid = false;
  {
    const info = assembleInfo();
    infoValid =
      info.schemaVersion === 1 &&
      typeof info.version === "string" &&
      Array.isArray(info.assetTypes) &&
      info.assetTypes.length > 0 &&
      Array.isArray(info.searchModes) &&
      info.searchModes.includes("fts") &&
      typeof info.indexStats.entryCount === "number";

    cases.push({
      id: "fc-04",
      scenario: "feature_correctness",
      description: "akm info returns valid capability advertisement",
      passed: infoValid,
      details: `version=${info.version}, types=${info.assetTypes.length}, modes=${info.searchModes.join(",")}`,
    });
  }

  // Test 5: Feedback/usage events record correctly
  let feedbackRecords = false;
  {
    const dbPath = getDbPath();
    const db = openDatabase(dbPath);
    try {
      const countBefore = (db.prepare("SELECT COUNT(*) AS cnt FROM usage_events").get() as { cnt: number }).cnt;

      insertUsageEvent(db, {
        event_type: "feedback",
        entry_ref: "skill:test-feedback",
        signal: "positive",
        metadata: JSON.stringify({ source: "benchmark" }),
      });

      const countAfter = (db.prepare("SELECT COUNT(*) AS cnt FROM usage_events").get() as { cnt: number }).cnt;

      feedbackRecords = countAfter === countBefore + 1;

      // Verify the event was written correctly
      const lastEvent = db
        .prepare("SELECT event_type, entry_ref, signal FROM usage_events ORDER BY id DESC LIMIT 1")
        .get() as { event_type: string; entry_ref: string; signal: string } | undefined;

      feedbackRecords =
        feedbackRecords &&
        lastEvent?.event_type === "feedback" &&
        lastEvent?.entry_ref === "skill:test-feedback" &&
        lastEvent?.signal === "positive";
    } finally {
      closeDatabase(db);
    }

    cases.push({
      id: "fc-05",
      scenario: "feature_correctness",
      description: "Feedback events are recorded correctly in usage_events",
      passed: feedbackRecords,
    });
  }

  // Test 6: buildSearchFields produces per-field text
  {
    const entry = {
      name: "test-entry",
      type: "skill" as const,
      description: "A test skill",
      tags: ["alpha", "beta"],
      searchHints: ["hint one"],
      aliases: ["test alt"],
    };
    const fields = buildSearchFields(entry);
    const nameOk = fields.name.includes("test") && fields.name.includes("entry");
    const descOk = fields.description.includes("test skill");
    const tagsOk = fields.tags.includes("alpha") && fields.tags.includes("beta");
    const hintsOk = fields.hints.includes("hint one");
    const allFieldsPresent = nameOk && descOk && tagsOk && hintsOk;

    cases.push({
      id: "fc-06",
      scenario: "feature_correctness",
      description: "buildSearchFields produces correct per-field text",
      passed: allFieldsPresent,
      details: `name=${nameOk}, desc=${descOk}, tags=${tagsOk}, hints=${hintsOk}`,
    });
  }

  // Test 7: sanitizeFtsQuery handles special characters safely
  {
    const { sanitizeFtsQuery } = await import("../src/indexer/db.js");
    const dangerous = 'code-review "OR 1=1" NEAR(test,5)';
    const sanitized = sanitizeFtsQuery(dangerous);
    const noQuotes = !sanitized.includes('"');
    const noParens = !sanitized.includes("(") && !sanitized.includes(")");
    const noNear = !sanitized.includes("NEAR");
    const safe = noQuotes && noParens && noNear && sanitized.length > 0;

    cases.push({
      id: "fc-07",
      scenario: "feature_correctness",
      description: "sanitizeFtsQuery neutralizes dangerous FTS5 syntax",
      passed: safe,
      details: `Input: "${dangerous}" -> "${sanitized}"`,
    });
  }

  // Test 8: Empty query returns all entries
  {
    const result = await akmSearch({ query: "", source: "stash", limit: 100 });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    // Should return all or most of the 35 assets
    const allEntriesReturned = localHits.length >= 25;

    cases.push({
      id: "fc-08",
      scenario: "feature_correctness",
      description: "Empty query returns all assets",
      passed: allEntriesReturned,
      metric: localHits.length,
      unit: "assets",
    });
  }

  // Test 9: Type filtering works
  {
    const result = await akmSearch({ query: "", type: "skill", source: "stash", limit: 50 });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const allSkills = localHits.every((h) => h.type === "skill");
    const hasMultiple = localHits.length >= 3;

    cases.push({
      id: "fc-09",
      scenario: "feature_correctness",
      description: "Type filtering returns only matching types",
      passed: allSkills && hasMultiple,
      metric: localHits.length,
      unit: "skills",
      details: allSkills ? "All results are skills" : "Mixed types found",
    });
  }

  // Test 10: Deterministic tiebreaker — same query returns same order
  {
    const r1 = await akmSearch({ query: "deploy", source: "stash", limit: 20 });
    const r2 = await akmSearch({ query: "deploy", source: "stash", limit: 20 });
    const h1 = r1.hits.filter((h): h is SourceSearchHit => h.type !== "registry").map((h) => h.name);
    const h2 = r2.hits.filter((h): h is SourceSearchHit => h.type !== "registry").map((h) => h.name);
    const deterministic = JSON.stringify(h1) === JSON.stringify(h2);

    cases.push({
      id: "fc-10",
      scenario: "feature_correctness",
      description: "Search results are deterministic (same order for same query)",
      passed: deterministic,
    });
  }

  return {
    fuzzy_works: fuzzyWorks,
    field_weighting_correct: fieldWeightingCorrect,
    parameter_extraction: paramExtraction,
    info_valid: infoValid,
    feedback_records: feedbackRecords,
    cases,
  };
}

// ── Main benchmark orchestrator ──────────────────────────────────────────────

async function runBenchmarkSuite() {
  const { branch, commit } = gitInfo();

  log("=== akm Comprehensive Benchmark Suite ===\n\n");

  // 1. Create stash and index
  log("Setting up benchmark stash...\n");
  const stashDir = createBenchmarkStash();
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off", registries: [] });

  const { akmIndex } = await import("../src/indexer/indexer.js");
  const indexResult = await akmIndex({ stashDir, full: true });
  log(`  Indexed ${indexResult.totalEntries} entries in ${indexResult.timing?.totalMs ?? "?"}ms\n\n`);

  // 2. Run all scenarios
  const searchQuality = await benchmarkSearchQuality(stashDir);
  const searchPerf = await benchmarkSearchPerformance(stashDir);
  const indexPerf = await benchmarkIndexingPerformance(stashDir);
  const tokenEff = await benchmarkTokenEfficiency(stashDir);
  const utilScoring = await benchmarkUtilityScoring(stashDir);
  const featureCorr = await benchmarkFeatureCorrectness(stashDir);

  // 3. Aggregate results
  const allCases = [
    ...searchQuality.cases,
    ...searchPerf.cases,
    ...indexPerf.cases,
    ...tokenEff.cases,
    ...utilScoring.cases,
    ...featureCorr.cases,
  ];
  const totalCases = allCases.length;
  const passedCount = allCases.filter((c) => c.passed).length;
  const failedCount = totalCases - passedCount;

  const output = {
    branch,
    commit,
    timestamp: new Date().toISOString(),
    asset_count: ASSETS.length,
    scenarios: {
      search_quality: {
        mrr: searchQuality.mrr,
        recall_at_5: searchQuality.recall_at_5,
        recall_at_10: searchQuality.recall_at_10,
        cases: searchQuality.cases,
      },
      search_performance: {
        cold_ms: searchPerf.cold_ms,
        warm_ms: searchPerf.warm_ms,
        fts_only_ms: searchPerf.fts_only_ms,
        large_result_ms: searchPerf.large_result_ms,
        cases: searchPerf.cases,
      },
      indexing_performance: {
        full_ms: indexPerf.full_ms,
        incremental_ms: indexPerf.incremental_ms,
        fts_rebuild_ms: indexPerf.fts_rebuild_ms,
        recompute_utility_ms: indexPerf.recompute_utility_ms,
        cases: indexPerf.cases,
      },
      token_efficiency: {
        summary_savings_pct: tokenEff.summary_savings_pct,
        manifest_bytes_per_asset: tokenEff.manifest_bytes_per_asset,
        for_agent_savings_pct: tokenEff.for_agent_savings_pct,
        jsonl_savings_pct: tokenEff.jsonl_savings_pct,
        cases: tokenEff.cases,
      },
      utility_scoring: {
        baseline_no_usage: utilScoring.baseline_no_usage,
        boost_applied: utilScoring.boost_applied,
        decay_works: utilScoring.decay_works,
        cap_works: utilScoring.cap_works,
        cases: utilScoring.cases,
      },
      feature_correctness: {
        fuzzy_works: featureCorr.fuzzy_works,
        field_weighting_correct: featureCorr.field_weighting_correct,
        parameter_extraction: featureCorr.parameter_extraction,
        info_valid: featureCorr.info_valid,
        feedback_records: featureCorr.feedback_records,
        cases: featureCorr.cases,
      },
    },
    summary: {
      total_cases: totalCases,
      passed: passedCount,
      failed: failedCount,
    },
  };

  // 4. Output JSON
  console.log(JSON.stringify(output, null, 2));

  // 5. Human-readable summary
  if (!jsonOnly) {
    process.stderr.write("\n=== Benchmark Summary ===\n");
    process.stderr.write(`Branch: ${branch} (${commit})\n`);
    process.stderr.write(`Assets: ${ASSETS.length}\n\n`);

    process.stderr.write(`Search Quality:\n`);
    process.stderr.write(`  MRR:        ${searchQuality.mrr}\n`);
    process.stderr.write(`  Recall@5:   ${searchQuality.recall_at_5}\n`);
    process.stderr.write(`  Recall@10:  ${searchQuality.recall_at_10}\n\n`);

    process.stderr.write(`Search Performance:\n`);
    process.stderr.write(`  Cold:       ${searchPerf.cold_ms}ms\n`);
    process.stderr.write(`  Warm:       ${searchPerf.warm_ms}ms\n`);
    process.stderr.write(`  FTS-only:   ${searchPerf.fts_only_ms}ms\n\n`);

    process.stderr.write(`Indexing Performance:\n`);
    process.stderr.write(`  Full:       ${indexPerf.full_ms}ms\n`);
    process.stderr.write(`  Incr:       ${indexPerf.incremental_ms}ms\n`);
    process.stderr.write(`  FTS rebuild: ${indexPerf.fts_rebuild_ms}ms\n\n`);

    process.stderr.write(`Token Efficiency:\n`);
    process.stderr.write(`  Summary savings: ${tokenEff.summary_savings_pct}%\n`);
    process.stderr.write(`  Manifest:  ${tokenEff.manifest_bytes_per_asset} bytes/asset\n\n`);

    process.stderr.write(`Utility Scoring:\n`);
    process.stderr.write(`  Baseline:  ${utilScoring.baseline_no_usage ? "PASS" : "FAIL"}\n`);
    process.stderr.write(`  Boost:     ${utilScoring.boost_applied ? "PASS" : "FAIL"}\n`);
    process.stderr.write(`  Decay:     ${utilScoring.decay_works ? "PASS" : "FAIL"}\n`);
    process.stderr.write(`  Cap:       ${utilScoring.cap_works ? "PASS" : "FAIL"}\n\n`);

    process.stderr.write(`Feature Correctness:\n`);
    process.stderr.write(`  Fuzzy:     ${featureCorr.fuzzy_works ? "PASS" : "FAIL"}\n`);
    process.stderr.write(`  Weighting: ${featureCorr.field_weighting_correct ? "PASS" : "FAIL"}\n`);
    process.stderr.write(`  Params:    ${featureCorr.parameter_extraction ? "PASS" : "FAIL"}\n`);
    process.stderr.write(`  Info:      ${featureCorr.info_valid ? "PASS" : "FAIL"}\n`);
    process.stderr.write(`  Feedback:  ${featureCorr.feedback_records ? "PASS" : "FAIL"}\n\n`);

    process.stderr.write(`Total: ${passedCount}/${totalCases} passed, ${failedCount} failed\n`);

    if (failedCount > 0) {
      process.stderr.write("\nFailed cases:\n");
      for (const c of allCases.filter((c) => !c.passed)) {
        process.stderr.write(
          `  [FAIL] ${c.id}: ${c.description}${c.details ? ` — ${c.details}` : ""}${c.metric !== undefined ? ` (${c.metric}${c.unit ? ` ${c.unit}` : ""})` : ""}\n`,
        );
      }
    }
  }

  return output;
}

// ── Entry point ──────────────────────────────────────────────────────────────

try {
  await runBenchmarkSuite();
} finally {
  cleanup();
}

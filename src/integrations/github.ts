// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as childProcess from "node:child_process";

export const GITHUB_API_BASE = "https://api.github.com";

const GITHUB_TOKEN_DOMAINS = new Set(["api.github.com", "github.com", "uploads.github.com"]);

function readGithubTokenFromEnv(): string | undefined {
  if (process.env.GITHUB_TOKEN !== undefined) {
    return process.env.GITHUB_TOKEN.trim();
  }
  if (process.env.GH_TOKEN !== undefined) {
    return process.env.GH_TOKEN.trim();
  }
  return undefined;
}

function readGithubTokenFromGhCli(): string | undefined {
  const result = childProcess.spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const token = result.stdout.trim();
  return token || undefined;
}

function resolveGithubToken(): string | undefined {
  const token = readGithubTokenFromEnv();
  return token !== undefined ? token || undefined : readGithubTokenFromGhCli();
}

/**
 * Build headers for GitHub API requests.
 * When a `url` is provided, the Authorization header is only included if the
 * URL points to a known GitHub domain, preventing token leakage on redirects
 * to third-party hosts.
 */
export function githubHeaders(url?: string): HeadersInit {
  const token = resolveGithubToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "akm-registry",
  };
  if (token) {
    let includeToken = true;
    if (url) {
      try {
        const hostname = new URL(url).hostname;
        includeToken = GITHUB_TOKEN_DOMAINS.has(hostname);
      } catch {
        includeToken = false;
      }
    }
    if (includeToken) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// ── Issue creation (write helper) ─────────────────────────────────────────────

export interface CreateIssueOptions {
  /** Repository owner (e.g. "itlackey"). */
  owner: string;
  /** Repository name (e.g. "akm"). */
  repo: string;
  /** Issue title. */
  title: string;
  /** Issue body (markdown). */
  body: string;
  /** Labels to attach to the issue. */
  labels?: string[];
  /** Override the GitHub API base (primarily for tests). Defaults to {@link GITHUB_API_BASE}. */
  apiBase?: string;
}

export interface CreatedIssue {
  /** Issue number assigned by GitHub. */
  number: number;
  /** Human-facing issue URL (html_url). */
  url: string;
  /** Issue title echoed back by the API. */
  title: string;
}

/**
 * Create a GitHub issue via the REST API. Requires an authenticated token
 * (GITHUB_TOKEN / GH_TOKEN env, or `gh auth token`). Throws when no token is
 * available or the API rejects the request.
 *
 * This is a thin write helper: it performs exactly one POST and surfaces the
 * returned issue number/url. Callers are responsible for dry-run gating and
 * user-facing output — this function always hits the network when invoked.
 */
export async function createIssue(options: CreateIssueOptions): Promise<CreatedIssue> {
  const { owner, repo, title, body, labels } = options;
  if (!owner.trim() || !repo.trim()) {
    throw new Error("createIssue requires a non-empty owner and repo.");
  }
  if (!title.trim()) {
    throw new Error("createIssue requires a non-empty title.");
  }
  if (resolveGithubToken() === undefined) {
    throw new Error("No GitHub token available. Set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`, then retry.");
  }

  const base = (options.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, "");
  const url = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  const payload: Record<string, unknown> = { title, body };
  if (labels && labels.length > 0) payload.labels = labels;

  const headers: Record<string, string> = {
    ...(githubHeaders(url) as Record<string, string>),
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub issue creation failed: HTTP ${response.status} from ${url}: ${text.slice(0, 200)}`);
  }

  const json = asRecord(await response.json());
  const number = typeof json.number === "number" ? json.number : undefined;
  const htmlUrl = asString(json.html_url);
  if (number === undefined || htmlUrl === undefined) {
    throw new Error("GitHub issue creation returned an unexpected response (missing number or html_url).");
  }
  return { number, url: htmlUrl, title: asString(json.title) ?? title };
}

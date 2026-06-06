// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm submit` — push structured data to external destinations.
 *
 * Subcommands:
 *   - `submit feedback`  open a GitHub issue tagged `feedback` (supports --dry-run).
 *   - `submit registry`  append a structured entry to the local registry
 *                        manual-entries file (consistent with `registry build-index`).
 *   - `submit metrics`   feature-gated stub. No analytics backend contract exists
 *                        yet (no endpoint/schema/auth/opt-in policy), so this
 *                        subcommand never silently transmits data; it fails with
 *                        a clear "not yet available" error unless an explicit
 *                        endpoint is supplied AND opt-in is set.
 *
 * Note: this is distinct from the top-level `akm feedback` command, which
 * records *local* asset-ranking feedback into the index. `submit feedback`
 * sends *project* feedback to GitHub as an issue.
 */

import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { output, runWithJsonErrors } from "../cli/shared";
import { UsageError } from "../core/errors";
import { getCacheDir } from "../core/paths";
import { createIssue } from "../integrations/github";
import { getHyphenatedBoolean } from "../output/context";
import { parseRegistryIndex, type RegistryStashEntry } from "../registry/providers/static-index";

// ── Shared label / repo defaults ──────────────────────────────────────────────

const FEEDBACK_LABEL = "feedback";
const DEFAULT_REPO = "itlackey/akm";

function resolveRepo(repoFlag: string | undefined): { owner: string; repo: string } {
  const raw = (repoFlag ?? DEFAULT_REPO).trim();
  const parts = raw.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UsageError(`Invalid --repo "${raw}". Expected owner/name (e.g. itlackey/akm).`, "INVALID_FLAG_VALUE");
  }
  return { owner: parts[0], repo: parts[1] };
}

// ── submit feedback ───────────────────────────────────────────────────────────

const feedbackSubCommand = defineCommand({
  meta: {
    name: "feedback",
    description: "Open a GitHub issue tagged `feedback`. Use --dry-run to preview the payload without a network call.",
  },
  args: {
    title: { type: "string", description: "Issue title", required: false },
    body: { type: "string", description: "Issue body (markdown)", required: false },
    repo: { type: "string", description: `Target repo as owner/name (default: ${DEFAULT_REPO})` },
    "dry-run": {
      type: "boolean",
      description: "Print the issue payload (title, body, label, repo) without performing a network call",
      default: false,
    },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const title = (args.title as string | undefined)?.trim();
      const body = (args.body as string | undefined)?.trim() ?? "";
      if (!title) {
        throw new UsageError(
          "Issue title is required. Usage: akm submit feedback --title <title> [--body <body>]",
          "MISSING_REQUIRED_ARGUMENT",
          'Pass a title, e.g. --title "Docs typo in setup guide".',
        );
      }
      const { owner, repo } = resolveRepo(args.repo as string | undefined);
      const dryRun = getHyphenatedBoolean(args, "dry-run");
      const labels = [FEEDBACK_LABEL];

      if (dryRun) {
        output("submit-feedback", {
          ok: true,
          dryRun: true,
          title,
          body,
          labels,
          repo: `${owner}/${repo}`,
        });
        return;
      }

      const issue = await createIssue({ owner, repo, title, body, labels });
      output("submit-feedback", {
        ok: true,
        dryRun: false,
        number: issue.number,
        url: issue.url,
        title: issue.title,
        labels,
        repo: `${owner}/${repo}`,
      });
    });
  },
});

// ── submit registry ───────────────────────────────────────────────────────────

const REGISTRY_SOURCES = new Set(["npm", "github", "git", "local"]);

function manualEntriesPath(override: string | undefined): string {
  if (override?.trim()) return path.resolve(override.trim());
  return path.join(getCacheDir(), "registry-build", "manual-entries.json");
}

function loadExistingEntries(file: string): RegistryStashEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const candidate = Array.isArray(raw) ? raw : (raw as { stashes?: unknown }).stashes;
    const parsed = parseRegistryIndex({ version: 3, updatedAt: new Date().toISOString(), stashes: candidate });
    return parsed?.stashes ?? [];
  } catch {
    return [];
  }
}

const registrySubCommand = defineCommand({
  meta: {
    name: "registry",
    description:
      "Append a structured entry to the local registry manual-entries file (consumed by `registry build-index`).",
  },
  args: {
    ref: {
      type: "positional",
      description: "Install ref for the stash (e.g. npm:@scope/pkg, github:owner/repo)",
      required: true,
    },
    id: { type: "string", description: "Stable entry id (defaults to the ref)" },
    name: { type: "string", description: "Human-friendly stash name" },
    description: { type: "string", description: "Short description" },
    source: { type: "string", description: "Source kind: npm | github | git | local" },
    homepage: { type: "string", description: "Homepage URL" },
    out: { type: "string", description: "Override the manual-entries.json path" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const ref = (args.ref as string).trim();
      if (!ref) {
        throw new UsageError("A stash ref is required.", "MISSING_REQUIRED_ARGUMENT");
      }
      const name = (args.name as string | undefined)?.trim() || ref;
      // Derive source from the ref prefix when not explicitly provided.
      const derivedSource = ref.includes(":") ? ref.slice(0, ref.indexOf(":")) : undefined;
      const source = ((args.source as string | undefined)?.trim() || derivedSource) ?? "";
      if (!REGISTRY_SOURCES.has(source)) {
        throw new UsageError(
          `Missing or invalid --source. Provide one of: npm, github, git, local ` +
            `(or use a ref prefixed with the source, e.g. "npm:pkg").`,
          "INVALID_FLAG_VALUE",
        );
      }

      const entry: RegistryStashEntry = {
        id: (args.id as string | undefined)?.trim() || ref,
        name,
        ref,
        source: source as RegistryStashEntry["source"],
      };
      const description = (args.description as string | undefined)?.trim();
      if (description) entry.description = description;
      const homepage = (args.homepage as string | undefined)?.trim();
      if (homepage) entry.homepage = homepage;

      const file = manualEntriesPath(args.out as string | undefined);
      const existing = loadExistingEntries(file);
      const replaced = existing.some((e) => e.id === entry.id);
      const next = replaced ? existing.map((e) => (e.id === entry.id ? entry : e)) : [...existing, entry];

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ stashes: next }, null, 2)}\n`, { mode: 0o600 });

      output("submit-registry", {
        ok: true,
        path: file,
        added: !replaced,
        replaced,
        entry,
        total: next.length,
      });
    });
  },
});

// ── submit metrics ────────────────────────────────────────────────────────────

const metricsSubCommand = defineCommand({
  meta: {
    name: "metrics",
    description:
      "Submit process/tool-usage metrics to an analytics endpoint. " +
      "Feature-gated: requires an explicit --endpoint AND --opt-in. No data is ever sent silently.",
  },
  args: {
    endpoint: { type: "string", description: "Analytics API endpoint URL (no default — must be explicit)" },
    "opt-in": {
      type: "boolean",
      description: "Explicit acknowledgement that metrics may be transmitted to --endpoint",
      default: false,
    },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const endpoint = (args.endpoint as string | undefined)?.trim();
      const optIn = getHyphenatedBoolean(args, "opt-in");
      // No backend contract exists in-repo (endpoint/schema/auth/opt-in policy
      // are unspecified — issue #505). Fail loudly rather than transmit data.
      if (!endpoint || !optIn) {
        throw new UsageError(
          "`akm submit metrics` is not available yet: there is no defined analytics backend " +
            "(endpoint, schema, auth, and opt-in policy are unspecified). " +
            "To avoid silently transmitting data, this command is feature-gated and requires both " +
            "--endpoint <url> and --opt-in once a contract is finalized.",
          "INVALID_FLAG_VALUE",
          "Track issue #505 for the metrics-to-API contract before enabling this path.",
        );
      }
      // Even when both flags are set, the wire schema is not finalized; surface
      // a clear non-zero error instead of POSTing an unversioned payload.
      throw new UsageError(
        "Metrics submission is feature-gated pending a finalized payload schema and auth model. " +
          "Endpoint and opt-in were provided, but the analytics contract is not yet defined.",
        "INVALID_FLAG_VALUE",
      );
    });
  },
});

// ── Top-level command ─────────────────────────────────────────────────────────

export const submitCommand = defineCommand({
  meta: {
    name: "submit",
    description:
      "Submit metrics, registry entries, or feedback to external destinations.\n\n" +
      "Note: `submit feedback` opens a GitHub issue (project feedback); it is distinct from " +
      "`akm feedback`, which records local asset-ranking feedback.",
  },
  subCommands: {
    metrics: metricsSubCommand,
    registry: registrySubCommand,
    feedback: feedbackSubCommand,
  },
});

// Internal exports for tests.
export const __test = { resolveRepo, FEEDBACK_LABEL, DEFAULT_REPO };

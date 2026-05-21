/**
 * Filesystem fallback for the proposal queue.
 *
 * When `state.db` is missing (fresh stash, sandboxed eval, isolation
 * environment), proposals can still be read from
 * `<stash>/.akm/proposals/<UUID>/proposal.json` and
 * `<stash>/.akm/proposals/archive/<UUID>/proposal.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProposalRow } from "./state-db";

interface ProposalJson {
  id: string;
  ref: string;
  status: ProposalRow["status"];
  source: string;
  sourceRun?: string;
  createdAt: string;
  updatedAt: string;
  payload?: { content?: string; frontmatter?: Record<string, unknown> };
}

function safeRead(file: string): ProposalJson | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as ProposalJson;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.id || !parsed.ref || !parsed.status || !parsed.source) return null;
    return parsed;
  } catch {
    return null;
  }
}

function scanDir(dir: string, stashRoot: string): ProposalRow[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const rows: ProposalRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "archive") continue;
    const file = path.join(dir, entry.name, "proposal.json");
    const parsed = safeRead(file);
    if (!parsed) continue;
    rows.push({
      id: parsed.id,
      stashDir: stashRoot,
      ref: parsed.ref,
      status: parsed.status,
      source: parsed.source,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      metadata: parsed.sourceRun ? { sourceRun: parsed.sourceRun } : {},
    });
  }
  return rows;
}

export class StashFsSources {
  constructor(private readonly stashRoot: string) {}

  available(): boolean {
    return fs.existsSync(path.join(this.stashRoot, ".akm", "proposals"));
  }

  readProposals(opts: { status?: ProposalRow["status"]; ref?: string; source?: string } = {}): ProposalRow[] {
    const root = path.join(this.stashRoot, ".akm", "proposals");
    const live = scanDir(root, this.stashRoot);
    const archive = scanDir(path.join(root, "archive"), this.stashRoot);
    let rows = [...live, ...archive];
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);
    if (opts.ref) rows = rows.filter((r) => r.ref === opts.ref);
    if (opts.source) rows = rows.filter((r) => r.source === opts.source);
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return rows;
  }
}

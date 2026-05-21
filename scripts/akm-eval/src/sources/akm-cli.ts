/**
 * Shell wrapper for the `akm` CLI.
 *
 * The toolkit never imports akm internals; instead it shells out to the
 * documented CLI surface. Contracts depended on:
 *
 *   - `akm search <query> --format jsonl --limit N --detail agent`
 *     → one JSON hit per line; each hit has `name`, `ref`, `type`,
 *       `description`, `action`, `score`, `estimatedTokens`.
 *   - `akm proposals --format json` → list envelope with `proposals[]`.
 *   - `akm events list --format jsonl --type T --since S`
 *     → one event per line.
 *   - `akm --version` → version string on stdout.
 *   - `akm improve ...` → mutates the stash; run-id mints under
 *     `<stash>/.akm/runs/<run-id>/improve-result.json` (Phase 2 paired
 *     mode invokes this against a sandboxed stash copy by default).
 */

import { spawnSync } from "node:child_process";

export interface SearchHit {
  ref: string;
  name?: string;
  type?: string;
  description?: string;
  action?: string;
  score?: number;
  estimatedTokens?: number;
  snippet?: string;
}

export class AkmCli {
  constructor(
    private readonly bin: string,
    private readonly env: Record<string, string>,
  ) {}

  private run(args: string[]): { stdout: string; stderr: string; status: number | null } {
    const res = spawnSync(this.bin, args, { encoding: "utf8", env: this.env });
    if (res.error) {
      throw new Error(`failed to spawn ${this.bin}: ${res.error.message}`);
    }
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      status: res.status,
    };
  }

  version(): string | undefined {
    try {
      const res = this.run(["--version"]);
      if (res.status !== 0) return undefined;
      return res.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Invoke `akm improve`, forwarding raw arguments. Inherits the stash/data
   * dir from the AkmCli's env. Returns stdout/stderr/status; caller decides
   * how to surface errors so paired mode can still write a partial envelope
   * when `akm improve` exits non-zero mid-run.
   */
  improve(extraArgs: string[]): { stdout: string; stderr: string; status: number | null } {
    return this.run(["improve", ...extraArgs]);
  }

  /** Run `akm index` against the wrapper's env; used to seed sandbox stashes. */
  index(extraArgs: string[] = []): { stdout: string; stderr: string; status: number | null } {
    return this.run(["index", ...extraArgs]);
  }

  search(query: string, opts: { limit?: number; type?: string } = {}): SearchHit[] {
    const args = ["search", query, "--format", "jsonl", "--detail", "agent"];
    if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
    if (opts.type) args.push("--type", opts.type);
    const res = this.run(args);
    if (res.status !== 0) {
      throw new Error(`akm search failed (exit ${res.status}): ${res.stderr.trim()}`);
    }
    const hits: SearchHit[] = [];
    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object" && typeof obj.ref === "string") {
          hits.push(obj as SearchHit);
        }
      } catch {
        // Tolerate non-JSON lines (e.g. progress warnings on stdout).
      }
    }
    return hits;
  }
}

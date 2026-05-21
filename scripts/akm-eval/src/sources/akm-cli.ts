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
 *
 * Phase 6: every `run([args])` may be recorded (`RecordingAkmCli`) or
 * replayed (`PlaybackAkmCli`). The base `AkmCli` is the live path and stays
 * the default. Use `makeAkmCli()` from the orchestrator so the choice is
 * one-line and runners never have to know which variant they got.
 */

import { spawnSync } from "node:child_process";
import {
  getCurrentPlayer,
  getCurrentRecorder,
  ReplayDivergenceError,
  type ReplayPlayer,
  type ReplayRecorder,
} from "./replay-log";

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

export interface AkmCliRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export class AkmCli {
  constructor(
    protected readonly bin: string,
    protected readonly env: Record<string, string>,
  ) {}

  protected run(args: string[]): AkmCliRunResult {
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
  improve(extraArgs: string[]): AkmCliRunResult {
    return this.run(["improve", ...extraArgs]);
  }

  /** Run `akm index` against the wrapper's env; used to seed sandbox stashes. */
  index(extraArgs: string[] = []): AkmCliRunResult {
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

/**
 * Drop-in subclass that times each live invocation and reports it to a
 * `ReplayRecorder`. Behaviour is otherwise identical to `AkmCli`.
 */
export class RecordingAkmCli extends AkmCli {
  constructor(bin: string, env: Record<string, string>, private readonly recorder: ReplayRecorder) {
    super(bin, env);
  }

  protected override run(args: string[]): AkmCliRunResult {
    const start = Date.now();
    const res = super.run(args);
    this.recorder.recordAkm(args, res.stdout, res.stderr, res.status, Date.now() - start);
    return res;
  }
}

/**
 * Drop-in subclass that never spawns; every `run([args])` dequeues the next
 * recorded invocation from a `ReplayPlayer`. Args-mismatch triggers a
 * `ReplayDivergenceError` so the case fails loudly during replay rather
 * than silently re-aligning on a different recorded call.
 */
export class PlaybackAkmCli extends AkmCli {
  constructor(bin: string, env: Record<string, string>, private readonly player: ReplayPlayer) {
    super(bin, env);
  }

  protected override run(args: string[]): AkmCliRunResult {
    const rec = this.player.nextAkm(args);
    return { stdout: rec.stdout, stderr: rec.stderr, status: rec.status };
  }
}

export interface MakeAkmCliOptions {
  /**
   * Opt into the process-level recording/playback singletons in
   * `replay-log.ts`. When false (default), returns a plain live `AkmCli`.
   * When true:
   *   - if `getCurrentPlayer()` is set, returns a `PlaybackAkmCli`,
   *   - else if `getCurrentRecorder()` is set, returns a `RecordingAkmCli`,
   *   - else returns a plain `AkmCli` (graceful no-op so callers can pass
   *     `record: ctx.recording` without first checking the singleton).
   */
  record?: boolean;
  /** Explicit override; bypasses the process singleton. */
  recorder?: ReplayRecorder;
  /** Explicit override; bypasses the process singleton. */
  player?: ReplayPlayer;
}

/**
 * Single factory used by `src/run.ts` and every runner so the recording /
 * playback choice is one line. When `record` is omitted (and no explicit
 * recorder/player passed), returns the live `AkmCli` — preserving the
 * pre-Phase-6 behaviour.
 */
export function makeAkmCli(
  bin: string,
  env: Record<string, string>,
  opts: MakeAkmCliOptions = {},
): AkmCli {
  const player = opts.player ?? (opts.record ? getCurrentPlayer() : undefined);
  const recorder = opts.recorder ?? (opts.record ? getCurrentRecorder() : undefined);
  if (recorder && player) {
    throw new Error("makeAkmCli: cannot record and play back simultaneously");
  }
  if (player) return new PlaybackAkmCli(bin, env, player);
  if (recorder) return new RecordingAkmCli(bin, env, recorder);
  return new AkmCli(bin, env);
}

// Re-exported so callers don't need a second import to catch divergences.
export { ReplayDivergenceError };

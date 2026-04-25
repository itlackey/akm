/**
 * SourceProvider — minimal v1 interface (spec §2.1).
 *
 * A SourceProvider gets files into a directory. The indexer walks `path()`
 * and reads files from disk. Search and show go through the indexer, not
 * through provider methods.
 *
 * Three required members + one optional:
 *   - name      configured source name
 *   - kind      "filesystem" | "git" | "website" | "npm"
 *   - init(ctx) called once after construction
 *   - path()    the directory the indexer walks (stable for instance lifetime)
 *   - sync?()   refresh the directory from upstream (no-op for filesystem)
 *
 * All other writing/reading concerns live outside this interface:
 *   - Writes:    src/core/write-source.ts (Phase 5)
 *   - Reads:     src/indexer.ts (Phase 4)
 *   - Install:   src/source-providers/sync-from-ref.ts (install-time helpers,
 *                separate from configured-source plumbing)
 */

import type { SourceConfigEntry } from "../core/config";

// ── ProviderContext ──────────────────────────────────────────────────────────

/**
 * Context passed to {@link SourceProvider.init}. Owned and constructed by the
 * provider registry; providers must not mutate it.
 */
export interface ProviderContext {
  readonly name: string;
  readonly options: Record<string, unknown>;
  /** akm-managed cache root for this source. */
  readonly cacheDir: string;
  /** Resolves an option value that may be a literal or `{ env: "NAME" }`. */
  readonly resolveOption: (value: unknown) => string | undefined;
}

// ── SourceProvider interface ─────────────────────────────────────────────────

export interface SourceProvider {
  readonly name: string;
  /** Discriminator string. v1 supports "filesystem" | "git" | "website" | "npm". */
  readonly kind: string;

  /** Called once at load. */
  init(ctx: ProviderContext): Promise<void>;

  /**
   * The directory the indexer walks. Must return the same path for the
   * lifetime of the provider instance.
   */
  path(): string;

  /** Refresh the directory from upstream. No-op for filesystem. */
  sync?(): Promise<void>;
}

// ── Factory shape ────────────────────────────────────────────────────────────

/**
 * Factory that builds a provider for a configured source. The legacy 0.6.0
 * factory takes the entire {@link SourceConfigEntry}; the v1 spec narrows this
 * to `(name) => Provider`. We keep accepting a `SourceConfigEntry` here so the
 * registry can populate {@link ProviderContext} from the entry's options
 * inside `init()` without forcing every call site to construct a context up
 * front.
 */
export type SourceProviderFactory = (config: SourceConfigEntry) => SourceProvider;

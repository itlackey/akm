/**
 * Registry provider interface (v1 architecture spec §3.1).
 *
 * A `RegistryProvider` is a read-only catalog that lists installable kits and
 * (optionally) previews assets within them. It is *not* a `SourceProvider`:
 * registry providers do not materialise files to disk — they only answer
 * discovery queries.
 *
 * The two built-in registry providers at v1 are:
 *
 * - `static-index` — reads the v2 JSON index schema (the official akm registry
 *   and any static-hosted team registry). The v2 schema is owned by this
 *   provider, not by core akm.
 * - `skills-sh` — wraps the skills.sh REST API.
 *
 * Context Hub is **not** a registry provider — it is an ordinary git repository
 * recommended via the official static-index registry (see CLAUDE.md).
 *
 * Note: the simple `search()` method is the v0.6 surface and remains the
 * primary entry point used by the orchestrator. The `searchKits` /
 * `searchAssets` / `getKit` / `canHandle` methods are the v1-spec contract
 * (§3.1) which built-in providers also implement so the orchestrator can be
 * iterated cleanly post-Phase 6 without reaching into provider-specific shapes.
 */

import type { RegistryConfigEntry } from "../../core/config";
import type { ParsedRegistryRef, RegistryAssetSearchHit, RegistrySearchHit } from "../registry-types";

// ── Search call shape (v0.6 surface, kept for the orchestrator) ─────────────

export interface RegistryProviderSearchOptions {
  query: string;
  /** Maximum number of results to return. Always in range [1, 100]. */
  limit: number;
  includeAssets?: boolean;
}

export interface RegistryProviderResult {
  hits: RegistrySearchHit[];
  assetHits?: RegistryAssetSearchHit[];
  warnings?: string[];
}

// ── v1-spec types ───────────────────────────────────────────────────────────

export type KitId = string;

export interface RegistryQuery {
  readonly text: string;
  readonly limit?: number;
}

export interface KitResult {
  readonly id: KitId;
  readonly title: string;
  readonly summary?: string;
  readonly installRef: string;
  readonly score?: number;
  readonly assetPreview?: readonly AssetPreview[];
}

export interface AssetPreview {
  readonly kitId: KitId;
  readonly type: string;
  readonly name: string;
  readonly summary?: string;
  readonly cloneRef: string;
}

export interface KitManifest {
  readonly id: KitId;
  readonly installRef: string;
  readonly assets?: readonly AssetPreview[];
}

// ── Interface ───────────────────────────────────────────────────────────────

/**
 * The v1 RegistryProvider contract. Built-in providers implement every method
 * (`canHandle` is mandatory at the type level even though plan §9 item 2 flags
 * it as a forward-compatible decision — making it required at v1 means
 * `commands/add.ts` does not have to switch on `kind`).
 */
export interface RegistryProvider {
  /** Discriminator — e.g. "static-index", "skills-sh". */
  readonly type: string;

  /**
   * v0.6 search entry point used by the orchestrator. Implementations must
   * never throw — errors are returned as `warnings[]`.
   */
  search(options: RegistryProviderSearchOptions): Promise<RegistryProviderResult>;

  /** v1-spec §3.1: find installable kits. */
  searchKits(q: RegistryQuery): Promise<KitResult[]>;

  /** v1-spec §3.1: optional asset preview. */
  searchAssets?(q: RegistryQuery): Promise<AssetPreview[]>;

  /** v1-spec §3.1: fetch the manifest needed to install a kit. */
  getKit(id: KitId): Promise<KitManifest | null>;

  /**
   * Return true if this provider claims ownership of the given install ref.
   *
   * Plan §9 item 2: making this part of the interface (rather than a switch
   * inside `commands/add.ts`) removes the last `kind`-branching dispatch on
   * the registry side. The orchestrator picks the first registry whose
   * `canHandle` returns true (spec §6.3).
   */
  canHandle(ref: ParsedRegistryRef): boolean;
}

export type RegistryProviderFactory = (config: RegistryConfigEntry) => RegistryProvider;

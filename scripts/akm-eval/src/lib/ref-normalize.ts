/**
 * Ref normalisation shared by the real-query suite generator and the
 * proactive-verdict runner.
 *
 * AKM asset refs appear in three forms across the data surfaces:
 *
 *   - bare:            `knowledge:openpalm-deploy-spine`
 *   - origin-prefixed: `github:hieutrtr/ai1-skills//script:skills/.../deploy.sh`
 *   - stash-prefixed:  `itlackey/akm-stash//skill:akm-dream`
 *
 * `usage_events.entry_ref` and `curate` metadata `itemRefs` mix all three;
 * `akm search` returns bare for local-stash assets and origin-prefixed for
 * imported ones. To compare them we normalise to the canonical `type:name`
 * tail and, where useful, keep the origin as a separate field.
 */

export interface ParsedRef {
  /** Origin segment before `//`, or undefined for bare refs. */
  origin?: string;
  /** Asset type (knowledge, skill, command, agent, memory, ...). */
  type: string;
  /** Name/path tail after `type:`. */
  name: string;
  /** Canonical `type:name` (origin stripped). */
  canonical: string;
}

/**
 * Parse a raw ref into its parts. Returns undefined for strings that don't
 * look like an asset ref at all (no `type:` segment).
 */
export function parseRef(raw: string): ParsedRef | undefined {
  if (!raw) return undefined;
  let rest = raw.trim();
  let origin: string | undefined;
  const splitIdx = rest.indexOf("//");
  if (splitIdx >= 0) {
    origin = rest.slice(0, splitIdx);
    rest = rest.slice(splitIdx + 2);
  }
  const colon = rest.indexOf(":");
  if (colon <= 0) return undefined;
  const type = rest.slice(0, colon);
  const name = rest.slice(colon + 1);
  if (!type || !name) return undefined;
  // Drop a trailing `.derived` marker and `.md` suffix so the same asset
  // recorded in different surfaces collapses to one canonical key.
  const cleanName = name.replace(/\.derived$/, "").replace(/\.md$/, "");
  return { origin, type, name: cleanName, canonical: `${type}:${cleanName}` };
}

/** Canonical `type:name` for a raw ref, or "" if unparseable. */
export function normalizeRef(raw: string): string {
  return parseRef(raw)?.canonical ?? "";
}

/**
 * All plausible string forms of a canonical ref that `akm search` might
 * return, so an exact-match retrieval check can hit whichever one shows up.
 * Always includes the bare canonical form. The generator emits these so a
 * single engaged asset is matched regardless of origin prefixing.
 */
export function refVariants(canonical: string): string[] {
  const parsed = parseRef(canonical);
  if (!parsed) return [canonical];
  const out = new Set<string>([parsed.canonical]);
  // Also include a `.md`-suffixed name variant — some surfaces keep it.
  out.add(`${parsed.type}:${parsed.name}.md`);
  return [...out];
}

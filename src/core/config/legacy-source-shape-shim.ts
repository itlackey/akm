import path from "node:path";
import { isBundleSlug } from "../asset/asset-ref";
import { warnOnce } from "../warn";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DEFAULT_WRITABLE_BY_TYPE: Record<string, boolean | undefined> = {
  filesystem: true,
  git: false,
  website: false,
  npm: false,
};

function bundleFromLegacySource(entry: unknown, index: number): [string, Record<string, unknown>] | undefined {
  if (!isPlainRecord(entry)) return undefined;
  const type = typeof entry.type === "string" ? entry.type : undefined;
  const bundle: Record<string, unknown> = {};
  switch (type) {
    case "filesystem":
      if (typeof entry.path !== "string" || !entry.path) return undefined;
      bundle.path = entry.path;
      break;
    case "git":
      if (typeof entry.url !== "string" || !entry.url) return undefined;
      bundle.git = entry.url;
      break;
    case "website":
      if (typeof entry.url !== "string" || !entry.url) return undefined;
      bundle.website = { url: entry.url };
      break;
    case "npm": {
      const spec = typeof entry.url === "string" && entry.url ? entry.url : entry.path;
      if (typeof spec !== "string" || !spec) return undefined;
      bundle.npm = spec;
      break;
    }
    default:
      return undefined;
  }
  const writable = typeof entry.writable === "boolean" ? entry.writable : DEFAULT_WRITABLE_BY_TYPE[type ?? ""];
  if (writable !== undefined) bundle.writable = writable;
  if (typeof entry.enabled === "boolean") bundle.enabled = entry.enabled;
  const name = typeof entry.name === "string" ? entry.name : undefined;
  const key = name && isBundleSlug(name) ? name : `source-${index + 1}`;
  return [key, bundle];
}

function filesystemLocator(bundle: unknown): string | undefined {
  if (!isPlainRecord(bundle) || typeof bundle.path !== "string" || bundle.path.length === 0) return undefined;
  return path.resolve(bundle.path);
}

export function migrateLegacySourceShape(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const hasStashDir = typeof raw.stashDir === "string" && raw.stashDir.trim().length > 0;
  const hasSources = Array.isArray(raw.sources) && raw.sources.length > 0;
  const hasInstalled = "installed" in raw && raw.installed !== undefined;
  if (!hasStashDir && !hasSources && !hasInstalled) return raw;

  const { stashDir: _stashDir, sources: _sources, installed: _installed, ...rest } = raw;
  const bundles: Record<string, unknown> = isPlainRecord(rest.bundles) ? { ...rest.bundles } : {};
  let defaultBundle = typeof rest.defaultBundle === "string" ? rest.defaultBundle : undefined;

  if (hasStashDir) {
    bundles.stash = { path: raw.stashDir, writable: true };
    defaultBundle ??= "stash";
  }
  if (hasSources) {
    (raw.sources as unknown[]).forEach((entry, index) => {
      const converted = bundleFromLegacySource(entry, index);
      if (!converted) return;
      const [key, bundle] = converted;
      const locator = filesystemLocator(bundle);
      if (locator && Object.values(bundles).some((candidate) => filesystemLocator(candidate) === locator)) return;
      bundles[key] = bundle;
      defaultBundle ??= key;
    });
  }

  const droppedKeys = [hasStashDir && "stashDir", hasSources && "sources", hasInstalled && "installed"].filter(Boolean);
  const where = sourcePath ? ` at ${sourcePath}` : "";
  warnOnce(
    `legacy-source-shape${sourcePath ? `:${sourcePath}` : ""}`,
    `Config${where} uses the retired ${droppedKeys.join("/")} shape — auto-migrated in memory to \`bundles\`/\`defaultBundle\`. Run \`akm migrate apply\` to rewrite the config file and silence this warning.`,
  );

  return { ...rest, bundles, ...(defaultBundle !== undefined ? { defaultBundle } : {}) };
}

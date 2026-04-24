import fs from "node:fs";
import path from "node:path";

const CHANGELOG_URL = "https://github.com/itlackey/akm/blob/main/CHANGELOG.md";
const MIGRATION_DOC_URL = "https://github.com/itlackey/akm/blob/main/docs/migration/v0.5-to-v0.6.md";

/**
 * Directory containing per-version release notes. Resolved relative to
 * `import.meta.dir` so the lookup works whether this module is running
 * from source (`<repo>/src`) or from the published build (`<pkg>/dist`).
 * The `docs/migration/release-notes/` directory is shipped via the
 * `files[]` array in `package.json`.
 */
function releaseNotesDir(): string {
  return path.resolve(import.meta.dir, "../docs/migration/release-notes");
}

function loadChangelog(): string | undefined {
  try {
    const changelogPath = path.resolve(import.meta.dir, "../CHANGELOG.md");
    if (fs.existsSync(changelogPath)) {
      return fs.readFileSync(changelogPath, "utf8");
    }
  } catch {
    // fall through to bundled notes
  }
  return undefined;
}

/**
 * Load the bundled migration note for a specific version, if one exists.
 * Returns the file body verbatim (no transformations). Missing files,
 * permission errors, and non-file entries all return `undefined` —
 * callers are responsible for the fallback message.
 */
function loadReleaseNote(version: string): string | undefined {
  if (!isSafeVersionComponent(version)) return undefined;
  const notePath = path.join(releaseNotesDir(), `${version}.md`);
  try {
    if (!fs.existsSync(notePath)) return undefined;
    const stat = fs.statSync(notePath);
    if (!stat.isFile()) return undefined;
    return fs.readFileSync(notePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Restrict version lookups to strings that are safe as a single path
 * segment. Accepts typical semver forms (`0.6.0`, `0.6.0-rc1`,
 * `0.6.0+build.5`) and rejects anything with slashes, `..`, or control
 * characters that would let a crafted input escape the release-notes
 * directory.
 */
function isSafeVersionComponent(version: string): boolean {
  if (!version || version.length > 64) return false;
  return /^[A-Za-z0-9._+-]+$/.test(version) && !version.includes("..");
}

function normalizeRequestedVersion(input: string): string {
  const value = input.trim();
  if (!value) return value;
  if (value.toLowerCase() === "latest") return "latest";
  const withoutV = value.replace(/^v/i, "");
  return withoutV;
}

function versionCandidates(requested: string): string[] {
  if (requested === "latest") return ["latest"];
  const exact = requested;
  const stable = requested.replace(/[-+].*$/, "");
  return stable === exact ? [exact] : [exact, stable];
}

function resolveLatestVersion(changelog: string): string | undefined {
  for (const match of changelog.matchAll(/^## \[([^\]]+)\]/gm)) {
    const version = match[1];
    if (version !== "Unreleased") return version;
  }
  return undefined;
}

function extractChangelogSection(changelog: string, version: string): string | undefined {
  const pattern = new RegExp(`^## \\[${escapeRegexString(version)}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|\\Z)`, "m");
  const match = changelog.match(pattern);
  if (!match) return undefined;
  return `## [${version}]\n${match[1].trim()}\n`;
}

function escapeRegexString(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fallbackGuide(version: string): string {
  const bundled = loadReleaseNote(version);
  if (bundled) return `${bundled.trim()}\n\nFull changelog: ${CHANGELOG_URL}\n`;
  return (
    `No dedicated migration note is bundled for akm v${version}.\n\n` +
    `See the full changelog: ${CHANGELOG_URL}\n` +
    `Longform migration guide: ${MIGRATION_DOC_URL}\n`
  );
}

export function renderMigrationHelp(versionInput: string, changelogText = loadChangelog()): string {
  const requested = normalizeRequestedVersion(versionInput);
  if (!requested) {
    return `Version is required.\n\nUsage: akm help migrate <version>\n`;
  }

  const resolvedLatest = changelogText ? resolveLatestVersion(changelogText) : undefined;
  const candidates = requested === "latest" && resolvedLatest ? [resolvedLatest] : versionCandidates(requested);

  if (changelogText) {
    for (const candidate of candidates) {
      const section = extractChangelogSection(changelogText, candidate);
      if (section) {
        const bundled = loadReleaseNote(candidate);
        if (!bundled) return `${section.trim()}\n\nFull changelog: ${CHANGELOG_URL}\n`;
        return `${bundled.trim()}\n\nRelease notes\n-------------\n${section.trim()}\n\nFull changelog: ${CHANGELOG_URL}\n`;
      }
    }
  }

  const fallbackVersion = candidates.find((candidate) => candidate !== "latest") ?? requested;
  return fallbackGuide(fallbackVersion);
}

/** Test-only helper — list every version with a bundled release note. */
export function listBundledReleaseVersions(): string[] {
  try {
    const dir = releaseNotesDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => name.slice(0, -".md".length))
      .sort();
  } catch {
    return [];
  }
}

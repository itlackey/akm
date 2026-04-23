import fs from "node:fs";
import path from "node:path";

const CHANGELOG_URL = "https://github.com/itlackey/akm/blob/main/CHANGELOG.md";

const EMBEDDED_MIGRATION_GUIDES: Record<string, string> = {
  "0.5.0": `Migration notes for akm v0.5.0

- New top-level surfaces: \`akm wiki …\`, \`akm workflow …\`, \`akm vault …\`, and \`akm save\`.
- If you tried the unreleased single-wiki LLM prototype, move to the new \`akm wiki …\` workflow.
- Removed from the prototype surface: \`akm lint\`, \`akm import --llm\`, \`akm import --dry-run\`, \`knowledge.pageKinds\`, and the old ingest/lint LLM prompts.
- Existing raw wiki-like content should be moved into \`wikis/<name>/raw/\` and then managed with the new wiki commands.
`,
  "0.3.0": `Migration notes for akm v0.3.0

- The old \`stash\` and \`kit\` command groups were folded into the top-level CLI.
- Use \`akm add\`, \`akm list\`, and \`akm remove\` instead of the older split command surfaces.
- Documentation and examples from older releases should be updated to the unified source model.
`,
  "0.2.0": `Migration notes for akm v0.2.0

- Asset refs are user-facing \`type:name\` values; do not rely on URI-style refs.
- The old fixed asset-type union was replaced by an extensible asset type system.
- \`tool\` assets were removed; use \`script\` assets instead.
- Config and docs should treat remote provider scores and local scores as part of one shared search pipeline.
`,
  "0.1.0": `Migration notes for akm v0.1.0

- The package and project were rebranded from Agent-i-Kit to akm.
- Update package references from \`agent-i-kit\` to \`akm-cli\`.
- Update config, registry, plugin, path, and environment-variable references from \`agent-i-kit\` / \`AGENT_I_KIT_*\` to \`akm\` / \`AKM_*\`.
- The \`tool\` asset type and \`submit\` command were removed.
`,
  "0.0.13": `Migration notes for akm v0.0.13

- Initial public release.
- No migration steps are required for earlier akm versions.
`,
};

function loadChangelog(): string | undefined {
  try {
    const changelogPath = path.resolve(import.meta.dir ?? __dirname, "../CHANGELOG.md");
    if (fs.existsSync(changelogPath)) {
      return fs.readFileSync(changelogPath, "utf8");
    }
  } catch {
    // fall through to embedded notes
  }
  return undefined;
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
  const pattern = new RegExp(
    `^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|\\Z)`,
    "m",
  );
  const match = changelog.match(pattern);
  if (!match) return undefined;
  return `## [${version}]\n${match[1].trim()}\n`;
}

function fallbackGuide(version: string): string {
  const embedded = EMBEDDED_MIGRATION_GUIDES[version];
  if (embedded) return `${embedded.trim()}\n\nFull changelog: ${CHANGELOG_URL}\n`;
  return `No dedicated migration note is bundled for akm v${version}.\n\nSee the full changelog: ${CHANGELOG_URL}\n`;
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
        const embedded = EMBEDDED_MIGRATION_GUIDES[candidate];
        if (!embedded) return `${section.trim()}\n\nFull changelog: ${CHANGELOG_URL}\n`;
        return `${embedded.trim()}\n\nRelease notes\n-------------\n${section.trim()}\n\nFull changelog: ${CHANGELOG_URL}\n`;
      }
    }
  }

  const fallbackVersion = candidates.find((candidate) => candidate !== "latest") ?? requested;
  return fallbackGuide(fallbackVersion);
}

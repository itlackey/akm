// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm rules`: the rules that apply here, in full. Read from the files of the
 * bundles the selection names (never the index), recognized by the same adapter
 * and filtered by the same project and scope functions search uses, so it works
 * with no index and a new rule applies at once. A project that lists its `rules` gets exactly those, in order,
 * from any enabled bundle. Records one `rules` usage event.
 */

import path from "node:path";
import { getStringArg, PROJECT_ARG } from "../../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues } from "../../cli/shared";
import type { IndexDocument } from "../../core/adapter/types";
import { stashDirFor } from "../../core/asset/asset-placement";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { displayRefForConceptId } from "../../core/asset/resolve-ref";
import { adapterWrites } from "../../core/assets/gate";
import { type Asset, listAssets, lookupAsset } from "../../core/assets/read";
import { indexAsset } from "../../core/assets/type";
import { compareCodePoints } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { NotFoundError } from "../../core/errors";
import { type ProjectView, type ResolvedProject, resolveProject } from "../../core/projects";
import { withStateDbTelemetry } from "../../core/state-db";
import { warnOnce } from "../../core/warn";
import { isProposedQuality } from "../../indexer/passes/entry-normalize";
import { scopeMatchesFilters } from "../../indexer/passes/metadata";
import { resolveReadSources } from "../../indexer/read-preflight";
import { indexRowEntry } from "../../indexer/scan/drain-dir";
import { appliesUnder } from "../../indexer/search/db-search";
import { insertUsageEvent, resolveUsageEventSource, type UsageEventSource } from "../../indexer/usage/usage-events";
import { registerMdRenderer } from "../../output/render-registry";
import { formatRulesText } from "../../output/text/rules";
import { TELEMETRY_BUSY_TIMEOUT_MS } from "../../storage/repositories/index-db";
import {
  assertNamedSourceExists,
  narrowSourcesToName,
  normalizeScopeFilters,
  parseScopeFilterFlags,
  parseSearchSource,
} from "./search";
import { fromValues, projectContext, scopeFilterArg, stampedProject, withProjectDefaults } from "./search-cli";

export interface RuleItem {
  ref: string;
  description?: string;
  /** The project(s) the rule names; absent on a shared rule. */
  project?: string | string[];
  /** The rule's body, without frontmatter. */
  content: string;
}

export interface RulesResult {
  schemaVersion: 1;
  project?: ProjectView;
  /** The bundles read, in order. */
  bundles: string[];
  rules: RuleItem[];
}

/** `--from` values that select a search scope, not a bundle: they do not apply to rules. */
const SCOPE_KEYWORDS: readonly string[] = ["local", "registry", "all"];

/** The bundle names in a `--from` value; scope keywords are ignored with one warning. `undefined`: none left. */
function bundleNames(from: string | string[] | undefined): string[] | undefined {
  if (from === undefined) return undefined;
  const parsed = parseSearchSource(from);
  const given = Array.isArray(parsed) ? parsed : [parsed];
  const names = given.filter((name) => !SCOPE_KEYWORDS.includes(name));
  if (names.length < given.length) {
    warnOnce("rules:from-keyword", "`akm rules` reads named bundles: --from local, registry and all are ignored.");
  }
  return names.length > 0 ? names : undefined;
}

const RULES_PREFIX = `${stashDirFor("rule")}/`;

/** What the asset's adapter says about it now, with nothing recorded; undefined when the adapter abstains on it. */
function describeNow(asset: Asset): IndexDocument | undefined {
  try {
    return indexAsset(asset, { persist: false });
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

type FoundRule = RuleItem & { shared: boolean; durableRef: string };

/** The adapter's description of a rule asset now; undefined when the asset is not a rule. */
function ruleEntry(asset: Asset): IndexDocument | undefined {
  // Read as the adapter describes it now, so a rule edited since the last index applies as written.
  const document = describeNow(asset);
  if (document?.type !== "rule") return undefined;
  return indexRowEntry(document, path.basename(asset.conceptId));
}

function foundRule(asset: Asset, entry: IndexDocument, defaultBundle: string | undefined): FoundRule {
  const named = entry.frontmatter?.project;
  return {
    ref: displayRefForConceptId(asset.conceptId, asset.bundle, defaultBundle),
    durableRef: `${asset.bundle}//${asset.conceptId}`,
    ...(entry.description ? { description: entry.description } : {}),
    ...(named?.length ? { project: named.length === 1 ? named[0] : named } : {}),
    content: parseFrontmatter(asset.entry.content()).content.trim(),
    shared: !named?.length,
  };
}

/** The project's listed rules, in list order, each ref resolved as `akm show` resolves it; one naming no loadable rule warns and is skipped. */
function listedRules(project: ResolvedProject & { rules: string[] }, defaultBundle: string | undefined): FoundRule[] {
  const found = new Map<string, FoundRule>();
  for (const ref of project.rules) {
    const asset = lookupAsset(ref);
    const entry = asset?.conceptId.startsWith(RULES_PREFIX) ? ruleEntry(asset) : undefined;
    const why = !asset
      ? "no enabled bundle holds it"
      : !entry
        ? "it is not a rule (a file in a bundle's top-level rules/ folder)"
        : isProposedQuality(entry.quality)
          ? "it is proposed; it loads once accepted"
          : undefined;
    if (why || !asset || !entry) {
      warnOnce(
        `rules:listed:${project.name}:${ref}`,
        `Skipping rule "${ref}" listed by project "${project.name}": ${why}.`,
      );
      continue;
    }
    if (!found.has(asset.ref)) found.set(asset.ref, foundRule(asset, entry, defaultBundle));
  }
  return [...found.values()];
}

export function akmRules(input: {
  from?: string | string[];
  filters?: string[];
  /** The project to use (`--project`); absent: the one `cwd` selects. */
  project?: string;
  cwd?: string;
  eventSource?: UsageEventSource;
}): RulesResult {
  const config = loadConfig();
  const project = resolveProject(config, { project: input.project, cwd: input.cwd });
  const { filters, view } = withProjectDefaults(project, {
    source: input.from,
    filters: parseScopeFilterFlags(input.filters ?? [], "--filter"),
  });
  const sources = resolveReadSources(undefined, config).sources;
  const defaultBundle = config.defaultBundle ?? sources.find((s) => s.isDefault)?.bundleId;
  let bundles: string[];
  let found: FoundRule[];
  if (project?.rules && input.from === undefined && !input.filters?.length) {
    found = listedRules({ ...project, rules: project.rules }, defaultBundle);
    bundles = [...new Set(found.map((r) => r.durableRef.split("//")[0] as string))];
  } else {
    const names = bundleNames(input.from) ?? bundleNames(project?.from);
    for (const name of names ?? []) assertNamedSourceExists(config, name);
    const wanted = names
      ? names.flatMap((name) => narrowSourcesToName(sources, [name]))
      : [
          ...sources.filter((source) => source.isDefault),
          ...(project?.write.bundle ? narrowSourcesToName(sources, [project.write.bundle]) : []),
        ];
    const scope = normalizeScopeFilters(filters);
    const context = projectContext(project, filters);

    bundles = [];
    found = [];
    for (const source of new Set(wanted)) {
      const bundleId = source.bundleId;
      if (source.unresolved || !adapterWrites(bundleId, "rule")) continue;
      bundles.push(bundleId);
      // Only the rules folder decides a rule (as the walk always read it), so only its assets are described.
      for (const asset of listAssets({ bundle: bundleId }).filter(({ conceptId }) =>
        conceptId.startsWith(RULES_PREFIX),
      )) {
        const entry = ruleEntry(asset);
        if (!entry || isProposedQuality(entry.quality) || !appliesUnder(entry, context)) continue;
        if (scope && !scopeMatchesFilters(entry, scope)) continue;
        found.push(foundRule(asset, entry, defaultBundle));
      }
    }
    found.sort((a, b) => Number(a.shared) - Number(b.shared) || compareCodePoints(a.ref, b.ref));
  }

  const rules = found.map(({ shared: _shared, durableRef: _durableRef, ...rule }) => rule);
  recordRulesUsage({
    project: stampedProject(project),
    bundles,
    refs: found.map((rule) => rule.durableRef),
    chars: found.reduce((sum, rule) => sum + rule.content.length, 0),
    eventSource: input.eventSource ?? resolveUsageEventSource(),
  });
  return { schemaVersion: 1, ...(view ? { project: view } : {}), bundles, rules };
}

/** One `rules` usage event per call: what was loaded, not a search or a show. */
function recordRulesUsage(load: {
  project?: string;
  bundles: string[];
  refs: string[];
  chars: number;
  eventSource: UsageEventSource;
}): void {
  const { eventSource, ...metadata } = load;
  try {
    withStateDbTelemetry((stateDb) => {
      insertUsageEvent(stateDb, { event_type: "rules", metadata: JSON.stringify(metadata), source: eventSource });
    }, TELEMETRY_BUSY_TIMEOUT_MS);
  } catch {
    /* telemetry is fire-and-forget */
  }
}

export const rulesCommand = defineJsonCommand({
  meta: {
    name: "rules",
    description:
      "The rules that apply here, in full: the project's and the shared ones, read from the files of the project's bundles (its `from`, else the default bundle and its write bundle)",
  },
  args: {
    from: {
      type: "string",
      description: "Bundle name (repeatable); default: the project's from, else the default bundle",
    },
    filter: scopeFilterArg,
    ...PROJECT_ARG,
  },
  async run({ args }) {
    output(
      "rules",
      akmRules({
        from: fromValues(args.from),
        filters: parseAllFlagValues("--filter"),
        project: getStringArg(args, "project"),
      }),
    );
  },
});

registerMdRenderer("rules", (result) => formatRulesText(result as RulesResult));

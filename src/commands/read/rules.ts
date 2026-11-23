// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm rules`: the rules that apply here, in full. Read from the files of the
 * bundles the selection names (never the index), recognized by the same adapter
 * and filtered by the same project and scope functions search uses, so it works
 * with no index and a new rule applies at once. Records one `rules` usage event.
 */

import path from "node:path";
import { getStringArg, PROJECT_ARG } from "../../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues } from "../../cli/shared";
import type { IndexDocument } from "../../core/adapter/types";
import { stashDirFor } from "../../core/asset/asset-placement";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { displayRefForConceptId } from "../../core/asset/resolve-ref";
import { adapterWrites } from "../../core/assets/gate";
import { type Asset, listAssets } from "../../core/assets/read";
import { indexAsset } from "../../core/assets/type";
import { compareCodePoints } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { NotFoundError } from "../../core/errors";
import { type ProjectView, resolveProject } from "../../core/projects";
import { withStateDbTelemetry } from "../../core/state-db";
import { warnOnce } from "../../core/warn";
import { deriveInstallations } from "../../indexer/installations";
import { isProposedQuality, scopeMatchesFilters } from "../../indexer/passes/metadata";
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
  const names = bundleNames(input.from) ?? bundleNames(project?.from);
  for (const name of names ?? []) assertNamedSourceExists(config, name);

  const sources = resolveReadSources(undefined, config).sources;
  const wanted = names
    ? names.flatMap((name) => narrowSourcesToName(sources, [name]))
    : [
        ...sources.filter((source) => source.isDefault),
        ...(project?.write.bundle ? narrowSourcesToName(sources, [project.write.bundle]) : []),
      ];
  const installations = deriveInstallations(sources);
  const scope = normalizeScopeFilters(filters);
  const context = projectContext(project, filters);

  const bundles: string[] = [];
  const found: Array<RuleItem & { shared: boolean; durableRef: string }> = [];
  for (const source of new Set(wanted)) {
    const bundle = installations[sources.indexOf(source)];
    if (!bundle || source.unresolved || !adapterWrites(bundle.id, "rule")) continue;
    bundles.push(bundle.id);
    // Only the rules folder decides a rule (as the walk always read it), so only its assets are described.
    for (const asset of listAssets({ bundle: bundle.id }).filter(({ conceptId }) =>
      conceptId.startsWith(RULES_PREFIX),
    )) {
      // Read as the adapter describes it now, so a rule edited since the last index applies as written.
      const document = describeNow(asset);
      if (document?.type !== "rule") continue;
      const entry = indexRowEntry(document, path.basename(asset.conceptId));
      const { conceptId } = asset;
      if (isProposedQuality(entry.quality) || !appliesUnder(entry, context)) continue;
      if (scope && !scopeMatchesFilters(entry, scope)) continue;
      const named = entry.frontmatter?.project;
      found.push({
        ref: displayRefForConceptId(
          conceptId,
          bundle.id,
          config.defaultBundle ?? (source.isDefault ? bundle.id : undefined),
        ),
        durableRef: `${bundle.id}//${conceptId}`,
        ...(entry.description ? { description: entry.description } : {}),
        ...(named?.length ? { project: named.length === 1 ? named[0] : named } : {}),
        content: parseFrontmatter(asset.entry.content()).content.trim(),
        shared: !named?.length,
      });
    }
  }
  found.sort((a, b) => Number(a.shared) - Number(b.shared) || compareCodePoints(a.ref, b.ref));

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

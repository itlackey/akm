// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Curate and the project defaults it shares with `akm search` and `akm show`.
 * Kept out of `search-cli.ts` so the in-process `curate()` of `src/api.ts` does not
 * import a command module.
 */

import { parsePositiveIntFlag } from "../../cli/parse-args";
import type { ScopeFilters } from "../../core/adapter/types";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { projectView, type ResolvedProject, resolveProject } from "../../core/projects";
import type { ProjectContext } from "../../indexer/search/db-search";
import { resolveUsageEventSource, type UsageEventSource } from "../../indexer/usage/usage-events";
import type { OutputMode } from "../../output/context";
import { akmCurate, type CurateResponse } from "./curate";
import { parseBeliefFilterMode, parseScopeFilterFlags, parseSearchSource } from "./search";

/** The value a project's writes carry as `project`: what its rules and usage are matched against. */
export function stampedProject(project: ResolvedProject | undefined): string | undefined {
  const value = project?.write.metadata.project;
  return value === undefined ? undefined : String(value);
}

/** The project a search or curate runs under; a `project` filter in force has already decided eligibility. */
export function projectContext(
  project: ResolvedProject | undefined,
  filters: ScopeFilters | undefined,
): ProjectContext {
  return {
    name: stampedProject(project),
    ...(filters && Object.hasOwn(filters, "project") ? { byFilter: true } : {}),
  };
}

/**
 * The read defaults a call runs with: each kind the caller gave replaces the
 * project's value for that kind, and a kind neither gave stays at today's default.
 * `view` is the project as applied: the same effective values, for the response to report.
 */
export function withProjectDefaults(
  project: ResolvedProject | undefined,
  explicit: { source?: string | string[]; filters?: ScopeFilters; prefer?: ScopeFilters },
) {
  const from = explicit.source ?? project?.from;
  const filters = explicit.filters ?? project?.filters;
  const prefer = explicit.prefer ?? project?.prefer;
  return {
    source: parseSearchSource(from),
    filters,
    prefer,
    view: project && projectView({ ...project, from, filters, prefer: prefer ?? project.prefer }),
  };
}

/**
 * Validate the curate arguments and run the curation. The one path both
 * `akm curate` and the in-process `curate()` of `src/api.ts` go through, so
 * argument errors and ranking cannot drift between them. Takes the output
 * mode explicitly (it only picks the attribution projection) instead of
 * reading the process-level singleton.
 */
export async function runCurate(
  args: {
    query?: string;
    type?: string;
    limit?: string;
    from?: string | string[];
    filters?: string[];
    prefer?: string[];
    belief?: string;
    /** In-process callers (an agent's tool) name the run's source; the CLI reads `AKM_EVENT_SOURCE`. */
    eventSource?: UsageEventSource;
    /** The project to use (`--project`); absent: the one `cwd` selects. */
    project?: string;
    /** The working directory that selects a project; default: the process's. */
    cwd?: string;
  },
  outputMode: Pick<OutputMode, "detail" | "shape">,
): Promise<CurateResponse> {
  if (!args.query || !String(args.query).trim()) {
    throw new UsageError(
      'A curate query is required. Usage: akm curate "<task or prompt>" [--type <type>] [--limit <n>]',
      "MISSING_REQUIRED_ARGUMENT",
      'Describe the task you want assets for, e.g. `akm curate "deploy to prod"`.',
    );
  }
  const limitParsed = parsePositiveIntFlag(args.limit ?? undefined);
  const project = resolveProject(loadConfig(), { project: args.project, cwd: args.cwd });
  const { source, filters, prefer, view } = withProjectDefaults(project, {
    source: args.from,
    filters: parseScopeFilterFlags(args.filters ?? [], "--filter"),
    prefer: parseScopeFilterFlags(args.prefer ?? [], "--prefer"),
  });
  const curated = await akmCurate({
    query: args.query,
    type: args.type,
    limit: limitParsed && limitParsed > 0 ? limitParsed : 4,
    source,
    filters,
    prefer,
    belief: parseBeliefFilterMode(args.belief ?? "current"),
    eventSource: args.eventSource ?? resolveUsageEventSource(),
    attributionProjection: outputMode.shape === "agent" ? "agent" : outputMode.detail,
    project: projectContext(project, filters),
  });
  return view ? { ...curated, project: view } : curated;
}

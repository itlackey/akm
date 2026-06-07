// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm graph` command family. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.graph` key and every subcommand's
 * args/output shape are byte-identical. Each handler is migrated to
 * `defineJsonCommand`, which wraps the body in `runWithJsonErrors` and emits the
 * same JSON envelope (stdout/stderr/exit-code) as the inline `runWithJsonErrors`
 * form it replaces.
 */

import { defineCommand } from "citty";
import { hasSubcommand, parsePositiveIntFlag } from "../cli/parse-args";
import { defineJsonCommand, output, runWithJsonErrors } from "../cli/shared";
import {
  akmGraphEntities,
  akmGraphEntity,
  akmGraphExport,
  akmGraphOrphans,
  akmGraphRelated,
  akmGraphRelations,
  akmGraphSummary,
  akmGraphUpdate,
} from "./graph";

const GRAPH_SUBCOMMAND_SET = new Set([
  "summary",
  "entities",
  "entity",
  "relations",
  "related",
  "orphans",
  "export",
  "update",
]);

export const graphCommand = defineCommand({
  meta: { name: "graph", description: "Inspect the indexed entity graph stored in SQLite" },
  subCommands: {
    summary: defineJsonCommand({
      meta: { name: "summary", description: "Show entity-graph counts and quality telemetry" },
      args: {
        source: { type: "string", description: "Source name/path (default: primary stash source)" },
      },
      run({ args }) {
        output("graph-summary", akmGraphSummary({ source: args.source }));
      },
    }),
    entities: defineJsonCommand({
      meta: { name: "entities", description: "List entities with per-file occurrence counts" },
      args: {
        source: { type: "string", description: "Source name/path (default: primary stash source)" },
        limit: { type: "string", description: "Maximum entities to return" },
      },
      run({ args }) {
        output(
          "graph-entities",
          akmGraphEntities({ source: args.source, limit: parsePositiveIntFlag(args.limit ?? undefined) }),
        );
      },
    }),
    relations: defineJsonCommand({
      meta: { name: "relations", description: "List relations with occurrence counts" },
      args: {
        source: { type: "string", description: "Source name/path (default: primary stash source)" },
        limit: { type: "string", description: "Maximum relations to return" },
      },
      run({ args }) {
        output(
          "graph-relations",
          akmGraphRelations({ source: args.source, limit: parsePositiveIntFlag(args.limit ?? undefined) }),
        );
      },
    }),
    related: defineJsonCommand({
      meta: { name: "related", description: "Show graph-related neighboring assets for a ref" },
      args: {
        ref: { type: "positional", description: "Asset ref", required: true },
        source: { type: "string", description: "Source name/path (default: primary stash source)" },
        limit: { type: "string", description: "Maximum related assets to return" },
      },
      async run({ args }) {
        output(
          "graph-related",
          await akmGraphRelated({
            ref: args.ref ?? "",
            source: args.source,
            limit: parsePositiveIntFlag(args.limit ?? undefined),
          }),
        );
      },
    }),
    entity: defineJsonCommand({
      meta: { name: "entity", description: "List assets that contain the given entity" },
      args: {
        name: { type: "positional", description: "Entity name", required: true },
        source: { type: "string", description: "Source name/path (default: primary stash source)" },
        limit: { type: "string", description: "Maximum matches to return" },
      },
      run({ args }) {
        output(
          "graph-entity",
          akmGraphEntity({
            name: args.name ?? "",
            source: args.source,
            limit: parsePositiveIntFlag(args.limit ?? undefined),
          }),
        );
      },
    }),
    orphans: defineJsonCommand({
      meta: { name: "orphans", description: "List assets with no extracted graph entities" },
      args: {
        source: { type: "string", description: "Source name/path (default: primary stash source)" },
        limit: { type: "string", description: "Maximum orphans to return" },
      },
      run({ args }) {
        output(
          "graph-orphans",
          akmGraphOrphans({ source: args.source, limit: parsePositiveIntFlag(args.limit ?? undefined) }),
        );
      },
    }),
    export: defineJsonCommand({
      meta: { name: "export", description: "Export graph artifact as JSON or JSONL" },
      args: {
        source: { type: "string", description: "Source name/path (default: primary stash source)" },
        out: { type: "string", description: "Output path" },
        format: { type: "string", description: "Export format (json|jsonl)", default: "json" },
      },
      run({ args }) {
        output(
          "graph-export",
          akmGraphExport({
            source: args.source,
            out: args.out ?? "",
            format: args.format,
          }),
        );
      },
    }),
    update: defineJsonCommand({
      meta: { name: "update", description: "Re-run graph extraction, optionally scoped to specific asset refs" },
      args: {
        refs: {
          type: "positional",
          description: "Zero or more asset refs to scope extraction (omit for a full re-extract)",
          required: false,
          default: "",
        },
        source: { type: "string", description: "Source name/path (default: primary stash source)" },
      },
      async run({ args }) {
        // `refs` is a single positional; collect remaining argv tokens as well.
        const rawRefs = [args.refs, ...(Array.isArray(args._) ? (args._ as string[]) : [])].filter(
          (r): r is string => typeof r === "string" && r.trim().length > 0,
        );
        output(
          "graph-update",
          await akmGraphUpdate({ refs: rawRefs.length > 0 ? rawRefs : undefined, source: args.source }),
        );
      },
    }),
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      if (hasSubcommand(args, GRAPH_SUBCOMMAND_SET)) return;
      output("graph-summary", akmGraphSummary());
    });
  },
});

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm fact` — manage durable stash-level facts (the `fact` asset type, phase 2).
 *
 * Subcommands:
 *   - `add <name> [content]` — hot-capture a fact (à la `akm remember`), writing
 *     `facts/<category>/<name>.md` with `category` + optional `pinned`.
 *   - `list` — list indexed facts, optionally filtered by `--category` / `--pinned`.
 *   - `context` — print the assembled "pinned core" block (the same block the
 *     `akm agent` dispatch prepends to a system prompt). Useful for previewing
 *     or piping into an AGENTS.md / CLAUDE.md.
 */

import { defineCommand } from "citty";
import { defineJsonCommand, output } from "../../cli/shared";
import { serializeFrontmatter } from "../../core/asset/asset-serialize";
import { toErrorMessage, tryReadStdinText } from "../../core/common";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../../indexer/db/db";
import { assertFlatAssetName, writeMarkdownAsset } from "../read/knowledge";
import { buildPinnedFactsBlock, collectPinnedFacts } from "./fact-context";

/** Recommended categories (mirrors the fact linter). Free values are allowed but linted. */
const KNOWN_CATEGORIES = ["personal", "team", "project", "convention", "meta"] as const;

function buildFactFrontmatter(fields: { description?: string; category: string; pinned?: boolean }): string {
  const obj: Record<string, unknown> = { category: fields.category };
  if (fields.description?.trim()) obj.description = fields.description.trim();
  if (fields.pinned) obj.pinned = true;
  obj.updated = new Date().toISOString().slice(0, 10);
  return `---\n${serializeFrontmatter(obj)}\n---`;
}

const addCommand = defineJsonCommand({
  meta: { name: "add", description: "Record a durable stash fact (facts/<category>/<name>.md)" },
  args: {
    name: {
      type: "positional",
      description: "Fact name (flat, no '/'; use --category for the subdirectory)",
      required: false,
    },
    content: { type: "positional", description: "Fact body. Omit to read markdown from stdin.", required: false },
    category: {
      type: "string",
      description: `Fact category — scopes the fact (one of: ${KNOWN_CATEGORIES.join(", ")}; free values allowed but linted)`,
    },
    pinned: { type: "boolean", description: "Mark this fact as always-injected core context", default: false },
    description: { type: "string", description: "Short description written to frontmatter" },
    path: { type: "string", description: "Subdirectory under facts/ (defaults to --category)" },
    force: { type: "boolean", description: "Overwrite an existing fact with the same name", default: false },
    target: { type: "string", description: "Override the write destination (a configured source name)" },
  },
  async run({ args }) {
    if (!args.name || typeof args.name !== "string") {
      throw new UsageError(
        "Usage: akm fact add <name> [content] --category <category>",
        "MISSING_REQUIRED_ARGUMENT",
        "Provide a flat fact name; pass the body as a quoted argument or via stdin.",
      );
    }
    assertFlatAssetName(args.name);
    const category = typeof args.category === "string" ? args.category.trim() : "";
    if (!category) {
      throw new UsageError(
        `A --category is required (one of: ${KNOWN_CATEGORIES.join(", ")}).`,
        "MISSING_REQUIRED_ARGUMENT",
      );
    }

    const body = (typeof args.content === "string" ? args.content : undefined) ?? tryReadStdinText();
    if (!body?.trim()) {
      throw new UsageError("Fact content is required. Pass quoted text or pipe markdown into stdin.");
    }

    const description = typeof args.description === "string" ? args.description : undefined;
    const pinned = args.pinned === true;
    const frontmatter = buildFactFrontmatter({ description, category, pinned });
    const subPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : category;

    const result = await writeMarkdownAsset({
      type: "fact",
      content: `${frontmatter}\n${body}`,
      name: args.name,
      fallbackPrefix: "fact",
      force: args.force === true,
      target: typeof args.target === "string" ? args.target : undefined,
      path: subPath,
    });
    appendEvent({
      eventType: "fact_add",
      ref: result.ref,
      metadata: { path: result.path, category, pinned, force: args.force === true },
    });
    output("fact-add", { ok: true, ...result, category, pinned });
  },
});

/** Pull the `category:<x>` value out of an entry's search hints, if present. */
function categoryFromHints(hints: string[] | undefined): string | undefined {
  const hit = hints?.find((h) => h.startsWith("category:"));
  return hit ? hit.slice("category:".length) : undefined;
}

const listCommand = defineJsonCommand({
  meta: { name: "list", description: "List indexed facts (optionally filtered by --category / --pinned)" },
  args: {
    category: { type: "string", description: "Only list facts in this category" },
    pinned: { type: "boolean", description: "Only list pinned (always-injected core) facts", default: false },
  },
  run({ args }) {
    const categoryFilter = typeof args.category === "string" ? args.category.trim() : undefined;
    const pinnedOnly = args.pinned === true;

    let db: ReturnType<typeof openExistingDatabase> | undefined;
    let facts: Array<{ ref: string; name: string; category?: string; pinned: boolean; description?: string }> = [];
    try {
      db = openExistingDatabase();
      facts = getAllEntries(db, "fact")
        .map((row) => {
          const category = categoryFromHints(row.entry.searchHints);
          return {
            ref: `fact:${row.entry.name}`,
            name: row.entry.name,
            ...(category ? { category } : {}),
            pinned: row.entry.searchHints?.includes("pinned") ?? false,
            ...(row.entry.description ? { description: row.entry.description } : {}),
          };
        })
        .filter((f) => (categoryFilter ? f.category === categoryFilter : true))
        .filter((f) => (pinnedOnly ? f.pinned : true))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      // No index yet → empty list rather than a hard error.
      void toErrorMessage(err);
      facts = [];
    } finally {
      if (db) closeDatabase(db);
    }

    output("fact-list", { ok: true, facts, totalCount: facts.length });
  },
});

const contextCommand = defineJsonCommand({
  meta: {
    name: "context",
    description: "Print the assembled pinned-fact core block (what `akm agent` injects into the system prompt)",
  },
  run() {
    const facts = collectPinnedFacts();
    output("fact-context", { ok: true, content: buildPinnedFactsBlock(facts), count: facts.length });
  },
});

const factSubCommands = {
  add: addCommand,
  list: listCommand,
  context: contextCommand,
};

export const FACT_SUBCOMMAND_SET = new Set(Object.keys(factSubCommands));

export const factCommand = defineCommand({
  meta: {
    name: "fact",
    description:
      "Manage durable stash-level facts (the `fact` asset type): personal/team/project details, coding conventions, and stash-meta. Subcommands: add, list, context.",
  },
  subCommands: factSubCommands,
});

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text renderers for the stash-lifecycle verbs: init, index, list,
 * models, bundle show/add/remove/rename, update, upgrade and clone.
 */

import type { IndexResponse } from "../../indexer/indexer";

export function formatInitPlain(r: Record<string, unknown>): string {
  let out = `Bundle initialized at ${r.bundleDir ?? "unknown"}`;
  // When --dir scaffolded a secondary bundle but the default was deliberately
  // left untouched, tell the user instead of silently repointing their default.
  if (r.defaultBundleUpdated === false && typeof r.previousBundleDir === "string" && r.previousBundleDir) {
    out += `\nYour default bundle is unchanged (${r.previousBundleDir}). Re-run with --set-default to make ${r.bundleDir} the default.`;
  } else if (r.configPath) {
    out += `\nConfig saved to ${r.configPath}`;
  }
  return out;
}

export function formatIndexPlain(r: Record<string, unknown>): string {
  const exported = r.exported as { file?: string; vectors?: number } | undefined;
  if (exported) return `Exported ${exported.vectors ?? 0} vectors to ${exported.file}`;
  const indexResult = r as Partial<IndexResponse>;
  let out = `Indexed ${indexResult.totalEntries ?? 0} entries from ${indexResult.directoriesScanned ?? 0} directories (mode: ${indexResult.mode ?? "unknown"})`;
  const warnings = indexResult.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    out += `\nWarnings (${warnings.length}):`;
    out += warnings.map((message) => `\n  - ${String(message)}`).join("");
  }
  const verification = indexResult.verification;
  if (verification?.ok === false && verification.message) {
    out += `\nVerification: ${String(verification.message)}`;
  }
  const timing = indexResult.timing;
  if (timing) {
    const t = timing;
    out += `\nTiming: total ${t.totalMs}ms, preflight ${t.preflightMs}ms, walk ${t.walkMs}ms, llm ${t.llmMs}ms, embeddings ${t.embedMs}ms, fts ${t.ftsMs}ms, finalize ${t.finalizeMs}ms, clean ${t.cleanMs}ms, end-to-end ${t.endToEndMs}ms`;
  }
  return out;
}

export function formatListPlain(r: Record<string, unknown>): string {
  const sources = Array.isArray(r.sources) ? (r.sources as Record<string, unknown>[]) : [];
  if (sources.length === 0) return "No sources configured. Use `akm bundle add` to add a source.";
  const lines = sources.map((src) => {
    const kind = typeof src.kind === "string" ? src.kind : "unknown";
    const name = typeof src.name === "string" ? src.name : "unnamed";
    const ver = typeof src.version === "string" ? ` v${src.version}` : "";
    const prov = typeof src.provider === "string" ? ` (${src.provider})` : "";
    const flags = [src.default === true && "default", src.writable === true && "writable"].filter(Boolean);
    return `[${kind}] ${name}${ver}${prov}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`;
  });
  lines.push("", "To search: akm search '<query>'  |  To view an asset: akm show <ref>");
  return lines.join("\n");
}

/** Render `akm models`'s `{ connection, aliases, available }`: each alias's model, then the models the endpoint lists. */
export function formatModelsPlain(r: Record<string, unknown>): string {
  const aliases =
    r.aliases && typeof r.aliases === "object" ? Object.entries(r.aliases as Record<string, unknown>) : [];
  const available = Array.isArray(r.available) ? r.available.map(String) : [];
  const title = `Connection ${String(r.connection ?? "?")}`;
  if (aliases.length === 0 && available.length === 0) {
    return `${title} has no model aliases. Set one with \`akm models set <alias> <model>\`.`;
  }
  const lines = [title];
  if (aliases.length > 0) {
    const width = Math.max("ALIAS".length, ...aliases.map(([alias]) => alias.length));
    lines.push(
      `${"ALIAS".padEnd(width)}  MODEL`,
      ...aliases.map(([alias, model]) => `${alias.padEnd(width)}  ${String(model)}`),
    );
  }
  if (available.length > 0)
    lines.push(...(aliases.length > 0 ? [""] : []), "AVAILABLE", ...available.map((model) => `  ${model}`));
  return lines.join("\n");
}

/** Render `akm models set`'s result. */
export function formatModelsSetPlain(r: Record<string, unknown>): string {
  const was = typeof r.previous === "string" ? ` (was ${r.previous})` : "";
  return `${String(r.alias)} -> ${String(r.model)} on connection ${String(r.connection)}${was}`;
}

/** Render a single `SourceEntry` — `akm bundle show <name>`'s detail view of one `list` row. */
export function formatBundleShowPlain(r: Record<string, unknown>): string {
  const name = typeof r.name === "string" ? r.name : "unknown";
  const kind = typeof r.kind === "string" ? r.kind : "unknown";
  const lines = [`${name} [${kind}]`];
  if (r.default === true) lines.push("  default: true");
  if (r.writable === true) lines.push("  writable: true");
  for (const key of ["version", "provider", "path", "ref", "registryId"]) {
    if (typeof r[key] === "string") lines.push(`  ${key}: ${r[key]}`);
  }
  lines.push(`  items: ${typeof r.itemCount === "number" ? r.itemCount : 0}`);
  const byType = r.byType as Record<string, number> | undefined;
  if (byType && Object.keys(byType).length > 0) {
    lines.push(
      `  byType: ${Object.entries(byType)
        .map(([t, n]) => `${t}=${n}`)
        .join(", ")}`,
    );
  }
  const status = r.status as { exists?: boolean } | undefined;
  if (status?.exists === false) lines.push("  status: MISSING on disk");
  return lines.join("\n");
}

export function formatAddPlain(r: Record<string, unknown>): string {
  // `akm bundle add <ref>` (source-add.ts `AddResponse`) and `akm bundle add
  // <target> --provider <kind>` (source-manage.ts `SourceAddResult`) are
  // genuinely different operations that happen to share the "add" command
  // name: the former eagerly fetches and indexes content, the latter only
  // writes a desired locator to config — nothing is synced until a later
  // `akm bundle update`. Force-fitting the declarative shape's `added`/`entry`/`message`
  // fields into the "Installed <ref> (N scanned...)" wording produced
  // "Installed undefined (0 directories scanned...)" because it
  // implied a sync that never happened. `AddResponse` always carries an
  // `index` block (even when zero entries were scanned); `SourceAddResult`
  // never does — that is the reliable shape discriminator used below to
  // render each honestly instead of unifying them.
  if (!("index" in r)) return formatDeclarativeAddPlain(r);
  const index = r.index as Record<string, unknown> | undefined;
  const scanned = index?.directoriesScanned ?? 0;
  const total = index?.totalEntries ?? 0;
  const bundleSuffix = typeof r.bundleId === "string" && r.bundleId.length > 0 ? ` as bundle "${r.bundleId}"` : "";
  const lines = [`Installed ${r.ref}${bundleSuffix} (${scanned} directories scanned, ${total} total assets indexed)`];
  const warnings = index?.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push(`Warnings (${warnings.length}):`);
    lines.push(...warnings.map((message) => `  - ${String(message)}`));
  }
  return lines.join("\n");
}

/** Render a `SourceAddResult` (declarative `--provider` add) — see {@link formatAddPlain}. */
function formatDeclarativeAddPlain(r: Record<string, unknown>): string {
  if (r.added !== true) {
    return typeof r.message === "string" ? r.message : "add: no changes";
  }
  const entry = r.entry as Record<string, unknown> | undefined;
  const kind = typeof entry?.type === "string" ? entry.type : "source";
  const name =
    (typeof entry?.name === "string" && entry.name) ||
    (typeof entry?.path === "string" && entry.path) ||
    (typeof entry?.url === "string" && entry.url) ||
    "source";
  // A filesystem bundle reflects files already on disk — nothing to fetch,
  // just index it. Every other declarative kind (git/website/npm) is a
  // locator only; its content is not materialized until `akm bundle update`.
  if (kind === "filesystem") {
    return `Added ${name} (filesystem) — run \`akm index\` to index it.`;
  }
  return `Added ${name} (${kind}) — not yet synced; run \`akm bundle update ${name}\` to fetch it.`;
}

export function formatRemovePlain(r: Record<string, unknown>): string {
  const target = r.target ?? r.ref ?? "";
  const ok = r.ok !== false ? "OK" : "FAILED";
  return `remove: ${target} ${ok}`;
}

export function formatBundleRenamePlain(r: Record<string, unknown>): string {
  const oldId = String(r.oldId ?? "?");
  const newId = String(r.newId ?? "?");
  const applied = r.applied === true;
  const config = (r.config as Record<string, unknown> | undefined) ?? {};
  const state = (r.state as Record<string, unknown> | undefined) ?? {};
  const index = (r.index as Record<string, unknown> | undefined) ?? {};
  const schedulerRefs = Array.isArray(config.schedulerRefs) ? config.schedulerRefs.length : 0;
  const proposalRefs = Number(state.proposalRefs ?? 0);
  const proposalTargets = Number(state.proposalTargets ?? 0);
  const taskHistoryRefs = Number(state.taskHistoryRefs ?? 0);
  const workflowRunRefs = Number(state.workflowRunRefs ?? 0);
  const activeWorkflowRuns = Array.isArray(r.activeWorkflowRuns)
    ? (r.activeWorkflowRuns as Array<{ id: string; workflowRef: string; status: string }>)
    : [];
  const entries = Number(index.entries ?? 0);
  const contentRefs = Array.isArray(r.contentRefs) ? r.contentRefs : [];
  const nativeSchedulerRows = Array.isArray(r.nativeSchedulerRows) ? r.nativeSchedulerRows : [];

  const verb = applied ? "Renamed" : "Would rename";
  const lines = [
    `${verb} bundle "${oldId}" to "${newId}" (${entries} index entries, ${schedulerRefs} scheduler ref(s), ` +
      `${proposalRefs + proposalTargets} proposal reference(s), ${taskHistoryRefs} task-history row(s), ` +
      `${workflowRunRefs} workflow run(s)).`,
  ];
  if (activeWorkflowRuns.length > 0) {
    lines.push(
      "Active and blocked workflow runs keep the old bundle name in their frozen plan; continue them (`akm run <id>`, after `akm workflow resume <id>` for a blocked one) or abandon them (`akm workflow abandon <id>`):",
    );
    lines.push(...activeWorkflowRuns.map((run) => `  - ${run.id} (${run.workflowRef}, ${run.status})`));
  }
  if (!applied) {
    lines.push("Re-run without --dry-run to apply. It also re-syncs native scheduler bindings under the new name.");
    if (nativeSchedulerRows.length > 0) {
      lines.push(`Native scheduler rows naming "${oldId}//" that the sync would replace:`);
      lines.push(...nativeSchedulerRows.map((row) => `  - ${String(row)}`));
    }
  } else {
    const taskSync = r.taskSync as { ok?: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    const syncResult = taskSync?.result;
    if (syncResult) {
      const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
      const [installed, updated, removed] = [syncResult.installed, syncResult.updated, syncResult.removed].map(count);
      const failures = Array.isArray(syncResult.failures)
        ? (syncResult.failures as { path: string; ref?: string; reason: string }[])
        : [];
      if (failures.length === 0) {
        lines.push(
          `Native scheduler bindings re-synced under the new name (${installed} installed, ${updated} updated, ${removed} removed).`,
        );
      } else {
        lines.push(
          `Native scheduler sync after rename: ${installed} installed, ${updated} updated, ${removed} removed, ${failures.length} failed.`,
        );
        lines.push(...failures.map((failure) => `  - ${failure.ref ?? failure.path}: ${failure.reason}`));
        lines.push("Run `akm doctor scheduler sync` to retry.");
      }
    } else if (taskSync?.ok === false && taskSync.error) {
      lines.push(
        `Re-syncing native scheduler bindings failed: ${taskSync.error}. Run \`akm doctor scheduler sync\` to retry.`,
      );
    }
  }
  if (contentRefs.length > 0) {
    lines.push(`Content still spelling "${oldId}//" (not rewritten — edit these by hand):`);
    lines.push(...contentRefs.map((file) => `  - ${String(file)}`));
  }
  return lines.join("\n");
}

export function formatUpdatePlain(r: Record<string, unknown>): string {
  // `processed` alone would conflate three cases into one empty array —
  // a true no-op (--all with nothing configured), a source this call flatly
  // never looked at (a plain source under --all), and a plain git/website
  // source that WAS just synced successfully but has no `UpdateResultItem`
  // shape to report (no version/lock to diff). All three would render as the
  // same misleading "nothing to update". `plainSynced` and `skipped` (see
  // sources/types.ts) cover the other two so this can report accurately.
  const processed = r.processed as Array<Record<string, unknown>> | undefined;
  const plainSynced = r.plainSynced as Array<Record<string, unknown>> | undefined;
  const skipped = r.skipped as Array<Record<string, unknown>> | undefined;
  const lines: string[] = [];
  for (const item of processed ?? []) {
    const changed = item.changed as Record<string, unknown> | undefined;
    const installed = item.installed as Record<string, unknown> | undefined;
    const previous = item.previous as Record<string, unknown> | undefined;
    if (changed?.any) {
      const prev = previous?.resolvedVersion ?? "unknown";
      const next = installed?.resolvedVersion ?? "unknown";
      lines.push(`update: ${item.id} v${prev} → v${next}`);
    } else {
      lines.push(`update: ${item.id} (unchanged)`);
    }
  }
  for (const item of plainSynced ?? []) {
    lines.push(
      item.kind === "filesystem"
        ? `update: ${item.id} reconciled (filesystem)`
        : `update: ${item.id} synced (${item.kind})`,
    );
  }
  for (const item of skipped ?? []) {
    lines.push(`update: ${item.id} skipped — ${item.reason}`);
  }
  return lines.length > 0 ? lines.join("\n") : `update: nothing to update`;
}

const HARNESS_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  "opencode-v2": "OpenCode 2",
};

/** The plugin lines worth printing: nothing for a plugin that is current or has no plugin to update. */
function formatUpgradePluginLines(r: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const plugins = Array.isArray(r.plugins) ? (r.plugins as Array<Record<string, unknown>>) : [];
  for (const p of plugins) {
    if (
      (p.outcome === "current" || p.outcome === "skipped") &&
      (r.updateAvailable === undefined || !p.channel) &&
      !p.channelMismatch &&
      !p.targetChannel
    )
      continue;
    const versions = p.from && p.to && p.from !== p.to ? ` v${p.from} → v${p.to}` : "";
    const channel = p.channel ? ` [channel ${p.channel}${p.channelMismatch ? "; differs from CLI" : ""}]` : "";
    const note = p.message ? ` (${p.message})` : "";
    const outcome = p.outcome === "current" && p.channel ? "current within its configured channel" : p.outcome;
    lines.push(`${HARNESS_LABELS[String(p.harness)] ?? p.harness} plugin ${outcome}${versions}${channel}${note}`);
  }
  return lines;
}

export function formatUpgradePlain(r: Record<string, unknown>): string | null {
  const lines = formatUpgradePluginLines(r);
  const head = formatUpgradeHead(r);
  const all = head === null ? lines : [head, ...lines];
  return all.length > 0 ? all.join("\n") : null;
}

function formatUpgradeHead(r: Record<string, unknown>): string | null {
  if (r.upgraded === true) {
    return `akm upgraded: v${r.currentVersion} → v${r.newVersion}`;
  }
  if (r.targetChannel && r.latestVersion && r.latestVersion !== r.currentVersion && r.updateAvailable === false) {
    return `akm v${r.currentVersion} → v${r.latestVersion} requires --allow-downgrade (run 'akm upgrade --channel ${r.targetChannel} --allow-downgrade' to install)`;
  }
  if (r.updateAvailable === true) {
    return `akm v${r.currentVersion} → v${r.latestVersion} available (run 'akm upgrade${r.targetChannel ? ` --channel ${r.targetChannel}` : r.channel === "next" && r.currentChannel !== "next" ? " --channel next" : ""}' to install)`;
  }
  if (r.updateAvailable === false && r.latestVersion) {
    return `akm v${r.currentVersion} is already the latest version`;
  }
  if (r.message) return String(r.message);
  return null;
}

export function formatClonePlain(r: Record<string, unknown>): string {
  const dst = (r.destination as Record<string, unknown>)?.path ?? "unknown";
  const remote = r.remoteFetched ? " (fetched from remote)" : "";
  const over = r.overwritten ? " (overwritten)" : "";
  return `Cloned${remote} → ${dst}${over}`;
}

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup wizard steps for stash sources and registries: toggle configured
 * sources, pull registry-recommended stashes, add custom sources, and toggle
 * built-in registries.
 */

import * as p from "../../cli/clack";
import type { AkmConfig, RegistryConfigEntry, SourceConfigEntry } from "../../core/config/config";
import { DEFAULT_CONFIG, getEffectiveRegistries } from "../../core/config/config";
import { prompt, promptOrBack } from "../prompt";
import { loadSetupStashes } from "../registry-stash-loader";

function configuredSourceKey(source: SourceConfigEntry): string {
  return `${source.type}:${source.path ?? source.url ?? source.name ?? "unknown"}`;
}

type ConfiguredSourceOption = {
  value: string;
  label: string;
  hint: string;
};

function describeConfiguredSource(source: SourceConfigEntry): ConfiguredSourceOption {
  const target = source.path ?? source.url ?? "(unknown target)";
  const typeLabel = source.type === "git" ? "Git" : source.type === "filesystem" ? "Filesystem" : source.type;
  return {
    value: configuredSourceKey(source),
    label: source.name ?? target,
    hint: `${typeLabel}: ${target}`,
  };
}

function renderConfiguredSourceList(sources: SourceConfigEntry[]): string {
  return sources
    .map((source) => {
      const described = describeConfiguredSource(source);
      return `- ${described.label} (${described.hint})`;
    })
    .join("\n");
}

function renderInstalledSourceList(installed: NonNullable<AkmConfig["installed"]>): string {
  return installed.map((entry) => `- ${entry.id} (${entry.source})`).join("\n");
}

export async function stepAdditionalSources(currentSources: SourceConfigEntry[]): Promise<SourceConfigEntry[]> {
  const sources = [...currentSources];

  let addMore = true;
  while (addMore) {
    const action = await prompt(() =>
      p.select({
        message: "Add another stash source?",
        options: [
          { value: "done", label: "Done — no more sources" },
          { value: "github-repo", label: "GitHub repository", hint: "custom URL" },
          { value: "filesystem", label: "Filesystem path", hint: "local directory" },
        ],
        initialValue: "done",
      }),
    );

    if (action === "done") {
      addMore = false;
      break;
    }

    if (action === "github-repo") {
      const url = await promptOrBack(() =>
        p.text({
          message: "Enter the GitHub repository URL:",
          placeholder: "https://github.com/owner/repo",
          validate: (v) => {
            if (!v?.trim()) return "URL cannot be empty";
          },
        }),
      );
      if (url === null) continue;

      const name = await promptOrBack(() =>
        p.text({
          message: "Give this stash a name (optional):",
          placeholder: "my-repo",
        }),
      );
      if (name === null) continue;

      const entry: SourceConfigEntry = { type: "git", url: url.trim() };
      if (name.trim()) entry.name = name.trim();
      if (!sources.some((s) => s.url === entry.url)) {
        sources.push(entry);
      } else {
        p.log.warn("This URL is already configured.");
      }
    }

    if (action === "filesystem") {
      const fsPath = await promptOrBack(() =>
        p.text({
          message: "Enter the directory path:",
          placeholder: "/path/to/stash",
          validate: (v) => {
            if (!v?.trim()) return "Path cannot be empty";
          },
        }),
      );
      if (fsPath === null) continue;

      const resolved = fsPath.trim();
      const name = await promptOrBack(() =>
        p.text({
          message: "Give this stash a name (optional):",
          placeholder: "my-stash",
        }),
      );
      if (name === null) continue;

      const entry: SourceConfigEntry = { type: "filesystem", path: resolved };
      if (name.trim()) entry.name = name.trim();
      if (!sources.some((s) => s.path === entry.path)) {
        sources.push(entry);
      } else {
        p.log.warn("This path is already configured.");
      }
    }
  }

  return sources;
}

export async function stepRegistries(current: AkmConfig): Promise<RegistryConfigEntry[] | undefined> {
  const defaults = DEFAULT_CONFIG.registries ?? [];
  const currentRegistries = current.registries ?? defaults;
  const defaultUrls = new Set(defaults.map((r) => r.url));
  const enabledUrls = new Set(currentRegistries.filter((r) => r.enabled !== false).map((r) => r.url));

  // Collect custom (non-default) registries to preserve them
  const customRegistries = currentRegistries.filter((r) => !defaultUrls.has(r.url));

  // Show default registries for toggling
  const options = defaults.map((r) => ({
    value: r.url,
    label: r.name ?? r.url,
    hint: r.provider ?? "static index",
  }));

  if (customRegistries.length > 0) {
    p.log.info(
      `You have ${customRegistries.length} custom registr${customRegistries.length === 1 ? "y" : "ies"} that will be preserved.`,
    );
  }

  const selected = await prompt(() =>
    p.multiselect({
      message: "Which built-in registries should be enabled?",
      options,
      initialValues: options.filter((o) => enabledUrls.has(o.value)).map((o) => o.value),
    }),
  );

  // If all defaults are selected and there are no custom registries,
  // return undefined to use the built-in defaults (avoids pinning)
  const allDefaultsSelected = defaults.every((r) => selected.includes(r.url));
  if (allDefaultsSelected && customRegistries.length === 0) {
    return undefined;
  }

  // Build explicit list: toggled defaults + preserved custom registries
  const result: RegistryConfigEntry[] = defaults.map((r) => ({
    ...r,
    enabled: selected.includes(r.url),
  }));

  // Re-add custom registries unchanged
  for (const custom of customRegistries) {
    result.push(custom);
  }

  return result;
}

/**
 * @internal Exported for testing only.
 */
export async function stepAddSources(
  current: AkmConfig,
  options?: { promptForAdditional?: boolean },
): Promise<SourceConfigEntry[]> {
  const existingSources: SourceConfigEntry[] = [...(current.sources ?? [])];
  const sources: SourceConfigEntry[] = [];

  if (existingSources.length > 0) {
    p.note(renderConfiguredSourceList(existingSources), "Configured stash sources");
    const options = existingSources.map(describeConfiguredSource);
    const selected = await prompt(() =>
      p.multiselect({
        message: "Configured stash sources — uncheck any you want to disable:",
        options,
        initialValues: options.map((option) => option.value),
        required: false,
      }),
    );

    for (const source of existingSources) {
      if (selected.includes(configuredSourceKey(source))) {
        sources.push(source);
      }
    }
  }

  if ((current.installed?.length ?? 0) > 0) {
    p.note(renderInstalledSourceList(current.installed ?? []), "Installed managed stashes (preserved)");
  }

  // ── Registry-driven stash recommendations ─────────────────────────────
  // Fetch available stashes from the official registry (cached, stale-ok).
  // Falls back to the bundled list when the registry is unreachable.
  const registryUrl =
    getEffectiveRegistries(current)[0]?.url ??
    "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json";

  const availableStashes = await loadSetupStashes(registryUrl);

  if (availableStashes.length > 0) {
    const existingUrls = new Set(sources.map((s) => s.url));

    const stashOptions = availableStashes.map((s) => ({
      value: s.url,
      label: s.name,
      hint: existingUrls.has(s.url) ? `${s.description} (already added)` : s.description || s.source,
    }));

    // Pre-check: already-installed stashes OR default-selected on fresh install
    const initialValues =
      sources.length > 0
        ? stashOptions.filter((o) => existingUrls.has(o.value)).map((o) => o.value)
        : availableStashes.filter((s) => s.defaultSelected).map((s) => s.url);

    const selectedUrls = await prompt(() =>
      p.multiselect({
        message:
          availableStashes[0]?.source === "registry"
            ? "Available stashes from the AKM registry — toggle to add or remove:"
            : "Recommended stash sources — toggle to add or remove:",
        options: stashOptions,
        initialValues,
        required: false,
      }),
    );

    // Add newly selected stashes
    for (const url of selectedUrls) {
      if (!existingUrls.has(url)) {
        const entry = availableStashes.find((s) => s.url === url);
        sources.push({ type: "git", url, name: entry?.name });
        existingUrls.add(url);
      }
    }

    // Remove deselected stashes that were previously configured
    for (const entry of availableStashes) {
      if (existingUrls.has(entry.url) && !selectedUrls.includes(entry.url)) {
        const idx = sources.findIndex((s) => s.url === entry.url);
        if (idx !== -1) {
          sources.splice(idx, 1);
          existingUrls.delete(entry.url);
          p.log.info(`Removed ${entry.name}.`);
        }
      }
    }
  }

  if (options?.promptForAdditional === false) {
    return sources;
  }

  return stepAdditionalSources(sources);
}

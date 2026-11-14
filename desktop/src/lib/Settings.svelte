<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { api, date, pickFolder, type ApiError } from "./client";
  import SettingsBundleCard from "./SettingsBundle.svelte";
  import SettingsFieldControl from "./SettingsField.svelte";
  import Connections from "./Connections.svelte";
  import EmbeddingSettings from "./EmbeddingSettings.svelte";
  import Software from "./Software.svelte";
  import Icon from "./Icon.svelte";
  import { configurationChanges, fieldText, provenance, valueAt } from "./settings-presenter";
  import type { SettingsBundleResponse, SettingsConfig, SettingsGroup } from "./settings-presenter";
  import type { Bundle } from "./types";
  import { navigate } from "./navigation";
  import { bundleRenamed, refreshBundles } from "./state/workspace.svelte";
  let {
    bundles = [],
    route = "bundles",
    query = new URLSearchParams(),
  }: { bundles?: Bundle[]; route?: string; query?: URLSearchParams } = $props();
  let config = $state<SettingsConfig | null>(null),
    listing = $state<SettingsBundleResponse | null>(null);
  let error = $state(""),
    errorCode = $state(""),
    busy = $state(false),
    loading = $state(true),
    receipt = $state(""),
    generation = 0;
  let refreshButton = $state<HTMLButtonElement>();
  let sourceInput = $state<HTMLInputElement>(),
    source = $state(""),
    name = $state(""),
    writable = $state(false),
    key = $state(""),
    value = $state(""),
    unset = $state(false);
  let initial = $state<Record<string, string>>({}),
    drafts = $state<Record<string, string>>({});
  let resetKeys = new Set<string>();
  let savedKeys = $state<string[]>([]);
  let renameNotes = $state<string[]>([]);
  const groups = $derived(buildGroups(config, listing, bundles));
  const selectedGroup = $derived(query.get("section") || "library-settings");
  const manageName = $derived(route === "bundles" ? (query.get("manage") ?? "") : "");
  /** A newly loaded configuration becomes the form's baseline; edits not yet saved in other groups are kept. */
  function resetDrafts(loaded: SettingsConfig) {
    const next = Object.fromEntries(
      groups.flatMap((group) =>
        group.fields.map((field) => [field.key, fieldText(valueAt(loaded.config, field.key), field.kind)]),
      ),
    );
    const retained = Object.fromEntries(
      Object.entries(drafts).filter(
        ([key, value]) =>
          key in next &&
          value !== (initial[key] ?? "") &&
          ![...resetKeys].some((saved) => key === saved || key.startsWith(`${saved}.`)),
      ),
    );
    initial = next;
    drafts = { ...next, ...retained };
    resetKeys = new Set();
  }
  const sourceMap = $derived(new Map(config?.entries.map((entry) => [entry.path, entry.source]) ?? []));
  const editCounts = $derived(Object.fromEntries(groups.map((group) => [group.id, changed(group, initial, drafts)])));
  const effectiveGroups = $derived(
    [...new Set((config?.entries ?? []).map((entry) => entry.path.split(".")[0]))].sort(),
  );
  const filteredEffective = $derived(
    (config?.entries ?? []).filter(
      (entry) => !query.get("filter") || entry.path.toLowerCase().includes(query.get("filter")!.toLowerCase()),
    ),
  );
  // The section the address names is opened, focused and scrolled to once the configuration is on screen.
  $effect(() => {
    if (config && route === "config") void revealSection(query.get("section"));
  });
  async function revealSection(id: string | null) {
    if (!id) return;
    await tick();
    const heading = document.getElementById(id);
    if (!heading) return;
    const disclosure = heading.closest("details");
    if (disclosure) disclosure.open = true;
    heading.tabIndex = -1;
    heading.focus();
    heading.scrollIntoView({ block: "start" });
  }
  function buildGroups(
    config: SettingsConfig | null,
    listing: SettingsBundleResponse | null,
    bundles: Bundle[],
  ): SettingsGroup[] {
    const names = listing?.bundles.map((bundle) => bundle.name) ?? bundles.map((bundle) => bundle.name);
    const unavailableWrites = (listing?.bundles ?? bundles)
      .filter(
        (bundle) =>
          !bundle.enabled || !bundle.writable || !bundle.components.some((component) => component.adapter === "akm"),
      )
      .map((bundle) => bundle.name);
    const groups: SettingsGroup[] = [
      {
        id: "search-settings",
        title: "Search",
        description: "How search finds and ranks assets. Saving validates the existing AKM schema.",
        fields: [
          {
            key: "semanticSearchMode",
            label: "Semantic search",
            kind: "select",
            options: [
              ["off", "Off"],
              ["auto", "Auto"],
            ],
            hint: "Auto uses embeddings when available and keyword search otherwise.",
          },
          {
            key: "search.defaultExcludeTypes",
            label: "Hide these types by default",
            kind: "list",
            placeholder: "memory, script",
            hint: "Comma-separated types excluded unless explicitly requested.",
          },
        ],
      },
      {
        id: "library-settings",
        title: "Library defaults",
        description: "Where AKM reads by default and writes new knowledge, memories and accepted proposals.",
        fields: [
          {
            key: "defaultBundle",
            label: "Default bundle",
            kind: "select",
            disabledOptions: unavailableWrites,
            hint: unavailableWrites.includes(String(config?.config.defaultBundle ?? ""))
              ? "The default bundle cannot accept writes. Choose an enabled writable bundle."
              : "New content needs an enabled, writable AKM bundle.",
            options: [
              ["", "Automatic"],
              ...names.map(
                (name) =>
                  [name, unavailableWrites.includes(name) ? `${name} (unavailable for writes)` : name] as [
                    string,
                    string,
                  ],
              ),
            ],
          },
          { key: "archiveRetentionDays", label: "Expire pending proposals after (days)", kind: "number" },
          {
            key: "feedback.requireReason",
            label: "Require a reason with negative feedback",
            kind: "boolean",
            hint: "When off, negative feedback without a reason only warns.",
          },
        ],
      },
      {
        id: "output-settings",
        title: "Command output",
        description: "Defaults when the CLI receives no explicit format or detail option.",
        fields: [
          {
            key: "output.format",
            label: "Format",
            kind: "select",
            options: [
              ["", "Automatic (CLI default)"],
              ...["json", "yaml", "text", "jsonl", "md"].map((value) => [value, value] as [string, string]),
            ],
          },
          {
            key: "output.detail",
            label: "Detail",
            kind: "select",
            options: [
              ["", "Automatic (CLI default)"],
              ...["brief", "normal", "full"].map((value) => [value, value] as [string, string]),
            ],
          },
        ],
      },
    ];
    return groups.sort((a, b) => (a.id === "library-settings" ? -1 : b.id === "library-settings" ? 1 : 0));
  }
  function changed(group: SettingsGroup, initial: Record<string, string>, drafts: Record<string, string>) {
    const changes = configurationChanges(group.fields, initial, drafts);
    return Object.keys(changes.set).length + changes.unset.length;
  }
  async function load() {
    const mine = ++generation;
    loading = true;
    error = "";
    errorCode = "";
    try {
      const [nextConfig, nextListing] = await Promise.all([
        api<SettingsConfig>("/config"),
        api<SettingsBundleResponse>("/bundles"),
      ]);
      if (mine === generation) {
        listing = nextListing;
        config = nextConfig;
        resetDrafts(nextConfig);
      }
    } catch (cause) {
      if (mine === generation) {
        error = (cause as Error).message;
        errorCode = (cause as ApiError).code ?? "";
      }
    } finally {
      if (mine === generation) loading = false;
    }
  }
  async function action(path: string, body: unknown) {
    busy = true;
    error = "";
    errorCode = "";
    receipt = "";
    savedKeys = [];
    renameNotes = [];
    try {
      const result = await api<{
        saved?: boolean;
        oldId?: string;
        newId?: string;
        contentRefs?: string[];
        activeWorkflowRuns?: unknown[];
        taskSync?: { ok: boolean };
      }>(path, {}, body);
      receipt =
        result.saved === false
          ? "No configuration change was needed."
          : path === "/config/set"
            ? "Settings saved."
            : path === "/bundles/add"
              ? "Bundle added and indexed."
              : "Bundle changes saved.";
      if (path === "/config/set" && body && typeof body === "object") {
        const submitted = body as { set?: Record<string, unknown>; unset?: string[] };
        resetKeys = new Set([...Object.keys(submitted.set ?? {}), ...(submitted.unset ?? [])]);
        savedKeys = [...resetKeys];
      }
      await refreshBundles();
      await load();
      if (path === "/bundles/remove") await navigate("/settings/bundles");
      if (path === "/bundles/rename" && result.oldId && result.newId) {
        receipt = `Renamed ${result.oldId} to ${result.newId}. The folder has not moved.`;
        renameNotes = [
          ...(result.contentRefs ?? []).map((file) => `Old references need review: ${file}`),
          ...(result.activeWorkflowRuns?.length
            ? [`${result.activeWorkflowRuns.length} active workflow runs retain frozen references.`]
            : []),
          ...(result.taskSync?.ok === false
            ? ["The rename succeeded, but scheduler synchronization needs attention. Run akm doctor scheduler sync."]
            : []),
        ];
        bundleRenamed(result.oldId, result.newId);
        await navigate("/settings/bundles?manage=" + encodeURIComponent(result.newId));
      }
    } catch (cause) {
      error = (cause as Error).message;
      errorCode = (cause as ApiError).code ?? "";
    } finally {
      busy = false;
    }
  }
  /** Refresh is disabled while it loads, which drops focus: the button has it again when the page is back. */
  async function refresh() {
    await refreshBundles();
    await load();
    await tick();
    if (document.activeElement === document.body) refreshButton?.focus();
  }
  async function browse() {
    error = "";
    errorCode = "";
    try {
      const folder = await pickFolder(source);
      if (folder !== null) source = folder;
    } catch (cause) {
      error = (cause as Error).message;
    }
    await tick();
    sourceInput?.focus();
  }
  onMount(load);
  onDestroy(() => {
    generation++;
  });
</script>

<div class="page-header">
  <h1>Settings</h1>
  {#if route !== "software" && route !== "connections"}<button
      class="quiet"
      bind:this={refreshButton}
      disabled={busy || loading}
      onclick={refresh}><Icon name="refresh" size={16} /> Refresh settings</button
    >{/if}
</div>
<nav class="settings-tabs" aria-label="Settings views" data-sveltekit-reset="false">
  <a href="/settings/bundles" class:active={route === "bundles"} aria-current={route === "bundles" ? "page" : undefined}
    >Bundles & index</a
  ><a
    href="/settings/connections"
    class:active={route === "connections"}
    aria-current={route === "connections" ? "page" : undefined}>Connections</a
  ><a href="/settings/config" class:active={route === "config"} aria-current={route === "config" ? "page" : undefined}
    >Configuration</a
  ><a
    href="/settings/software"
    class:active={route === "software"}
    aria-current={route === "software" ? "page" : undefined}>Software</a
  >
</nav>
{#if route === "software"}<Software />{:else if route === "connections"}<Connections {query} />{:else}
  {#if error}<div class="notice notice-warn" role="alert">
      {error}
      {#if errorCode === "STASH_DIR_NOT_FOUND"}<a href="/setup">Set up akm</a>{/if}
      <p>Your entered values remain available. Review the error before retrying.</p>
    </div>{/if}
  {#each renameNotes as note}<p class="notice notice-warn">{note}</p>{/each}
  {#if receipt}<div class="notice settings-receipt" role="status">
      <div>
        {receipt}{#if savedKeys.length}<ul>
            {#each savedKeys as saved}<li>
                <code>{saved}</code>: {fieldText(valueAt(config?.config ?? {}, saved)) || "Not set"}
                <span class="muted">· {provenance(sourceMap.get(saved))}</span>
              </li>{/each}
          </ul>{/if}
      </div>
      <button class="btn-secondary" onclick={() => (receipt = "")}>Dismiss</button>
    </div>{/if}
  {#if loading && !config}<p role="status">Loading settings…</p>{:else if route !== "config"}
    <p class="muted" hidden={!!manageName}>
      Default bundle: <strong>{listing?.defaultBundle ?? "none yet"}</strong>.
      <a href="/settings/config">Change library defaults</a> · <a href="/setup">Run setup again</a>
    </p>
    {#if manageName}<a class="bundle-back" href="/settings/bundles"
        ><Icon name="arrow-left" size={16} /> Back to bundles</a
      >{/if}
    <section
      class="settings-section bundle-section"
      class:manage-view={!!manageName}
      aria-label={manageName ? "Bundle management" : "Configured bundles"}
    >
      <div class="settings-intro" hidden={!!manageName}>
        <h2 id="configured-bundles">Configured bundles</h2>
        <p>Sources, indexed contents and Git status.</p>
      </div>
      <div class="bundle-panels" class:managing={!!manageName}>
        {#each listing?.bundles ?? [] as bundle (bundle.name)}<SettingsBundleCard
            {bundle}
            {action}
            busy={busy || loading}
            managing={manageName === bundle.name}
            hidden={!!manageName && manageName !== bundle.name}
          />{/each}{#if manageName && listing && !listing.bundles.some((bundle) => bundle.name === manageName)}<p
            class="notice"
          >
            This bundle is no longer registered. <a href="/settings/bundles">View configured bundles</a>.
          </p>{:else if listing && !listing.bundles.length}<p class="empty">
            No configured bundles. Register a source below.
          </p>{/if}
      </div>
    </section>
    <div hidden={!!manageName}>
      <section class="settings-section" aria-labelledby="register-bundle">
        <div class="settings-intro">
          <h2 id="register-bundle">Register a bundle</h2>
          <p>
            AKM detects the format, audits and indexes the source. Registering remote Git, npm or documentation sources
            uses the network.
          </p>
        </div>
        <form
          class="card settings-card"
          onsubmit={(event) => {
            event.preventDefault();
            void action("/bundles/add", { source, name, writable });
          }}
        >
          <div class="settings-fields">
            <div class="field">
              <label class="field-label" for="bundle-source">Source</label>
              <div class="field-control">
                <input
                  id="bundle-source"
                  bind:this={sourceInput}
                  bind:value={source}
                  required
                  placeholder="Local folder, Git source, npm package or docs URL"
                  autocomplete="off"
                /><button class="btn-secondary" type="button" onclick={browse}>Browse folders…</button>
              </div>
            </div>
            <label class="field">Name (optional)<input bind:value={name} /></label><label class="check-label"
              ><input type="checkbox" role="switch" class="switch" bind:checked={writable} /> Allow writes to a Git source</label
            >
            <p class="field-hint">
              Local folders are writable by default. Git sources are read-only unless explicitly allowed.
            </p>
          </div>
          <div class="settings-footer"><button disabled={busy}>Register bundle</button></div>
        </form>
      </section>
      {#if listing}<section class="settings-section" aria-labelledby="index-status">
          <div class="settings-intro">
            <h2 id="index-status">Index status</h2>
            <p>The searchable index across enabled bundles.</p>
          </div>
          <div class="card">
            <dl class="index-facts">
              <dt>Entries</dt>
              <dd>{listing.index.entryCount}</dd>
              <dt>Last built</dt>
              <dd>{listing.index.lastBuiltAt ? date(listing.index.lastBuiltAt) : "Never"}</dd>
              <dt>Embeddings</dt>
              <dd>
                {listing.index.embeddingCount === null
                  ? "Not measured"
                  : `${listing.index.embeddingCount} recorded`}{listing.index.embeddingCoverage === null
                  ? ""
                  : ` · ${Math.round(listing.index.embeddingCoverage * 100)}% coverage`}
              </dd>
              <dt>Semantic search</dt>
              <dd>
                {listing.index.semanticSearch
                  ? `${listing.index.semanticSearch.mode} · ${listing.index.semanticSearch.status}`
                  : "Status unavailable"}
              </dd>
            </dl>
            {#if listing.index.unavailable}<p class="notice notice-warn">
                Index unavailable: {typeof listing.index.unavailable === "string"
                  ? listing.index.unavailable
                  : JSON.stringify(listing.index.unavailable)}
              </p>{/if}{#if listing.index.unreadable}<p class="notice notice-warn">
                Index unreadable: {typeof listing.index.unreadable === "string"
                  ? listing.index.unreadable
                  : JSON.stringify(listing.index.unreadable)}
              </p>{/if}
            <table>
              <caption>Indexed asset types</caption><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody
                >{#each Object.entries(listing.index.byType) as [type, count]}<tr><th>{type}</th><td>{count}</td></tr
                  >{/each}</tbody
              >
            </table>
          </div>
        </section>{/if}
    </div>
  {:else if config}
    <div class="configuration-workspace">
      <aside class="configuration-navigation">
        <nav aria-label="Configuration sections">
          {#each groups as group}<a
              href={`/settings/config?section=${group.id}`}
              aria-current={selectedGroup === group.id ? "page" : undefined}
              >{group.title}{#if editCounts[group.id]}<span aria-label="Unsaved changes">•</span>{/if}</a
            >{/each}<a
            href="/settings/config?section=embedding-settings"
            aria-current={selectedGroup === "embedding-settings" ? "page" : undefined}>Embeddings</a
          ><a
            href="/settings/config?section=advanced-settings"
            aria-current={selectedGroup === "advanced-settings" ? "page" : undefined}>Advanced</a
          >
        </nav>
        <label class="configuration-select"
          >Settings section<select
            value={selectedGroup}
            onchange={(event) => navigate(`/settings/config?section=${event.currentTarget.value}`)}
            >{#each groups as group}<option value={group.id}>{group.title}</option>{/each}<option
              value="embedding-settings">Embeddings</option
            ><option value="advanced-settings">Advanced</option></select
          ></label
        >
      </aside>
      <div class="configuration-content">
        <p class="config-location muted small">Local settings · <span class="mono wrap">{config.path}</span></p>
        {#if !config.exists}<p class="notice">No config file exists yet. Saving creates one.</p>{/if}
        {#each groups as group (group.id)}<section
            class="settings-section configuration-group"
            aria-labelledby={group.id}
            hidden={selectedGroup !== group.id}
          >
            <div class="settings-intro">
              <h2 id={group.id}>{group.title}</h2>
              <p>{group.description}</p>
            </div>
            <form
              class="card settings-card"
              onsubmit={(event) => {
                event.preventDefault();
                void action("/config/set", configurationChanges(group.fields, initial, drafts));
              }}
            >
              <div class="settings-fields">
                {#each group.fields as field (field.key)}<SettingsFieldControl
                    {field}
                    bind:value={drafts[field.key]}
                    source={sourceMap.get(field.key)}
                    disabled={busy || loading}
                  />{/each}
              </div>
              <div class="settings-footer">
                <span class="muted small"
                  >{editCounts[group.id] ? `${editCounts[group.id]} unsaved changes` : "No unsaved changes"}</span
                >
                <div class="btn-row">
                  <button
                    class="btn-secondary"
                    type="button"
                    disabled={busy || !editCounts[group.id]}
                    onclick={() =>
                      (drafts = {
                        ...drafts,
                        ...Object.fromEntries(group.fields.map((field) => [field.key, initial[field.key]])),
                      })}>Reset changes</button
                  ><button disabled={busy || !editCounts[group.id]}>Save {group.title.toLowerCase()}</button>
                </div>
              </div>
            </form>
          </section>{/each}
        <section
          class="settings-section configuration-group"
          aria-labelledby="embedding-settings"
          hidden={selectedGroup !== "embedding-settings"}
        >
          <div class="settings-intro">
            <h2 id="embedding-settings">Embeddings</h2>
            <p>The model that turns assets into vectors for semantic search.</p>
          </div>
          <EmbeddingSettings
            {config}
            saved={async () => {
              receipt = "Embedding settings saved.";
              await load();
            }}
          />
        </section>
        <div hidden={selectedGroup !== "advanced-settings"}>
          <section class="settings-section configuration-group" aria-labelledby="advanced-settings">
            <div class="settings-intro">
              <h2 id="advanced-settings">Advanced configuration</h2>
              <p>
                Set or unset a supported key. Objects and lists take JSON. Clearing a value removes it from config.json.
              </p>
            </div>
            <form
              class="card settings-card"
              onsubmit={(event) => {
                event.preventDefault();
                void action("/config/set", unset ? { unset: [key] } : { set: { [key]: value } });
              }}
            >
              <div class="settings-fields">
                <label class="field"
                  >Configuration key<input
                    bind:value={key}
                    required
                    list="config-keys"
                    placeholder="improve.processes.reflect.enabled"
                  /></label
                ><datalist id="config-keys"
                  >{#each config.entries as entry}<option value={entry.path}></option>{/each}</datalist
                ><label class="field"
                  >Value<input bind:value disabled={unset} placeholder="String, boolean, number or JSON" /></label
                ><label class="check-label"><input type="checkbox" bind:checked={unset} /> Unset the local value</label>
              </div>
              <div class="settings-footer"><button disabled={busy}>Apply validated configuration</button></div>
            </form>
          </section>
          <section class="effective-config">
            <h2>Effective configuration and provenance</h2>
            <p class="muted small">Read-only resolved values, grouped by top-level setting. Secrets are redacted.</p>
            {#each effectiveGroups as group}<details class="group">
                <summary>{group}</summary>
                <div class="table-wrap">
                  <table>
                    <caption>{group} effective values</caption><thead
                      ><tr><th>Key</th><th>Value</th><th>Source</th></tr></thead
                    ><tbody
                      >{#each filteredEffective.filter((entry) => entry.path.split(".")[0] === group) as entry}<tr
                          ><th class="mono wrap">{entry.path}</th><td class="mono wrap"
                            >{typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)}</td
                          ><td>{provenance(entry.source)}</td></tr
                        >{/each}</tbody
                    >
                  </table>
                </div>
              </details>{/each}
          </section>
          {#if config.harnesses.length}<details class="group">
              <summary>Configured harnesses</summary>
              <table>
                <caption>Harnesses</caption><thead><tr><th>Name</th><th>Platform</th></tr></thead><tbody
                  >{#each config.harnesses as harness}<tr
                      ><th>{harness.name}</th><td>{harness.platform ?? "Not recorded"}</td></tr
                    >{/each}</tbody
                >
              </table>
            </details>{/if}
          <details class="group">
            <summary>AKM environment ({config.env.length} variables)</summary>
            <div class="table-wrap">
              <table>
                <caption>Redacted environment overrides</caption><thead><tr><th>Name</th><th>Value</th></tr></thead
                ><tbody
                  >{#each config.env as entry}<tr
                      ><th class="mono wrap">{entry.name}</th><td class="mono wrap">{entry.value}</td></tr
                    >{/each}</tbody
                >
              </table>
            </div>
          </details>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .bundle-section {
    display: block;
  }
  .bundle-section:not(.manage-view) .settings-intro {
    margin-bottom: 20px;
  }
  .bundle-section:not(.manage-view) .settings-intro p {
    max-width: none;
    margin-top: 8px;
  }
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }
  .page-header h1 {
    margin: 0;
  }
  .page-header button {
    min-height: var(--control-height);
  }
  .bundle-back {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 20px;
    font-size: 14px;
  }
  .bundle-panels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
    gap: 20px;
    min-width: 0;
  }
  .bundle-section.manage-view {
    display: block;
    padding: 0;
    border: 0;
    margin: 0;
  }
  .bundle-panels.managing {
    display: block;
  }
  .bundle-section .settings-intro p {
    max-width: 25ch;
  }
  .configuration-workspace {
    display: grid;
    grid-template-columns: 190px minmax(0, 760px);
    justify-content: center;
    gap: 48px;
    align-items: start;
    margin-top: 28px;
  }
  .configuration-navigation {
    position: sticky;
    top: 90px;
  }
  .configuration-navigation nav {
    display: grid;
    gap: 4px;
  }
  .configuration-navigation a {
    display: flex;
    justify-content: space-between;
    text-decoration: none;
    color: var(--muted);
    padding: 10px 12px;
    border-radius: var(--radius);
    font-size: 14px;
    line-height: 1.4;
  }
  .configuration-navigation a[aria-current="page"] {
    background: var(--accent-bg);
    color: var(--accent);
    font-weight: 600;
  }
  .configuration-navigation a:hover {
    background: var(--surface-2);
  }
  .configuration-select {
    display: none;
  }
  .configuration-content {
    min-width: 0;
  }
  .config-location {
    margin: 0 0 28px;
    overflow-wrap: anywhere;
  }
  .configuration-group {
    display: block !important;
    border: 0 !important;
    padding: 0 !important;
  }
  .configuration-group[hidden] {
    display: none !important;
  }
  .configuration-group .settings-intro {
    margin-bottom: 28px;
  }
  .configuration-group .settings-card {
    border: 0;
    background: none;
    padding: 0;
  }
  .configuration-group .settings-fields {
    max-width: 560px;
    gap: 26px;
  }
  .configuration-group .settings-footer {
    margin-top: 32px;
    padding-top: 20px;
  }
  .configuration-group .settings-intro p {
    max-width: 65ch;
  }
  .settings-receipt {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 20px;
  }
  .settings-receipt ul {
    margin: 8px 0 0;
    padding-left: 20px;
    overflow-wrap: anywhere;
  }
  .settings-receipt button {
    flex: none;
  }
  @media (max-width: 850px) {
    .configuration-workspace {
      grid-template-columns: 1fr;
      gap: 24px;
    }
    .configuration-navigation {
      position: static;
    }
    .configuration-navigation nav {
      display: none;
    }
    .configuration-select {
      display: grid;
      gap: 8px;
    }
    .configuration-select select {
      width: 100%;
    }
    .configuration-group .settings-footer {
      align-items: start;
      gap: 16px;
      flex-wrap: wrap;
    }
    .settings-receipt {
      flex-wrap: wrap;
    }
  }
  .settings-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 1.25rem;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
  }
  .settings-tabs a {
    padding: 0.35rem 0;
    color: var(--muted);
    text-decoration: none;
  }
  /* Touch: every tab is at least as tall as a control. */
  @media (width < 48rem) {
    .settings-tabs a {
      display: inline-flex;
      align-items: center;
      min-block-size: var(--control-height);
    }
  }
  /* Phones: four even cells in two rows, so no tab wraps alone. */
  @media (width < 30rem) {
    .settings-tabs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2) var(--space-4);
    }
    .settings-tabs a {
      justify-self: start;
    }
  }
  .settings-tabs a.active {
    color: var(--text);
    box-shadow: 0 2px var(--accent);
  }
  .settings-section {
    min-width: 0;
  }
  .index-facts {
    display: grid;
    grid-template-columns: minmax(6rem, 0.35fr) minmax(0, 1fr);
    gap: 0.5rem 1rem;
  }
  .index-facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .index-facts dt {
    color: var(--muted);
  }
  .effective-config {
    margin-block: 2rem;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .field-control input {
    min-width: 0;
  }
  .settings-footer {
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .configuration-group .settings-fields {
    padding: 0;
    gap: 22px;
  }
  .configuration-group .settings-intro {
    margin-bottom: 24px;
  }
  .configuration-group .settings-footer {
    margin-top: 24px;
    padding: 16px 0 0;
  }
  .config-location {
    margin-bottom: 20px;
  }
</style>

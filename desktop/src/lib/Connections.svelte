<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { api, type ApiError } from "./client";
  import { navigate } from "./navigation";
  import ConnectionForm from "./ConnectionForm.svelte";
  import Icon from "./Icon.svelte";
  import { showToast } from "./state/toasts.svelte";
  import {
    connectionChange,
    connectionSummary,
    defaultStatement,
    deletionImpact,
    entryOf,
    optionsText,
    requestOptions,
    type ConnectionEntry,
    type ConnectionRow,
  } from "./connections-model";

  let { query }: { query: URLSearchParams } = $props();
  const LIST = "/settings/connections";
  const detailHref = (name: string) => `${LIST}?name=${encodeURIComponent(name)}`;

  let config = $state<{
    path: string;
    connections: ConnectionRow[];
    defaultConnection: string | null;
  } | null>(null);
  let loadError = $state(""),
    loading = $state(true),
    busy = $state(false),
    failure = $state(""),
    deleting = $state(false),
    deleteFailure = $state("");
  let dialog = $state<HTMLDialogElement>(),
    deleteTrigger: HTMLElement | null = null,
    root = $state<HTMLElement>();

  const adding = $derived(query.has("add"));
  const name = $derived(query.get("name") ?? "");
  const editing = $derived(!!name && query.has("edit"));
  const rows = $derived(config?.connections ?? []);
  const names = $derived(rows.map((row) => row.name));
  const row = $derived(rows.find((r) => r.name === name));
  const view = $derived(adding ? "add" : name ? (editing ? "edit" : "detail") : "list");

  async function load() {
    loading = true;
    loadError = "";
    try {
      config = await api("/config");
    } catch (cause) {
      loadError = (cause as Error).message;
    } finally {
      loading = false;
    }
  }
  onMount(load);
  // In-section moves (list, detail, form) put keyboard focus on the new heading.
  $effect(() => {
    void view;
    void name;
    void loading;
    if (!loading)
      untrack(
        () => void tick().then(() => root?.querySelector<HTMLElement>("h2.conn-title")?.focus({ preventScroll: true })),
      );
  });

  async function save(connection: string, entry: ConnectionEntry) {
    busy = true;
    failure = "";
    const creating = adding;
    try {
      const result = await api<{ saved?: boolean }>("/config/set", {}, connectionChange(connection, entry));
      await load();
      showToast(
        result.saved === false
          ? { kind: "info", title: "No changes to save." }
          : {
              title: `${creating ? "Added" : "Saved"} connection “${connection}”`,
              detail: "Saving does not test the connection.",
            },
      );
      await navigate(detailHref(connection), true);
    } catch (cause) {
      failure = (cause as ApiError).message;
    } finally {
      busy = false;
    }
  }
  function askDelete(event: Event) {
    deleteTrigger = event.currentTarget as HTMLElement;
    deleteFailure = "";
    dialog?.showModal();
  }
  function closeDialog() {
    dialog?.close();
    deleteTrigger?.focus();
  }
  async function confirmDelete() {
    if (!row) return;
    const removed = row.name;
    deleting = true;
    deleteFailure = "";
    try {
      const result = await api<{ references: string[] }>("/config/connections/remove", {}, { name: removed });
      dialog?.close();
      await load();
      showToast(
        result.references.length
          ? {
              kind: "warning",
              title: `Deleted connection “${removed}”`,
              detail: `${result.references.length} settings still name it: ${result.references.join(", ")}.`,
              action: { label: "Open Advanced", run: () => navigate("/settings/config?section=advanced-settings") },
            }
          : { title: `Deleted connection “${removed}”` },
      );
      await navigate(LIST, true);
    } catch (cause) {
      deleteFailure = (cause as Error).message;
    } finally {
      deleting = false;
    }
  }
  const status = $derived(defaultStatement(names, config?.defaultConnection ?? null));
  const impact = $derived(row ? deletionImpact(row, names, config?.defaultConnection ?? null) : null);
  const provenanceOf = (r: ConnectionRow) => (r.inherited ? "Inherited" : "This computer");
  const number = (value: unknown, fallback: string, unit = "") =>
    typeof value === "number" ? `${value.toLocaleString("en-US")}${unit}` : fallback;
</script>

<div class="connections" bind:this={root}>
  {#if loading && !config}<p role="status">Loading connections…</p>
  {:else if loadError && !config}<div class="notice notice-fail" role="alert">
      Connections could not load: {loadError} <button class="btn-secondary" onclick={load}>Retry</button>
    </div>
  {:else if view === "add"}
    <h2 class="conn-title" tabindex="-1">Add a connection</h2>
    <ConnectionForm
      name=""
      original={null}
      existing={names}
      inherited={false}
      {busy}
      {failure}
      cancelHref={LIST}
      {save}
    />
  {:else if view === "edit" && row}
    <h2 class="conn-title" tabindex="-1">Edit {row.name}</h2>
    {#key row.name}<ConnectionForm
        name={row.name}
        original={entryOf(row)}
        existing={names}
        inherited={!!row.inherited}
        {busy}
        {failure}
        cancelHref={detailHref(row.name)}
        {save}
      />{/key}
  {:else if view === "detail" && row}
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href={LIST}>Connections</a> › <span aria-current="page">{row.name}</span>
    </nav>
    <div class="conn-head">
      <h2 class="conn-title" tabindex="-1">{row.name}</h2>
      {#if config?.defaultConnection === row.name}<span class="badge accent">Default</span>{/if}
      <span class="badge">{provenanceOf(row)}</span>
      <div class="btn-row conn-actions">
        <a class="btn btn-secondary" href={`${detailHref(row.name)}&edit`}><Icon name="edit" size={16} /> Edit</a>
        {#if !row.inherited}<button class="btn-secondary danger" onclick={askDelete}>Delete…</button>{/if}
      </div>
    </div>
    {#if row.inherited}<p class="muted small">Inherited from {config?.path}. Delete it there.</p>{/if}
    <dl class="kv conn-facts">
      <dt>Endpoint</dt>
      <dd class="mono wrap">{row.endpoint ?? "Not set"}</dd>
      <dt>API key</dt>
      <dd>
        {#if row.apiKey}<span class="mono">{row.apiKey}</span>
          <span class="muted">(environment variable reference)</span>{:else}No key{/if}
      </dd>
      <dt>Models</dt>
      <dd>
        {#if Object.keys(row.models ?? {}).length}<table class="models-table">
            <thead><tr><th>Alias</th><th>Model</th><th>Request options</th></tr></thead>
            <tbody>
              {#each Object.entries(row.models ?? {}) as [alias, value]}<tr>
                  <th scope="row">{alias}</th>
                  <td class="mono wrap">{typeof value === "string" ? value : value.model}</td>
                  <td class="mono wrap"
                    >{typeof value === "string"
                      ? "—"
                      : optionsText(Object.fromEntries(Object.entries(value).filter(([k]) => k !== "model"))) ||
                        "—"}</td
                  >
                </tr>{/each}
            </tbody>
          </table>{:else}None{/if}
      </dd>
      <dt>Context length</dt>
      <dd>{number(row.contextLength, "Not set", " tokens")}</dd>
      <dt>Timeout</dt>
      <dd>{row.timeoutMs === null ? "No timeout" : number(row.timeoutMs, "AKM default", " ms")}</dd>
      <dt>Concurrency</dt>
      <dd>{number(row.concurrency, "Not set")}</dd>
      <dt>Request options</dt>
      <dd class="mono wrap">
        {Object.keys(requestOptions(entryOf(row))).length ? optionsText(requestOptions(entryOf(row))) : "None"}
      </dd>
      <dt>Used by</dt>
      <dd class="mono wrap">
        {#if (row.usedBy?.length ?? 0) || config?.defaultConnection === row.name}{[
            ...(row.usedBy ?? []),
            ...(config?.defaultConnection === row.name ? ["model work (default connection)"] : []),
          ].join(" · ")}{:else}<span class="sans">Nothing names this connection.</span>{/if}
      </dd>
      <dt>Source</dt>
      <dd class="mono wrap">{config?.path}</dd>
    </dl>
    <p class="muted small">Saving or viewing a connection does not test it.</p>
    <dialog
      class="leave-editor-dialog"
      bind:this={dialog}
      aria-labelledby="delete-title"
      oncancel={() => deleteTrigger?.focus()}
    >
      <h2 id="delete-title">Delete connection “{row.name}”?</h2>
      <p>Removes it from this computer's config.json. Other settings are not changed.</p>
      {#if impact?.references.length}<p>These settings name it and will stop working until you change them:</p>
        <ul class="mono">
          {#each impact.references as key}<li>{key}</li>{/each}
        </ul>{:else}<p>Nothing names this connection.</p>{/if}
      {#if impact?.defaultLine}<p>{impact.defaultLine}</p>{/if}
      {#if deleteFailure}<p class="notice notice-fail" role="alert">
          <strong>The connection was not deleted.</strong>
          {deleteFailure}
        </p>{/if}
      <div class="btn-row dialog-actions">
        <button class="btn-secondary" disabled={deleting} onclick={closeDialog}>Cancel</button><button
          class="btn-danger"
          disabled={deleting}
          onclick={confirmDelete}
          >{#if deleting}<span class="spinner" aria-hidden="true"></span> Deleting…{:else}Delete connection{/if}</button
        >
      </div>
    </dialog>
  {:else if name}
    <div class="state">
      <h2 class="conn-title" tabindex="-1">Connection not found</h2>
      <p>No connection named “{name}” is configured. It may have been deleted.</p>
      <a class="btn" href={LIST}>View connections</a>
    </div>
  {:else}
    <div class="conn-head">
      <h2 class="conn-title" tabindex="-1">Connections</h2>
      <a class="btn conn-actions" href={`${LIST}?add`}><Icon name="plus" size={16} /> Add connection</a>
    </div>
    <p class="muted">OpenAI-compatible endpoints akm sends its model work to.</p>
    {#if status.kind === "named"}<p>Default connection: <strong>default</strong> (named “default”).</p>
    {:else if status.kind === "only"}<p>Default connection: <strong>{status.name}</strong> (the only connection).</p>
    {:else if status.kind === "ambiguous"}<p class="notice notice-warn">
        No default connection. With more than one connection, akm uses the one named “default”. Model work without a
        named connection runs on the default harness, if one is set.
      </p>{/if}
    {#if !rows.length}<div class="state">
        <h2>No connections</h2>
        <p>A connection is an OpenAI-compatible endpoint akm uses for model work such as improve and index passes.</p>
        <a class="btn" href={`${LIST}?add`}>Add connection</a>
      </div>{:else}<ul class="conn-list">
        {#each rows as r (r.name)}<li>
            <a href={detailHref(r.name)}>
              <span class="row-main"
                ><strong>{r.name}</strong>{#if config?.defaultConnection === r.name}<span class="badge accent"
                    >Default</span
                  >{/if}<span class="muted small provenance">{provenanceOf(r)}</span></span
              >
              <span class="mono small endpoint" title={r.endpoint}>{r.endpoint ?? "No endpoint"}</span>
              <span class="muted small">{connectionSummary(r)}</span>
            </a>
          </li>{/each}
      </ul>{/if}
  {/if}
</div>

<style>
  .connections {
    max-width: 56rem;
  }
  .conn-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    margin-block: var(--space-3);
  }
  .conn-title {
    margin: 0;
    font-size: var(--text-xl);
    scroll-margin-top: calc(var(--top-inset) + 8px);
  }
  .conn-actions {
    margin-inline-start: auto;
  }
  .conn-list {
    list-style: none;
    margin: var(--space-4) 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .conn-list li + li {
    border-top: 1px solid var(--border);
  }
  .conn-list a {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    color: inherit;
    text-decoration: none;
    background: var(--surface);
  }
  .conn-list a:hover {
    background: var(--surface-2);
  }
  .conn-list a:focus-visible {
    outline: none;
    box-shadow: var(--focus-halo) inset;
  }
  .row-main {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .provenance {
    margin-inline-start: auto;
  }
  .endpoint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge.accent {
    background: var(--accent-bg);
    color: var(--accent);
  }
  .danger {
    color: var(--fail);
  }
  .conn-facts {
    margin-block: var(--space-4);
  }
  .models-table {
    border-collapse: collapse;
    font-size: var(--text-s);
    width: 100%;
  }
  .models-table th,
  .models-table td {
    text-align: left;
    padding: var(--space-1) var(--space-3) var(--space-1) 0;
    vertical-align: top;
  }
  .sans {
    font-family: var(--font);
  }
  .wrap {
    overflow-wrap: anywhere;
  }
  .dialog-actions {
    justify-content: flex-end;
    margin-block-start: var(--space-4);
  }
  dialog ul {
    margin-block: var(--space-2);
    padding-inline-start: var(--space-5);
  }
  @media (max-width: 600px) {
    .conn-facts :global(dt) {
      display: block;
    }
    .models-table thead {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
    }
    .models-table tr {
      display: block;
      margin-block-end: var(--space-2);
    }
    .models-table th,
    .models-table td {
      display: block;
    }
    .models-table th {
      font-weight: 600;
    }
  }
</style>

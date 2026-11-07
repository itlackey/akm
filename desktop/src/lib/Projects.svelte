<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, tick } from "svelte";
  import { api, type ApiError } from "./client";
  import { navigate } from "./navigation";
  import LibraryAsset from "./LibraryAsset.svelte";
  import ProjectAssets from "./ProjectAssets.svelte";
  import ProjectForm from "./ProjectForm.svelte";
  import ProjectList from "./ProjectList.svelte";
  import ProjectOverview from "./ProjectOverview.svelte";
  import { projectRows, type ProjectEntry, type ProjectRow, type projectChange } from "./projects-model";
  import { refreshBundles, workspace } from "./state/workspace.svelte";
  import { showToast } from "./state/toasts.svelte";

  let { name = "", sub = "", query }: { name?: string; sub?: string; query: URLSearchParams } = $props();

  let config = $state<{
    path: string;
    config: { projects?: Record<string, ProjectEntry>; defaultWriteTarget?: string };
    localProjects?: string[];
    projectWarnings?: string[];
    automaticWriteTarget?: { name: string } | null;
  } | null>(null);
  let loadError = $state(""),
    loading = $state(true),
    busy = $state(false),
    failure = $state(""),
    root = $state<HTMLElement>();

  const rows = $derived(projectRows(config?.config.projects, config?.localProjects ?? []));
  const row = $derived<ProjectRow | undefined>(rows.find((r) => r.name === name));
  const adding = $derived(!name && query.has("add"));
  const defaultTarget = $derived(config?.config.defaultWriteTarget || config?.automaticWriteTarget?.name || "");
  const bundleNames = $derived(workspace.bundles.map((b) => b.name));
  const view = $derived(adding ? "add" : !name ? "list" : !row ? "missing" : sub || "overview");
  const enc = encodeURIComponent;

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
  onMount(() => {
    void load();
    void refreshBundles(true).catch(() => {});
  });
  // Moving between list, overview, assets and form puts keyboard focus on the new heading.
  $effect(() => {
    void view;
    void name;
    if (!loading) void tick().then(() => root?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true }));
  });

  async function write(body: ReturnType<typeof projectChange> | { unset: string[] }) {
    busy = true;
    failure = "";
    try {
      const result = await api<{ saved?: boolean }>("/config/projects", {}, body);
      await load();
      return result.saved !== false ? "saved" : "unchanged";
    } catch (cause) {
      failure = (cause as ApiError).message;
      return "failed";
    } finally {
      busy = false;
    }
  }
  async function save(body: ReturnType<typeof projectChange>, saved: string) {
    const old = row?.name;
    const outcome = await write(body);
    if (outcome === "failed") return;
    showToast(
      outcome === "unchanged"
        ? { kind: "info", title: "No changes to save." }
        : {
            title: adding
              ? `Added project “${saved}”`
              : old && old !== saved
                ? `Renamed project “${old}” to “${saved}”`
                : `Saved project “${saved}”`,
          },
    );
    await navigate(`/projects/${enc(saved)}`, true);
  }
  async function remove() {
    if (!row) return;
    const removed = row.name;
    if ((await write({ unset: [removed] })) === "failed") return;
    showToast({ title: `Removed project “${removed}”`, detail: "Its bundles and assets are unchanged." });
    await navigate("/projects", true);
  }
  const returnTo = $derived(query.get("returnTo") || `/projects/${enc(name)}/assets`);
  const assetRef = $derived(query.get("ref") ?? "");
  const assetBundle = $derived(
    new URLSearchParams(returnTo.split("?")[1] ?? "").get("bundle") ||
      (assetRef.includes("//") ? assetRef.split("//")[0] : ""),
  );
</script>

<div class="projects" bind:this={root}>
  {#if loading && !config}<p role="status">Loading projects…</p>
  {:else if loadError && !config}<div class="notice notice-fail" role="alert">
      Projects could not load: {loadError} <button class="btn-secondary" onclick={load}>Retry</button>
    </div>
  {:else if view === "list"}
    <ProjectList projects={rows} warnings={config?.projectWarnings ?? []} configPath={config?.path ?? ""} />
  {:else if view === "add"}
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/projects">Projects</a> › <span aria-current="page">Add</span>
    </nav>
    <h1 tabindex="-1">Add a project</h1>
    <ProjectForm
      original={null}
      bundles={bundleNames}
      existing={rows.map((r) => r.name)}
      {defaultTarget}
      {busy}
      {failure}
      cancelHref="/projects"
      save={(body, saved) => save(body, saved)}
      remove={() => {}}
    />
  {:else if view === "missing"}
    <div class="state">
      <h1 tabindex="-1">Project not found</h1>
      <p>No project named “{name}” is configured. It may have been renamed or removed.</p>
      <a class="btn" href="/projects">View projects</a>
    </div>
  {:else if row && view === "edit"}
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/projects">Projects</a> › <a href={`/projects/${enc(row.name)}`}>{row.name}</a> ›
      <span aria-current="page">Edit</span>
    </nav>
    <div class="head">
      <h1 tabindex="-1">Edit {row.name}</h1>
      <span class="badge">{row.inherited ? "Inherited" : "Local"}</span>
    </div>
    {#key row.name}<ProjectForm
        original={row}
        bundles={bundleNames}
        existing={rows.map((r) => r.name)}
        {defaultTarget}
        {busy}
        {failure}
        cancelHref={`/projects/${enc(row.name)}`}
        save={(body, saved) => save(body, saved)}
        {remove}
      />{/key}
  {:else if row && view === "assets"}
    {#key row.name + "|" + query}<ProjectAssets {row} {query} />{/key}
  {:else if row && view === "asset"}
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/projects">Projects</a> › <a href={`/projects/${enc(row.name)}`}>{row.name}</a> ›
      {#if assetBundle}<a href={returnTo}>{assetBundle}</a>{:else}<a href={returnTo}>All read bundles</a>{/if} ›
      <span aria-current="page">{assetRef.split("/").pop()}</span>
    </nav>
    <p class="muted small">Reading in project {row.name}.</p>
    {#key assetRef}<LibraryAsset
        ref={assetRef}
        query={new URLSearchParams()}
        {returnTo}
        bundles={workspace.bundles}
        defaultWriteTarget={workspace.defaultWriteTarget}
        mode="search"
      />{/key}
  {:else if row}
    <ProjectOverview {row} bundles={workspace.bundles} />
  {/if}
</div>

<style>
  .projects {
    max-width: 82rem;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  h1 {
    scroll-margin-top: calc(var(--top-inset) + 8px);
  }
</style>

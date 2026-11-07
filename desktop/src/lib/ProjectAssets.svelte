<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { api, title } from "./client";
  import { navigate } from "./navigation";
  import { scopeText, type Overview, type ProjectRow } from "./projects-model";
  import type { SearchResult } from "./library-model";

  let { row, query }: { row: ProjectRow; query: URLSearchParams } = $props();
  const PAGE = 50;
  const MAX = 200;
  const name = $derived(row.name);
  const base = $derived(`/projects/${encodeURIComponent(name)}`);
  const bundle = $derived(query.get("bundle") ?? "");
  const type = $derived(query.get("type") ?? "");
  const q = $derived(query.get("q") ?? "");
  const limit = $derived(Math.min(MAX, Math.max(PAGE, Number(query.get("limit")) || PAGE)));

  let overview = $state<Overview | null>(null),
    result = $state<SearchResult | null>(null),
    error = $state(""),
    loading = $state(true),
    root = $state<HTMLElement>(),
    search = $state("");
  let generation = 0,
    previousShown = 0;

  onMount(async () => {
    try {
      overview = await api<Overview>("/projects/overview", { project: name });
    } catch (cause) {
      error = (cause as Error).message;
    }
  });
  $effect(() => {
    const params = { q, type, bundle, limit: String(limit) };
    search = q;
    untrack(() => void run(params));
  });
  async function run(params: { q: string; type: string; bundle: string; limit: string }) {
    const mine = ++generation;
    loading = true;
    error = "";
    try {
      const next = await api<SearchResult>("/search", { ...params, project: name });
      if (mine !== generation) return;
      result = next;
      const first = previousShown;
      previousShown = next.hits.length;
      if (first > 0 && next.hits.length > first) {
        await tick();
        root?.querySelectorAll<HTMLElement>(".asset-row a")[first]?.focus();
      }
    } catch (cause) {
      if (mine === generation) error = (cause as Error).message;
    } finally {
      if (mine === generation) loading = false;
    }
  }
  const href = (changes: Record<string, string>) => {
    const params = new URLSearchParams(query);
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    if (!("limit" in changes)) params.delete("limit");
    return `${base}/assets${params.size ? `?${params}` : ""}`;
  };
  const here = $derived(`${base}/assets${query.size ? `?${query}` : ""}`);
  const readable = $derived((overview?.bundles ?? []).filter((b) => b.configured && b.enabled && b.readable));
  const selected = $derived(bundle ? readable.filter((b) => b.name === bundle) : readable);
  const eligible = $derived(selected.reduce((sum, b) => sum + (b.eligible?.count ?? 0), 0));
  const total = $derived(selected.reduce((sum, b) => sum + (b.total?.count ?? 0), 0));
  const types = $derived([...new Set(selected.flatMap((b) => Object.keys(b.total?.byType ?? {})))].sort());
  const filtersText = $derived(
    scopeText(row.entry.filters)
      .map((f) => `${f.key} = ${f.values.map((v) => v || `(no ${f.key})`).join(", ")}`)
      .join(" · "),
  );
  const preferText = $derived(
    Object.keys(row.entry.prefer ?? {}).length
      ? scopeText(row.entry.prefer)
          .map((f) => `${f.key} = ${f.values.join(", ")}`)
          .join(" · ")
      : `project = ${name}`,
  );
  const n = (v: number) => v.toLocaleString("en-US");
  const hits = $derived(result?.hits ?? []);
  const searching = $derived(!!q || !!type);
</script>

<nav class="crumbs" aria-label="Breadcrumb">
  <a href="/projects">Projects</a> › <a href={base}>{name}</a> ›
  {#if bundle}<a href={`${base}/assets`}>{bundle}</a>{:else}<span aria-current="page">All read bundles</span>{/if}
</nav>
<div class="head" bind:this={root}>
  <h1 id="assets-title" tabindex="-1">Assets in {bundle || name}</h1>
  {#if overview}<p class="count"><strong>{n(eligible)}</strong> eligible of <strong>{n(total)}</strong> indexed</p>{/if}
</div>
<p class="muted small context">
  {filtersText ? `Filtered by ${filtersText}.` : "No filters."} Ranked by {preferText}.
  <a href={`${base}/edit`}>Edit project</a>
</p>
<div class="controls">
  <nav class="chips" aria-label="Bundles">
    <a class="chip" href={href({ bundle: "" })} aria-current={!bundle ? "page" : undefined}>All read bundles</a>
    {#each overview?.bundles ?? [] as b}
      {#if b.configured && b.enabled && b.readable}<a
          class="chip"
          href={href({ bundle: b.name })}
          aria-current={bundle === b.name ? "page" : undefined}>{b.name}</a
        >{:else}<span
          class="chip disabled"
          title={b.configured
            ? "Disabled: akm skips this bundle until it is enabled."
            : "Not registered: akm skips this bundle until it is registered."}>{b.name}</span
        >{/if}
    {/each}
  </nav>
  <label class="type"
    >Type<select value={type} onchange={(e) => navigate(href({ type: e.currentTarget.value }))}
      ><option value="">Any type</option>{#each types as t}<option value={t}>{t}</option>{/each}</select
    ></label
  >
  <form
    class="search"
    onsubmit={(event) => {
      event.preventDefault();
      void navigate(href({ q: search.trim() }));
    }}
  >
    <label class="sr-only" for="project-search">Search these assets</label>
    <input id="project-search" type="search" bind:value={search} placeholder="Search these assets…" />
  </form>
</div>
{#if error}<div class="notice notice-fail" role="alert">Assets could not load: {error}</div>{/if}
{#if overview && !readable.length}<div class="state">
    <h2>Nothing to read</h2>
    <p>Every bundle this project reads is disabled or not registered.</p>
    <a class="btn" href="/settings/bundles">Bundles & index</a>
  </div>{:else if result && !hits.length && !loading}
  {#if searching}<div class="state">
      <h2>No matches</h2>
      <p>Try other words or clear the search.</p>
      <a class="btn" href={href({ q: "", type: "" })}>Clear search</a>
    </div>{:else}<div class="state">
      <h2>No assets match this project</h2>
      <p>The read bundles have {n(total)} assets, but none match the filters.</p>
      <a class="btn" href={`${base}/edit`}>Edit project</a>
    </div>{/if}
{:else}
  <p role="status" class="sr-only">{loading ? "Loading assets…" : `${hits.length} assets shown`}</p>
  <ul class="results" aria-busy={loading} class:dim={loading}>
    {#each hits as hit (hit.ref)}<li class="asset-row">
        <article>
          <h2>
            <a href={`${base}/asset?ref=${encodeURIComponent(hit.ref)}&returnTo=${encodeURIComponent(here)}`}
              >{title(hit)}</a
            >
          </h2>
          {#if hit.description}<p>{hit.description}</p>{/if}
          <div class="muted small">
            {hit.type} · {hit.origin || (hit.ref.includes("//") ? hit.ref.split("//")[0] : "")}
          </div>
        </article>
      </li>{/each}
  </ul>
  {#if hits.length}<p class="muted small">
      {#if searching}{hits.length} {hits.length === 1 ? "match" : "matches"} from AKM.{:else}Showing {hits.length} of {n(
          eligible,
        )}.{/if}
      {#if hits.length >= limit && limit < MAX && (searching || hits.length < eligible)}<a
          class="btn btn-secondary"
          href={href({ limit: String(limit + PAGE) })}>Show {PAGE} more</a
        >{:else if hits.length >= MAX && eligible > MAX}Narrow the list with a bundle, type or search.{/if}
    </p>{/if}
{/if}

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
    margin-block: var(--space-3) var(--space-1);
  }
  h1 {
    scroll-margin-top: calc(var(--top-inset) + 8px);
    margin: 0;
  }
  .count,
  .context {
    margin: 0;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-block: var(--space-3);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    flex: 1 1 auto;
  }
  .chip {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    font-size: var(--text-s);
  }
  .chip[aria-current="page"] {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: var(--accent);
  }
  .chip.disabled {
    color: var(--faint);
    background: var(--surface-2);
  }
  .type {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-s);
  }
  .search input {
    min-width: 14rem;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .results.dim {
    opacity: 0.6;
  }
  .asset-row {
    padding: var(--space-3) var(--space-4);
  }
  .asset-row + .asset-row {
    border-top: 1px solid var(--border);
  }
  .asset-row h2 {
    margin: 0;
    font-size: var(--text-m);
  }
  .asset-row p {
    margin: var(--space-1) 0;
    font-size: var(--text-s);
  }
</style>

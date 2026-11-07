<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./client";
  import Icon from "./Icon.svelte";
  import { scopeText, type BundleCount, type Overview, type ProjectRow } from "./projects-model";
  import type { Bundle } from "./types";

  let { row, bundles }: { row: ProjectRow; bundles: Bundle[] } = $props();
  const base = $derived(`/projects/${encodeURIComponent(row.name)}`);
  let overview = $state<Overview | null>(null),
    error = $state("");

  async function load() {
    error = "";
    try {
      overview = await api<Overview>("/projects/overview", { project: row.name });
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
  onMount(load);

  const entry = $derived(row.entry);
  const providers: Record<string, string> = {
    filesystem: "Local",
    path: "Local",
    git: "Git",
    npm: "npm",
    website: "Website",
  };
  const provider = (name: string) => {
    const kind = bundles.find((b) => b.name === name)?.kind ?? "";
    return providers[kind] ?? (kind ? kind[0]!.toUpperCase() + kind.slice(1) : "Local");
  };
  const topTypes = (counts: BundleCount | null) => {
    const all = Object.entries(counts?.byType ?? {}).sort((a, b) => b[1] - a[1]);
    return {
      text:
        all
          .slice(0, 3)
          .map(([t, n]) => `${t} ${n}`)
          .join(" · ") + (all.length > 3 ? ` · +${all.length - 3}` : ""),
      full: all.map(([t, n]) => `${t} ${n}`).join(", "),
    };
  };
  const n = (value: number) => value.toLocaleString("en-US");
  const metadata = $derived(overview?.project.write.metadata ?? {});
  const explicitMetadata = $derived(entry.write?.metadata?.project !== undefined);
</script>

<nav class="crumbs" aria-label="Breadcrumb">
  <a href="/projects">Projects</a> › <span aria-current="page">{row.name}</span>
</nav>
<div class="head">
  <h1 tabindex="-1" id="project-title">{row.name}</h1>
  <span class="badge">{row.inherited ? "Inherited" : "Local"}</span>
  <div class="btn-row actions">
    <a class="btn btn-secondary" href={`${base}/edit`}><Icon name="edit" size={16} /> Edit project</a>
    <a class="btn" href={`${base}/assets`}>Browse assets</a>
  </div>
</div>

{#if error}<div class="notice notice-fail" role="alert">
    The overview could not load: {error} <button class="btn-secondary" onclick={load}>Retry</button>
  </div>{/if}

<section aria-labelledby="applies">
  <h2 id="applies">Applies in</h2>
  {#if entry.paths?.length}<ul class="paths mono">
      {#each entry.paths as path}<li>{path}</li>{/each}
    </ul>
    <p class="muted small">The most specific matching directory wins.</p>{:else}<p class="muted">
      No directories. The project applies only when selected with --project.
    </p>{/if}
</section>

<section aria-labelledby="reads">
  <div class="section-head">
    <h2 id="reads">Reads</h2>
    {#if overview}{#if overview.fromImplicit}<span class="muted small"
          >Default: all enabled bundles <span class="badge">Default</span></span
        >{:else}<span class="muted small"
          >Set by this project: {overview.bundles.length} {overview.bundles.length === 1 ? "bundle" : "bundles"}</span
        >{/if}{/if}
  </div>
  {#if !overview && !error}<p role="status" class="muted">Loading…</p>{/if}
  <div class="bundle-grid">
    {#each overview?.bundles ?? [] as bundle (bundle.name)}
      {@const total = bundle.total?.count ?? 0}
      {@const types = topTypes(bundle.total)}
      <article class="card bundle-card">
        <header>
          <h3>{bundle.name}</h3>
          {#if overview?.writeBundle.name === bundle.name}<span class="badge accent">Writes here</span>{/if}
          {#if !bundle.configured}<span class="badge" data-tone="warn">Not registered</span>{/if}
        </header>
        {#if !bundle.configured}
          <p class="small">akm skips this bundle until it is registered.</p>
          <a class="small" href="/settings/bundles">Bundles & index →</a>
        {:else if !bundle.enabled}
          <p class="small muted">
            {provider(bundle.name)} · <span class="warn">Disabled</span> · {bundle.writable ? "Writable" : "Read-only"}
          </p>
          <p class="small">Disabled. akm skips this bundle until it is enabled.</p>
          <a class="small" href={`/settings/bundles?manage=${encodeURIComponent(bundle.name)}`}>Bundles & index →</a>
        {:else}
          <p class="small muted">
            {provider(bundle.name)} · Enabled · {bundle.writable ? "Writable" : "Read-only"}
          </p>
          {#if bundle.total && bundle.eligible}
            <p class="small">
              <strong>{n(total)}</strong> indexed · <strong>{n(bundle.eligible.count)}</strong> eligible
            </p>
            {#if total > 0 && bundle.eligible.count === 0}<p class="small muted">
                {total === 1
                  ? "Its only asset doesn't match this project's filters."
                  : `None of its ${n(total)} assets match this project's filters.`}
              </p>{/if}
          {:else}<p class="small">
              {n(bundles.find((b) => b.name === bundle.name)?.itemCount ?? 0)} indexed · eligible not counted
            </p>{/if}
          {#if types.text}<p class="small muted" title={types.full}>{types.text}</p>{/if}
          {#if (bundle.eligible?.count ?? total) > 0}<a
              class="small"
              href={`${base}/assets?bundle=${encodeURIComponent(bundle.name)}`}
              >Browse {n(bundle.eligible?.count ?? total)}
              {(bundle.eligible?.count ?? total) === 1 ? "asset" : "assets"} →</a
            >{:else}<p class="small muted">No eligible assets</p>{/if}
        {/if}
      </article>
    {:else}{#if overview}<p class="muted">No bundles are available to read.</p>{/if}{/each}
  </div>
</section>

<div class="two">
  <section aria-labelledby="filters">
    <h2 id="filters">Selection filters</h2>
    {#if entry.filters && Object.keys(entry.filters).length}<dl class="kv">
        {#each scopeText(entry.filters) as f}<dt>{f.key}</dt>
          <dd>
            {#each f.values as value}<span class="chip">{value === "" ? `(no ${f.key})` : value}</span>{/each}
          </dd>{/each}
      </dl>
      <p class="muted small">
        An asset is eligible when it matches every key (any listed value within a key).
      </p>{:else}<p class="muted">No filters. Every asset in the read bundles is eligible.</p>{/if}
  </section>
  <section aria-labelledby="prefer">
    <h2 id="prefer">Ranking preference</h2>
    {#if entry.prefer && Object.keys(entry.prefer).length}<dl class="kv">
        {#each scopeText(entry.prefer) as f}<dt>{f.key}</dt>
          <dd>
            {#each f.values as value}<span class="chip">{value === "" ? `(no ${f.key})` : value}</span>{/each}
          </dd>{/each}
      </dl>{:else}<dl class="kv">
        <dt>project</dt>
        <dd><span class="chip">{row.name}</span> <span class="badge">Default</span></dd>
      </dl>
      <p class="muted small">Without a preference of its own, assets marked project={row.name} rank first.</p>{/if}
    <p class="muted small">Ranks matching assets first. It does not change which assets are eligible.</p>
  </section>
</div>

<section aria-labelledby="writes">
  <h2 id="writes">Writes</h2>
  <dl class="kv">
    <dt>Bundle</dt>
    <dd>
      {#if overview?.writeBundle.name}<span class="mono">{overview.writeBundle.name}</span
        >{" "}{#if overview.writeBundle.implicit}— the default write target <span class="badge">Default</span
          >{:else}<span class="muted">(set by this project)</span>{/if}{:else if overview}No write target is available.{:else}…{/if}
    </dd>
    <dt>User · Agent · Channel</dt>
    <dd>
      {#if !entry.write?.user && !entry.write?.agent && !entry.write?.channel}Not set{:else}{entry.write?.user ?? "—"} · {entry
          .write?.agent ?? "—"} · {entry.write?.channel ?? "—"}{/if}
    </dd>
    <dt>Metadata</dt>
    <dd>
      {#each Object.entries(overview ? metadata : (entry.write?.metadata ?? {})) as [key, value]}<span class="chip"
          >{key}: {String(value)}</span
        >{#if key === "project" && overview && !explicitMetadata}{" "}<span class="badge">Default</span
          >{" "}{/if}{/each}
    </dd>
  </dl>
  {#if overview?.writeBundle.name && overview.writeBundle.usable === false}<p class="notice notice-warn">
      {overview.writeBundle.name} cannot accept writes (disabled or read-only). New memories and proposals here will fail.
    </p>{/if}
</section>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    margin-block: var(--space-3);
  }
  h1 {
    scroll-margin-top: calc(var(--top-inset) + 8px);
  }
  .actions {
    margin-inline-start: auto;
  }
  .paths {
    list-style: none;
    margin: 0 0 var(--space-1);
    padding: 0;
    overflow-wrap: anywhere;
  }
  @media (width < 48rem) {
    .actions {
      width: 100%;
    }
    .actions :global(.btn) {
      flex: 1;
      justify-content: center;
    }
  }
  section {
    margin-block: var(--space-5);
  }
  h2 {
    font-size: var(--text-l);
    margin: 0 0 var(--space-2);
  }
  .section-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .bundle-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
    gap: var(--space-4);
    margin-block-start: var(--space-2);
  }
  .bundle-card {
    display: grid;
    gap: var(--space-2);
    align-content: start;
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .bundle-card p {
    margin: 0;
  }
  .bundle-card header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .bundle-card h3 {
    margin: 0;
    font-size: var(--text-m);
    flex: 1;
  }
  .badge.accent {
    background: var(--accent-bg);
    color: var(--accent);
  }
  .warn {
    color: var(--warn);
  }
  .two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    gap: var(--space-5);
  }
  .chip {
    display: inline-block;
    margin: 0 var(--space-1) var(--space-1) 0;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    background: var(--surface-2);
    font-size: var(--text-s);
  }
</style>

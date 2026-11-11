<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy } from "svelte";
  import { libraryRead, typedLinks } from "./library-model";
  import type { Json } from "./types";
  import Icon from "./Icon.svelte";
  import AssetMap from "./AssetMap.svelte";
  let {
    ref,
    links,
    href,
    onCompare,
  }: {
    ref: string;
    links: Json | undefined;
    href: (ref: string) => string;
    /** Compare this asset with the one chosen. */
    onCompare?: (refs: string[]) => void;
  } = $props();
  let view = $state("connections"),
    withSimilar = $state(false),
    scope = $state("all"),
    loading = $state(false),
    error = $state("");
  let result = $state<{
    available: boolean;
    note?: string;
    matches: Array<{ ref: string; title: string; type: string; cosine: number }>;
  } | null>(null);
  let controller: AbortController;
  const connections = $derived(typedLinks(links));
  const kinds: Record<string, string> = {
    xref: "Cross-reference",
    superseded_by: "Superseded by",
    contradicted_by: "Contradicted by",
    belief_peer: "Related belief",
    derived_from: "Derived from",
    cites: "Citation",
    links_to: "Link",
    uses: "Uses",
  };
  const label = (value: string) => value.split("//").at(-1) ?? value;
  const kindLabel = (kind: string) => kinds[kind] ?? kind.replaceAll("_", " ");
  async function similar() {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    loading = true;
    error = "";
    result = null;
    try {
      const next = await libraryRead<NonNullable<typeof result>>("/asset/related", { ref, scope }, signal);
      if (!signal.aborted) result = next;
    } catch (cause) {
      if (!signal.aborted) error = (cause as Error).message;
    } finally {
      if (!signal.aborted) loading = false;
    }
  }
  function choose(next: string) {
    view = next;
    if (next === "similar" && !result && !loading) void similar();
  }
  onDestroy(() => controller?.abort());
</script>

<div class="related-tabs" role="group" aria-label="Related asset views">
  <button
    class:active={view === "connections"}
    aria-pressed={view === "connections"}
    onclick={() => choose("connections")}>Connections</button
  >
  <button class:active={view === "map"} aria-pressed={view === "map"} onclick={() => choose("map")}>Link map</button>
  <button class:active={view === "similar"} aria-pressed={view === "similar"} onclick={() => choose("similar")}
    >Similar content</button
  >
</div>
{#if view === "connections"}
  <p class="muted small">
    Follow the links recorded by AKM. These are explicit relationships, not inferred similarity.
  </p>
  {#if !connections.length}<p class="state">No recorded connections for this asset.</p>{/if}
  {#each connections as group}
    <section class="connection-group">
      <h4>
        {group.direction === "incoming" ? "Linked from" : "Links to"}
        <span>{kindLabel(group.kind)}</span>
      </h4>
      <ul class="related-list">
        {#each group.refs as target}
          <li>
            <a href={href(target)}><strong>{label(target)}</strong><span>{target.split("//")[0]}</span></a><button
              class="btn-secondary"
              onclick={() => onCompare?.([ref, target])}>Compare</button
            >
          </li>
        {/each}
      </ul>
      {#if group.total > group.refs.length}<p class="muted small">
          Showing {group.refs.length} of {group.total} connections returned by AKM.
        </p>{/if}
    </section>
  {/each}
{:else if view === "map"}
  <div class="similar-toolbar">
    <p class="muted small">
      This asset in the middle, what links to it on the left and what it links to on the right. One step only: the links
      of the assets shown are on their own pages.
    </p>
    <label class="map-option"
      ><input
        type="checkbox"
        bind:checked={withSimilar}
        onchange={() => {
          if (withSimilar && !result && !loading) void similar();
        }}
      />Add similar content</label
    >
  </div>
  {#if withSimilar && loading}<p class="state" role="status">Finding similar content…</p>{/if}
  {#if withSimilar && error}<div class="notice notice-warn" role="alert">{error}</div>{/if}
  {#if withSimilar && result?.note}<p class="muted small">{result.note}</p>{/if}
  {#if !connections.length && !(withSimilar && result?.matches.length)}<p class="state">
      No recorded connections for this asset.
    </p>{:else}<AssetMap
      {ref}
      {connections}
      similar={withSimilar ? (result?.matches ?? []) : []}
      {kindLabel}
      {href}
    />{/if}
{:else}
  <div class="similar-toolbar">
    <p class="muted small">Compare existing embeddings. A high score suggests overlap—not proof of duplication.</p>
    <label
      >Look in<select bind:value={scope} onchange={similar}
        ><option value="all">All enabled bundles</option><option value="bundle">This bundle</option></select
      ></label
    >
  </div>
  {#if loading}<p class="state" role="status">Finding similar content…</p>
  {:else if error}<div class="notice notice-warn" role="alert">
      {error}
      <p><button class="btn-secondary" onclick={similar}>Try again</button></p>
    </div>
  {:else if result}
    {#if result.note}<p class="muted small">{result.note}</p>{/if}
    {#if result.available && !result.matches.length}<p class="state">
        No comparable embeddings found in this scope.
      </p>{/if}
    <ul class="related-list">
      {#each result.matches as match}
        <li>
          <a href={href(match.ref)}
            ><strong>{match.title}</strong><span>{match.ref.split("//")[0]} · {match.type}</span></a
          ><span class="score" title="Cosine similarity, from −1 to 1"
            >Cosine <strong>{match.cosine.toFixed(3)}</strong></span
          ><button class="btn-secondary" onclick={() => onCompare?.([ref, match.ref])}
            ><Icon name="file" size={15} />Compare</button
          >
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .related-tabs {
    display: flex;
    gap: 24px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
  }
  .related-tabs button {
    border: 0;
    border-radius: 0;
    background: none;
    color: var(--muted);
    padding: 12px 0;
    border-bottom: 2px solid transparent;
    font-weight: 600;
    min-height: 40px;
  }
  .related-tabs button.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .connection-group {
    margin: 28px 0;
  }
  .connection-group h4 {
    font-size: 14px;
    margin-bottom: 8px;
  }
  .connection-group h4 span {
    font-weight: 400;
    color: var(--muted);
    margin-left: 12px;
  }
  .related-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .related-list li {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 18px 0;
    border-bottom: 1px solid var(--border);
  }
  .related-list a {
    flex: 1;
    min-width: 0;
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .related-list a strong {
    font-size: 15px;
    font-weight: 550;
  }
  .related-list a span {
    display: block;
    color: var(--muted);
    font-size: 12px;
    margin-top: 5px;
  }
  .related-list button {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
  }
  .score {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }
  .score strong {
    font-variant-numeric: tabular-nums;
    color: var(--text);
    font-weight: 500;
  }
  .similar-toolbar {
    display: flex;
    align-items: center;
    gap: 32px;
    margin: 0 0 16px;
  }
  .similar-toolbar p {
    flex: 1;
    line-height: 1.6;
  }
  .similar-toolbar .map-option {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    white-space: nowrap;
  }
  .similar-toolbar label {
    font-size: 12px;
    color: var(--muted);
    display: grid;
    gap: 6px;
    min-width: 180px;
  }
  @media (max-width: 700px) {
    .similar-toolbar {
      align-items: stretch;
      flex-direction: column;
      gap: 12px;
    }
    .related-list li {
      flex-wrap: wrap;
      gap: 12px;
    }
    .related-list a {
      flex-basis: 100%;
    }
    .related-list .score {
      flex: 1;
    }
  }
</style>

<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount } from "svelte";
  import { api, title } from "./client";
  import Icon from "./Icon.svelte";
  import { checkPrompt, searchCount, type AgentCard } from "./setup-model";
  import type { AssetSummary } from "./types";

  let { connected }: { connected: AgentCard[] } = $props();
  const TIPS_AFTER_MS = 120_000;
  let query = $state("deploy"),
    hits = $state<AssetSummary[] | null>(null),
    searchError = $state(""),
    searching = $state(false),
    copied = $state(""),
    baseline = $state<number | null>(null),
    latest = $state<number | null>(null),
    seenAt = $state(""),
    tips = $state(false);

  const observed = $derived(baseline !== null && latest !== null && latest > baseline);

  async function search() {
    searching = true;
    searchError = "";
    try {
      hits = (await api<{ results?: AssetSummary[] }>("/search", { q: query, limit: "5" })).results ?? [];
    } catch (cause) {
      searchError = (cause as Error).message;
    } finally {
      searching = false;
    }
  }
  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = id;
    } catch {
      copied = "";
    }
  }
  /** Searches so far today. The baseline is the first reading, so a search made before this page opened is not counted. */
  async function poll() {
    try {
      latest = searchCount(await api("/retrieval", { since: "1d" }));
      baseline ??= latest;
      if (observed && !seenAt) seenAt = new Date().toLocaleTimeString();
    } catch {
      /* The next poll tries again; nothing is claimed in the meantime. */
    }
  }
  onMount(() => {
    // A sample query from what the library holds, so the first search is likely to find something.
    void api<{ results?: AssetSummary[] }>("/search", { q: "", limit: "1" })
      .then((first) => {
        const hit = first.results?.[0];
        if (hit) query = title(hit).split(/\s+/).slice(0, 2).join(" ");
      })
      .catch(() => undefined);
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    const late = setTimeout(() => (tips = true), TIPS_AFTER_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(late);
    };
  });
</script>

<section class="setup-step" id="setup-try" aria-labelledby="setup-try-title">
  <div class="step-head">
    <h2 id="setup-try-title">3. Try it</h2>
    {#if connected.length}<span class="badge" data-tone={observed ? "ok" : "info"}
        >{observed ? `✓ A search reached akm at ${seenAt}` : "Waiting for a search from an agent"}</span
      >{/if}
  </div>
  <form
    class="search"
    onsubmit={(event) => {
      event.preventDefault();
      void search();
    }}
  >
    <label class="field-label" for="setup-query">Search your library</label>
    <div class="field-control">
      <input id="setup-query" type="search" bind:value={query} autocomplete="off" />
      <button disabled={searching || !query.trim()}><Icon name="search" size={16} />Search</button>
    </div>
  </form>
  {#if searchError}<p class="notice notice-warn" role="alert">{searchError}</p>{/if}
  {#if hits}
    {#if hits.length}
      <ul class="hits" aria-label="Search results">
        {#each hits as hit}<li>
            <strong>{title(hit)}</strong> <span class="muted small mono">{hit.ref}</span>
          </li>{/each}
      </ul>
    {:else}<p class="notice" role="status">
        Nothing matched “{query}”. Search works on the words in your library, so try another word, or add the starter
        bundle in step 1.
      </p>{/if}
  {/if}

  {#if connected.length}
    <h3>Ask your agent</h3>
    <p>
      Paste one of these into a new session. akm counts the searches it receives: when the count rises, this page says
      so. It cannot tell which agent searched, so check one agent at a time.
    </p>
    {#each connected as card (card.id)}
      <div class="prompt">
        <strong>{card.name}</strong>
        <code>{checkPrompt(card.id, query)}</code>
        <button class="btn-secondary" onclick={() => copy(card.id, checkPrompt(card.id, query))}
          ><Icon name="copy" size={16} />{copied === card.id ? "Copied" : "Copy"}</button
        >
      </div>
    {/each}
    {#if observed}
      <p class="notice notice-ok" role="status">
        akm received a search from an agent or terminal ({baseline} → {latest} searches today), seen at {seenAt}.
      </p>
    {:else if tips}
      <div class="notice notice-warn" role="status">
        <p>No search has reached akm yet. Things to check:</p>
        <ul>
          <li>Restart the agent, or open a new session, so it loads the plugin.</li>
          <li>In Codex, run <code>/hooks</code> and trust the two AKM hooks.</li>
          <li>For Claude Code and Codex, make sure Bun is installed and on the PATH of the program you started.</li>
          <li>The agent's own session-start message says if akm or its library could not be found.</li>
        </ul>
      </div>
    {:else}<p class="muted small" role="status">Waiting. Nothing has been seen yet.</p>{/if}
  {:else}
    <p class="muted">Connect an agent in step 2 to check that it reaches your library.</p>
  {/if}
</section>

<style>
  .hits {
    margin: 16px 0;
    padding-inline-start: 20px;
    display: grid;
    gap: 8px;
  }
  .prompt {
    display: grid;
    grid-template-columns: 110px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    margin: 12px 0;
  }
  .prompt code {
    overflow-wrap: anywhere;
  }
  @media (max-width: 700px) {
    .prompt {
      grid-template-columns: 1fr;
    }
  }
</style>

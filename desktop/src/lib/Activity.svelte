<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { api, date } from "./client";
  import { navigate } from "./navigation";
  import ActivityOverview from "./ActivityOverview.svelte";
  import ActivityImpact from "./ActivityImpact.svelte";
  import Icon from "./Icon.svelte";
  import type {
    ActivityOverview as Overview,
    ActivityImpact as Impact,
    ActivityRetrieval as Retrieval,
    ActivityPulse as Pulse,
    ActivityHealth,
  } from "./activity-types";
  import type { Commit } from "./types";
  let { route = "overview", query = new URLSearchParams() }: { route?: string; query?: URLSearchParams } = $props();
  let overview = $state<Overview | null>(null),
    impact = $state<Impact | null>(null),
    retrieval = $state<Retrieval | null>(null),
    pulse = $state<Pulse | null>(null),
    impactProcess = $state("");
  // A latch, not a derivation: the process the address last named stays selected when a later address names none.
  $effect.pre(() => {
    if (route === "improve" && query.has("process")) impactProcess = query.get("process") ?? "";
  });
  let changes = $state<{
    bundle: string;
    path: string;
    git: boolean;
    commits: Array<Commit & { shortSha?: string }>;
  } | null>(null);
  let misses = $state<{
    searches: number;
    foundNothing: number;
    misses: Array<{ query: string; count: number; days: number; lastAt: string }>;
  } | null>(null);
  // Plain, not state: the key of the view that was last asked for.
  let loaded = "";
  let loading = $state(false),
    error = $state(""),
    generation = 0,
    probed = $state(false),
    refreshedAt = $state(""),
    probedAt = $state(""),
    historyFilter = $state(""),
    historyOrigin = $state("");
  const view = $derived(
    route === "improve"
      ? "Improve impact"
      : route === "history"
        ? "Source history"
        : query.get("view") === "runs"
          ? "Runs"
          : ["retrieval", "usage", "misses"].includes(query.get("view") ?? "")
            ? "Usage & retrieval"
            : "Health",
  );
  const window = $derived(query.get("window") === "7d" ? "7d" : query.get("window") === "90d" ? "90d" : "30d");
  const since = $derived(query.get("since") === "365d" ? "365d" : "90d");
  // In-page evidence links must not discard chart/run drill state or reload measurements.
  const key = $derived(`${route}|${view}|${window}|${since}|${route === "history" ? query.toString() : ""}`);
  // Load when the view, its window or (for history) its filters change: before the page updates, so the new view is
  // never drawn with the measurements of the one before.
  $effect.pre(() => {
    if (key === loaded) return;
    loaded = key;
    untrack(() => void load());
  });
  // An anchor in the address is opened, focused and scrolled to once its view is on screen.
  $effect(() => {
    if (!loading) void revealAnchor(query.get("anchor"));
  });
  const filteredCommits = $derived(
    (changes?.commits ?? []).filter(
      (commit) =>
        (!historyOrigin || commit.origin === historyOrigin) &&
        (!historyFilter.trim() ||
          [commit.subject, commit.author, commit.sha, commit.origin, ...(commit.paths ?? [])].some((value) =>
            String(value ?? "")
              .toLowerCase()
              .includes(historyFilter.trim().toLowerCase()),
          )),
    ),
  );
  const views = [
    { name: "Health", path: "/activity/overview" },
    { name: "Runs", path: "/activity/overview?view=runs" },
    { name: "Usage & retrieval", path: "/activity/overview?view=retrieval" },
    { name: "Improve impact", path: "/activity/improve" },
    { name: "Source history", path: "/activity/history" },
  ];
  async function revealAnchor(anchor: string | null) {
    if (!anchor) return;
    await tick();
    const target = document.getElementById(anchor);
    if (target instanceof HTMLDetailsElement) target.open = true;
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
    }
  }
  async function load() {
    const request = ++generation;
    loading = true;
    error = "";
    try {
      if (view === "Health" || view === "Runs" || view === "Usage & retrieval") {
        const [next, nextPulse, nextRetrieval] = await Promise.all([
          api<Overview>("/overview", { metricsSince: window }),
          api<Pulse>("/overview/pulse").catch(() => null),
          api<Retrieval>("/retrieval", { since: view === "Usage & retrieval" ? window : "84d" }).catch(() => null),
        ]);
        if (request === generation) {
          overview = next;
          pulse = nextPulse;
          retrieval = nextRetrieval;
          probed = false;
          refreshedAt = new Date().toISOString();
          probedAt = "";
        }
        if (view === "Usage & retrieval") {
          const nextMisses = await api<NonNullable<typeof misses>>("/search/misses", { since: window }).catch(
            () => null,
          );
          if (request === generation) misses = nextMisses;
        }
      } else if (view === "Improve impact") {
        const [next, nextRetrieval] = await Promise.all([
          api<Impact>("/improve/impact", { since }),
          api<Retrieval>("/retrieval", { since: "90d" }).catch(() => null),
        ]);
        if (request === generation) {
          impact = next;
          retrieval = nextRetrieval;
        }
      } else if (view === "Source history") {
        const next = await api<NonNullable<typeof changes>>("/changes", { limit: "100" });
        if (request === generation) {
          changes = next;
          historyFilter = query.get("q") ?? "";
          historyOrigin = query.get("origin") ?? "";
        }
      } else {
        const next = await api<NonNullable<typeof misses>>("/search/misses", { since: window });
        if (request === generation) misses = next;
      }
      await tick();
      const anchor = query.get("anchor");
      if (request === generation && anchor) {
        const target = document.getElementById(anchor);
        if (target instanceof HTMLDetailsElement) target.open = true;
        target?.scrollIntoView({ block: "start" });
      }
    } catch (cause) {
      if (request === generation) error = (cause as Error).message;
    } finally {
      if (request === generation) loading = false;
    }
  }
  async function probe() {
    const request = generation;
    error = "";
    try {
      const health = await api<ActivityHealth>("/health", { probe: "1" });
      if (request === generation && overview) {
        overview = { ...overview, health };
        probed = true;
        probedAt = new Date().toISOString();
      }
    } catch (cause) {
      if (request === generation) error = (cause as Error).message;
    }
  }
  function changeWindow(value: string) {
    const params = new URLSearchParams(query);
    params.set(route === "improve" ? "since" : "window", value);
    void navigate(`/activity/${route}?${params}`);
  }
  function filterHistory() {
    const params = new URLSearchParams();
    if (historyFilter) params.set("q", historyFilter);
    if (historyOrigin) params.set("origin", historyOrigin);
    void navigate(`/activity/history${params.size ? `?${params}` : ""}`);
  }
  onDestroy(() => {
    generation++;
  });
</script>

<nav class="activity-tabs" aria-label="Activity views">
  {#each views as tab}<a
      class:active={view === tab.name}
      aria-current={view === tab.name ? "page" : undefined}
      href={tab.path}>{tab.name}</a
    >{/each}
</nav>
<div class="page-header">
  <div>
    <h1>{view}</h1>
    {#if view === "Runs"}<p class="muted">
        Recorded execution and results. Inspection never starts a run.
      </p>{:else if view === "Usage & retrieval"}<p class="muted">
        Search behavior and model activity, not a knowledge-quality score.
      </p>{:else if view === "Improve impact"}<p class="muted">
        Decisions, subsequent use and signals that need investigation.
      </p>{/if}
  </div>
  <div class="activity-toolbar">
    {#if view !== "Source history" && view !== "Health"}<label
        >{route === "improve" ? "Impact window" : "Trend window"}<select
          value={route === "improve" ? since : window}
          onchange={(event) => changeWindow(event.currentTarget.value)}
          >{#if route === "improve"}<option value="90d">90 days</option><option value="365d">1 year</option
            >{:else}<option value="7d">7 days</option><option value="30d">30 days</option><option value="90d"
              >90 days</option
            >{/if}</select
        ></label
      >{/if}<button class="btn-quiet" onclick={load} disabled={loading}
      ><Icon name="refresh" size={16} /> Refresh activity</button
    >
  </div>
</div>
{#if error}<div class="notice notice-warn" role="alert">
    {error}<button class="btn-secondary" onclick={load}>Retry activity</button>
  </div>{/if}
{#if loading}<p role="status">
    Loading {view.toLowerCase()}…
  </p>{:else if view === "Health" || view === "Runs" || view === "Usage & retrieval"}{#if overview}{#if view !== "Health"}<p
        class="muted small"
      >
        {overview.metrics
          ? `${overview.metrics.window.since.slice(0, 16)} to ${overview.metrics.window.until.slice(0, 16)}, UTC.`
          : "Metric window unavailable."}{view === "Runs"
          ? " Improve history shows the latest records across all time."
          : " Retrieval uses the selected window."}
      </p>{/if}<ActivityOverview
      mode={view === "Health" ? "health" : view === "Runs" ? "runs" : "usage"}
      data={overview}
      {pulse}
      {retrieval}
      {probed}
      {probe}
      {refreshedAt}
      {probedAt}
      requestedTask={query.get("task") ?? ""}
    />{/if}
{:else if view === "Improve impact"}{#if impact}<ActivityImpact
      {impact}
      {retrieval}
      bind:selectedProcess={impactProcess}
    />{/if}
{:else if view === "Source history" && changes}<h2>Write-target history</h2>
  <p class="muted">{changes.bundle} · <span class="mono wrap">{changes.path}</span></p>
  {#if !changes.git}<p class="empty">
      This write target is not a Git repository. AKM does not retain general manual-edit undo for a non-Git bundle.
    </p>{:else}<form
      class="history-filter"
      role="search"
      aria-label="Filter commits"
      onsubmit={(event) => {
        event.preventDefault();
        filterHistory();
      }}
    >
      <label>Subject, author or path<input type="search" bind:value={historyFilter} /></label><label
        >Made by<select bind:value={historyOrigin}
          ><option value="">Anything</option
          >{#each [...new Set(changes.commits.map((commit) => commit.origin ?? "other"))].sort() as origin}<option
              >{origin}</option
            >{/each}</select
        ></label
      ><button>Filter history</button>
    </form>
    <ol class="commits">
      {#each filteredCommits as commit}<li class="commit">
          <div class="commit-head">
            <span>{date(commit.time)}</span><span class="badge">{commit.origin ?? "other"}</span><strong
              >{commit.subject}</strong
            >
          </div>
          <p class="muted small">
            <code>{commit.shortSha ?? commit.sha.slice(0, 8)}</code> by {commit.author ?? "Unknown author"}
          </p>
          {#if commit.pathCount || commit.paths?.length}<details>
              <summary>{commit.pathCount ?? commit.paths?.length} changed paths</summary>
              <ul>
                {#each commit.paths ?? [] as path}<li class="mono wrap">{path}</li>{/each}
              </ul>
              {#if (commit.pathCount ?? 0) > (commit.paths?.length ?? 0)}<p>
                  {(commit.pathCount ?? 0) - (commit.paths?.length ?? 0)} more paths not included in this response.
                </p>{/if}
            </details>{/if}
        </li>{/each}
    </ol>
    {#if !filteredCommits.length}<p class="empty">
        {changes.commits.length ? "No commits match these filters." : "No commits recorded yet."}
      </p>{/if}{/if}
{/if}
{#if view === "Usage & retrieval"}<section id="search-gaps" class="search-gaps" aria-labelledby="search-gaps-title">
    <h2 id="search-gaps-title">Repeated search gaps</h2>
    {#if misses}<p class="muted small">
        {misses.foundNothing} of {misses.searches} searches returned no results. Review the query and existing material before
        adding anything.
      </p>
      {#if misses.misses.length}<div class="table-wrap">
          <table>
            <caption>Repeated search misses</caption><thead
              ><tr><th>Query</th><th>Times</th><th>Days</th><th>Last seen</th><th>Next step</th></tr></thead
            ><tbody
              >{#each misses.misses as miss}<tr
                  ><th>{miss.query}</th><td>{miss.count}</td><td>{miss.days}</td><td>{date(miss.lastAt)}</td><td
                    ><a href={`/library/search?tab=misses&q=${encodeURIComponent(miss.query)}`}>Review search gap</a
                    ></td
                  ></tr
                >{/each}</tbody
            >
          </table>
        </div>{:else}<p>No search gaps recorded in this window.</p>{/if}{:else}<p class="muted">
        Search-gap measurements are unavailable.
      </p>{/if}
  </section>{/if}

<style>
  .activity-toolbar {
    display: flex;
    gap: 0.75rem;
    align-items: end;
    flex-wrap: wrap;
  }
  .activity-toolbar label {
    display: grid;
    gap: 0.35rem;
  }
  .activity-tabs {
    display: flex;
    gap: 1.75rem;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
    margin-bottom: 2rem;
  }
  .activity-tabs a {
    flex: none;
  }
  .page-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem 2rem;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
  }
  .page-header h1 {
    margin: 0;
  }
  .search-gaps {
    margin-block: 2rem;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
  }
  .search-gaps h2 {
    font-size: 1.125rem;
    font-weight: 600;
  }
  /* Phones: the five tabs wrap into rows instead of scrolling sideways, and each is as tall as a control. */
  @media (max-width: 760px) {
    .activity-tabs {
      flex-wrap: wrap;
      gap: 0 1.25rem;
      overflow-x: visible;
      margin-bottom: 1.5rem;
    }
    .activity-tabs a {
      display: inline-flex;
      align-items: center;
      min-block-size: var(--control-height);
    }
  }
  .activity-tabs a {
    color: var(--muted);
    text-decoration: none;
    padding: 0.35rem 0;
  }
  .activity-tabs a.active {
    color: var(--text);
    box-shadow: 0 2px var(--accent);
  }
  .history-filter {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.75rem;
    margin-block: 1rem;
  }
  .history-filter label {
    display: grid;
    gap: 0.35rem;
  }
  .table-wrap {
    overflow-x: auto;
  }
</style>

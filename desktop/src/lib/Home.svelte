<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount } from "svelte";
  import { api, apiState, appHref, date } from "./client";
  import BackupsPrune from "./BackupsPrune.svelte";
  import Icon from "./Icon.svelte";
  import { homeConcerns, homeCoverage, pruneSummary, taskOutcomes } from "./home-model";
  import { refreshContext, workspace } from "./state/workspace.svelte";
  import type { ActivityOverview, ActivityPulse } from "./activity-types";

  let data = $state<ActivityOverview | null>(null);
  let pulse = $state<ActivityPulse | null>(null);
  let pulseNote = $state("");
  let loading = $state(false);
  let refreshedAt = $state("");
  let error = $state("");
  let pruned = $state("");
  let generation = 0;
  let checkButton = $state<HTMLButtonElement>();

  const concerns = $derived(homeConcerns(data));
  const coverage = $derived(homeCoverage(data, pulse));
  const outcomes = $derived(taskOutcomes(data, pulse));
  const checks = $derived([...(data?.health?.hardChecks ?? []), ...(data?.health?.advisories ?? [])]);
  const passing = $derived(checks.filter((check) => check.status === "pass").length);
  const unknown = $derived(checks.filter((check) => check.status === "unknown").length);
  async function load() {
    const mine = ++generation;
    loading = true;
    error = "";
    const [overview, weekly] = await Promise.allSettled([
      api<ActivityOverview>("/overview", { metricsSince: "7d" }),
      apiState<ActivityPulse>("/overview/pulse"),
      refreshContext(),
    ]);
    if (mine !== generation) return;
    data = overview.status === "fulfilled" ? overview.value : null;
    pulse = weekly.status === "fulfilled" ? weekly.value : null;
    pulseNote = weekly.status === "rejected" && weekly.reason instanceof Error ? weekly.reason.message : "";
    if (overview.status === "rejected")
      error = overview.reason instanceof Error ? overview.reason.message : "Could not load the overview.";
    refreshedAt = new Date().toISOString();
    loading = false;
  }
  /** A retry button may be gone once the snapshot loads, so focus goes to the refresh control first, not to the page. */
  function retry() {
    if (loading) return;
    checkButton?.focus();
    void load();
  }
  onMount(() => {
    void load();
    return () => generation++;
  });
</script>

<div class="home-page" aria-busy={loading}>
  <div class="home-heading">
    <div>
      <h1>Overview</h1>
      <!-- A live region: the start and the end of a refresh are heard, not only repainted. -->
      <p class="muted small" role="status">
        {loading
          ? "Refreshing your snapshot…"
          : refreshedAt
            ? `Snapshot refreshed ${date(refreshedAt)}`
            : "Loading your snapshot…"}
      </p>
    </div>
    <!-- Busy, not disabled: a disabled button drops keyboard focus to the page. -->
    <button
      class="btn-secondary"
      bind:this={checkButton}
      aria-disabled={loading}
      onclick={() => !loading && load()}
      aria-describedby="home-probe-help"
      ><Icon name="refresh" size={16} />{loading ? "Checking…" : "Check health"}</button
    >
  </div>
  <span id="home-probe-help" class="sr-only"
    >Refreshes local diagnostics and recorded activity. Network checks are available in Health details.</span
  >
  {#if error}<div class="notice notice-fail" role="alert">
      <p>{error}</p>
      <button class="btn-secondary" aria-disabled={loading} onclick={retry}>Retry overview</button>
    </div>{/if}

  <!-- Once loaded, the snapshot stays on screen while it refreshes, so the page does not blank and focus is kept. -->
  {#if !loading || refreshedAt}
    <div class="home-columns">
      <section class="home-attention" aria-labelledby="home-attention-title">
        {#if workspace.unconfigured}
          <div class="home-setup">
            <h2 id="home-attention-title">Set up akm on this computer</h2>
            <p>
              Create your library, connect the agents you use, and check that they can reach it. It takes about two
              minutes, and nothing runs until you press a button.
            </p>
            <a class="btn" href={appHref("/setup")}>Start setup<Icon name="arrow-right" size={16} /></a>
          </div>
        {:else}
          <div class="home-section-title">
            <h2 id="home-attention-title">Needs attention</h2>
            {#if concerns.length}<span class="home-count"
                >{concerns.length}<span class="sr-only"
                  >{` ${concerns.length === 1 ? "item needs" : "items need"} attention`}</span
                ></span
              >{/if}
          </div>
          {#if pruned}<p class="home-pruned muted small" role="status">Removed {pruned}.</p>{/if}
          {#if concerns.length}
            <ul class="home-concerns">
              {#each concerns.slice(0, 4) as item}
                <li>
                  <span
                    role="img"
                    class="home-signal"
                    class:failure={item.tone === "fail"}
                    aria-label={item.tone === "fail" ? "Failure" : "Warning"}
                    ><Icon name={item.tone === "fail" ? "alert" : "warning"} size={18} /></span
                  >
                  <div class="home-concern-copy">
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                    {#if item.key === "data-dir-usage"}<BackupsPrune
                        onDone={(result) => {
                          pruned = pruneSummary(result);
                          void load();
                        }}
                      />{/if}
                  </div>
                  <a
                    href={appHref(item.href)}
                    class="home-detail-link"
                    aria-label={`${item.action}: ${item.title}, in ${item.destination}`}
                    >{item.action}<Icon name="external" size={16} /></a
                  >
                </li>
              {/each}
            </ul>
            {#if concerns.length > 4}<a class="home-more" href={appHref("/activity/overview")}
                >View all health checks and activity <Icon name="arrow-right" size={16} /></a
              >{/if}
          {:else}<div class="home-empty">
              <Icon name={coverage.length ? "warning" : "check"} size={24} />
              <h3>{coverage.length ? "Some checks are unavailable" : "No issues in the available records"}</h3>
              <p>
                {coverage.length
                  ? "Missing measurements are not an all-clear."
                  : unknown
                    ? `${unknown} checks have no result yet. Open health details to review coverage.`
                    : "Nothing needs attention in this snapshot."}
              </p>
              <a href={appHref("/activity/overview")}>View health details <Icon name="arrow-right" size={16} /></a>
            </div>{/if}
          {#if coverage.length}<div class="home-coverage" role="status">
              <strong>Incomplete snapshot</strong>
              <p>Unavailable: {coverage.join(", ")}.{pulseNote ? ` ${pulseNote}` : ""}</p>
              {#if !error}<button class="btn-quiet" aria-disabled={loading} onclick={retry}>Retry snapshot</button>{/if}
            </div>{/if}
        {/if}
      </section>
      <aside class="home-sidebar">
        <h2>Quick actions</h2>
        <nav class="home-shortcuts" aria-label="Quick actions">
          <a href={appHref("/library/search")}
            ><Icon name="search" />Find an asset<Icon name="chevron-right" size={16} /></a
          >
          <a href={appHref("/library/files?" + new URLSearchParams({ bundle: workspace.defaultWriteTarget, path: "" }))}
            ><Icon name="plus" />Create in Files<Icon name="chevron-right" size={16} /></a
          >
          <a href={appHref("/settings/bundles")}
            ><Icon name="folder" />Manage bundles<Icon name="chevron-right" size={16} /></a
          >
        </nav>
        <div class="home-glance">
          <h3>At a glance</h3>
          <dl>
            <div>
              <dt>Passing checks</dt>
              <dd>{data?.health ? `${passing} of ${checks.length}` : "Unavailable"}</dd>
            </div>
            <div>
              <dt>Not measured</dt>
              <dd>{data?.health ? unknown : "Unavailable"}</dd>
            </div>
            <div>
              <dt>Enabled bundles</dt>
              <dd>
                {workspace.bundlesReady
                  ? `${workspace.bundles.filter((bundle) => bundle.enabled).length} of ${workspace.bundles.length}`
                  : "Unavailable"}
              </dd>
            </div>
          </dl>
          <a href={appHref("/activity/overview")} class="home-health-link"
            >Health details <Icon name="arrow-right" size={16} /></a
          >
        </div>
      </aside>
    </div>
    <div class="home-bottom">
      <section aria-labelledby="home-runs-title">
        <div class="home-section-title">
          <h2 id="home-runs-title">Task runs this week</h2>
          <a href={appHref("/activity/overview?view=runs&window=7d")} class="home-detail-link"
            >All activity<Icon name="external" size={16} /></a
          >
        </div>
        {#if outcomes && outcomes.total > 0}
          <figure class="home-runs">
            <figcaption class="home-run-totals">
              <span><strong>{outcomes.completed.toLocaleString()}</strong> completed</span><span
                ><strong>{outcomes.failed.toLocaleString()}</strong> failed</span
              >{#if outcomes.other}<span><strong>{outcomes.other.toLocaleString()}</strong> other outcomes</span>{/if}
            </figcaption>
            <div
              class="home-run-bar"
              role="img"
              aria-label={`${outcomes.completed} completed, ${outcomes.failed} failed, ${outcomes.other} other outcomes. ${outcomes.total} task runs recorded in the past seven days.`}
            >
              {#if outcomes.completed}<span class="completed" style:flex={outcomes.completed}
                ></span>{/if}{#if outcomes.failed}<span class="failed" style:flex={outcomes.failed}
                ></span>{/if}{#if outcomes.other}<span class="other" style:flex={outcomes.other}></span>{/if}
            </div>
            <div class="home-run-legend">
              <span><i class="completed" aria-hidden="true"></i>Completed</span><span
                ><i class="failed" aria-hidden="true"></i>Failed</span
              >{#if outcomes.other}<span><i class="other" aria-hidden="true"></i>Other / unfinished</span>{/if}
            </div>
            <p class="muted small">{outcomes.total.toLocaleString()} recorded task runs · Past 7 days</p>
          </figure>
        {:else}<p class="home-no-runs">
            {outcomes
              ? "No task runs recorded in the past 7 days."
              : "Task outcomes are unavailable. This is not a zero count."}
          </p>{/if}
      </section>
      <section class="home-review" aria-labelledby="home-review-title">
        <span class="home-kicker">Ready for your review</span>
        <h2 id="home-review-title">
          {workspace.pendingCount === null
            ? "Review queue unavailable"
            : workspace.pendingCount === 0
              ? "No proposals waiting"
              : `${workspace.pendingCount.toLocaleString()} proposed ${workspace.pendingCount === 1 ? "change" : "changes"}`}
        </h2>
        <p>
          {workspace.pendingCount === null
            ? "Open Review to check the queue."
            : workspace.pendingCount === 0
              ? "New suggestions will appear here."
              : "Review suggested updates to your knowledge."}
        </p>
        <a class:btn-secondary={!workspace.pendingCount} class="btn" href={appHref("/review")}
          >{workspace.pendingCount ? "Review proposals" : "Open Review"}<Icon name="arrow-right" size={16} /></a
        >
      </section>
    </div>
  {/if}
</div>

<style>
  .home-page {
    max-width: 1160px;
    margin: 0 auto;
    padding: var(--space-2) 0 var(--space-5);
  }
  .home-page :is(h2, h3, p, figure) {
    margin: 0;
  }
  .home-page section {
    margin: 0;
  }
  .home-page h2 {
    font-size: var(--text-l);
    line-height: 1.4;
    letter-spacing: -0.015em;
  }
  .home-page h3 {
    font-size: var(--text-m);
    line-height: 1.45;
    font-weight: 600;
    letter-spacing: 0;
  }
  .home-setup {
    display: grid;
    gap: var(--space-4);
    justify-items: start;
    padding: var(--space-2) 0;
  }
  .home-setup p {
    max-width: 60ch;
    line-height: 1.6;
  }
  .home-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-6);
  }
  .home-heading p {
    margin-top: var(--space-2);
  }
  .home-columns {
    display: grid;
    grid-template-columns: minmax(0, 1.85fr) minmax(0, 1fr);
    gap: var(--space-6);
  }
  .home-attention {
    padding: var(--space-5);
    border-radius: var(--radius-large);
    background: var(--surface);
    align-self: start;
  }
  .home-section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }
  .home-pruned {
    margin-bottom: var(--space-4);
  }
  .home-count {
    font-size: var(--text-2xs);
    font-weight: 600;
    background: var(--surface-2);
    padding: 2px 7px;
    border-radius: 5px;
  }
  .home-concerns {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .home-concerns li {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) auto;
    gap: var(--space-3);
    align-items: start;
    padding: var(--space-5) 0;
    border-top: 1px solid var(--border);
  }
  .home-concerns li:last-child {
    padding-bottom: var(--space-2);
  }
  .home-concern-copy p {
    font-size: var(--text-xs);
    line-height: 1.55;
    color: var(--muted);
    margin-top: 6px;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .home-signal {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 9px;
    color: var(--warn);
    background: var(--warn-bg);
  }
  .home-signal.failure {
    color: var(--fail);
    background: var(--fail-bg);
  }
  .home-detail-link,
  .home-more,
  .home-health-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
    text-decoration: none;
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: 550;
  }
  .home-detail-link {
    white-space: nowrap;
    padding: var(--space-1) 0;
  }
  .home-page a:hover {
    color: var(--link);
    text-decoration: underline;
  }
  .home-more {
    margin-top: 20px;
  }
  .home-shortcuts {
    display: grid;
    gap: var(--space-1);
    margin-top: var(--space-4);
  }
  .home-shortcuts a {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-2);
    min-height: 48px;
    color: var(--text);
    text-decoration: none;
    border-radius: var(--radius);
  }
  .home-shortcuts a:hover {
    background: var(--surface-2);
  }
  .home-shortcuts a :global(svg:last-child) {
    margin-left: auto;
    color: var(--muted);
  }
  .home-glance {
    border-top: 1px solid var(--border);
    padding-top: var(--space-5);
    margin-top: var(--space-5);
  }
  .home-glance dl {
    display: grid;
    gap: var(--space-4);
    margin: 20px 0 var(--space-3);
    font-size: var(--text-xs);
  }
  .home-glance dl div {
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .home-glance dt {
    font-weight: 400;
  }
  .home-glance dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .home-bottom {
    display: grid;
    grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
    gap: var(--space-6);
    margin-top: 40px;
  }
  .home-review {
    border-left: 1px solid var(--border);
    padding: var(--space-2) 0 var(--space-2) var(--space-6);
    display: flex;
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-3);
    justify-content: center;
  }
  .home-kicker {
    font-size: var(--text-2xs);
    color: var(--muted);
  }
  .home-review p {
    color: var(--muted);
    font-size: var(--text-xs);
    max-width: 30ch;
  }
  .home-review a.btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-1);
    text-decoration: none;
  }
  .home-review a.btn:not(.btn-secondary):hover {
    color: var(--on-accent);
  }
  .home-runs {
    padding-top: var(--space-3);
  }
  .home-run-totals {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .home-run-totals strong {
    font-size: var(--text-heading);
    letter-spacing: -0.02em;
    font-weight: 600;
    color: var(--text);
    margin-right: var(--space-1);
    font-variant-numeric: tabular-nums;
  }
  .home-run-bar {
    display: flex;
    gap: var(--space-1);
    height: 28px;
    border-radius: 5px;
    overflow: hidden;
    margin: 20px 0 var(--space-4);
    background: var(--surface-2);
  }
  .home-runs .completed {
    background: var(--ok);
  }
  .home-runs .failed {
    background: var(--fail);
  }
  .home-runs .other {
    background: var(--faint);
  }
  .home-run-legend {
    display: flex;
    gap: var(--space-4);
    flex-wrap: wrap;
    font-size: var(--text-2xs);
    color: var(--muted);
    margin-bottom: var(--space-3);
  }
  .home-run-legend span {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .home-run-legend i {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .home-no-runs {
    color: var(--muted);
    font-size: var(--text-s);
    padding: var(--space-5) 0;
    max-width: 46ch;
  }
  .home-empty {
    padding: var(--space-5) 0;
  }
  .home-empty > :global(svg) {
    color: var(--muted);
    margin-bottom: var(--space-3);
  }
  .home-empty p {
    font-size: var(--text-s);
    color: var(--muted);
    margin: var(--space-2) 0 var(--space-4);
    max-width: 48ch;
  }
  .home-empty a {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
    font-size: var(--text-s);
  }
  .home-coverage {
    padding-top: 20px;
    border-top: 1px solid var(--border);
    margin-top: 20px;
    font-size: var(--text-xs);
  }
  .home-coverage p {
    color: var(--muted);
    margin-top: var(--space-1);
  }
  .home-coverage button {
    margin-top: var(--space-2);
  }
  @media (max-width: 1050px) {
    .home-concerns li {
      grid-template-columns: 32px minmax(0, 1fr);
    }
    .home-concerns .home-detail-link {
      grid-column: 2;
      justify-self: start;
    }
    .home-columns {
      grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
      gap: var(--space-5);
    }
  }
  @media (max-width: 700px) {
    .home-columns,
    .home-bottom {
      grid-template-columns: 1fr;
      gap: var(--space-6);
    }
    .home-heading {
      align-items: flex-start;
    }
    .home-attention {
      padding: 20px;
    }
    .home-review {
      padding: var(--space-5) 0 0;
      border-left: 0;
      border-top: 1px solid var(--border);
    }
    .home-bottom {
      margin-top: var(--space-6);
    }
    .home-heading p {
      font-size: var(--text-2xs);
    }
    .home-section-title {
      gap: var(--space-2);
    }
  }
</style>

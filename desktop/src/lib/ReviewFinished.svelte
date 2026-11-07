<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { proposalHref } from "./review-model";

  let {
    filtered,
    remaining,
    reviewed,
    heading = $bindable(),
  }: {
    /** A source, age, week or outcome filter is active. */
    filtered: boolean;
    /** Pending proposals outside the filters (all pending when none is active). */
    remaining: number;
    reviewed: number;
    heading?: HTMLHeadingElement;
  } = $props();
  const recent = proposalHref("", new URLSearchParams({ status: "recent" }));
  const all = proposalHref("", new URLSearchParams({ status: "pending" }));
</script>

<div class="state finished" data-finished>
  {#if filtered && remaining > 0}
    <h2 bind:this={heading} tabindex="-1">Nothing left in this view</h2>
    <p>{remaining} more proposals are waiting outside these filters.</p>
    <div class="btn-row">
      <a class="btn" href={all}>Show all pending</a><a class="btn btn-secondary" href={recent}>View recent decisions</a>
    </div>
  {:else}
    <h2 bind:this={heading} tabindex="-1">All caught up</h2>
    <p>
      Nothing is waiting for review.{#if !filtered && reviewed > 0}{" "}You reviewed {reviewed} this session.{/if}
    </p>
    <div class="btn-row">
      {#if filtered}<a class="btn" href={all}>Clear filters</a><a class="btn btn-secondary" href={recent}
          >View recent decisions</a
        >{:else}<a class="btn" href={recent}>View recent decisions</a><a class="btn btn-secondary" href="/"
          >Go to Home</a
        >{/if}
    </div>
  {/if}
</div>

<style>
  .finished {
    border: 0;
    background: none;
    box-shadow: none;
    text-align: left;
    padding: var(--space-6) var(--space-2);
  }
</style>

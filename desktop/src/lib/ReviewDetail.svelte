<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import Diff from "./Diff.svelte";
  import Icon from "./Icon.svelte";
  import ReviewEvidence from "./ReviewEvidence.svelte";
  import { title } from "./client";
  import { proposalHref, type ReviewProposal } from "./review-model";
  import type { ProposalDetail } from "./types";

  let {
    detail,
    noop,
    query,
    heading = $bindable(),
  }: { detail: ProposalDetail; noop: boolean; query: URLSearchParams; heading?: HTMLHeadingElement } = $props();
  const current = $derived(detail.proposal as ReviewProposal);
</script>

<!-- Reading order, visual and DOM, at every window size: what it is, what to watch for, the change itself, then why it
     was proposed. A short window has room for the change or for the reasons, and the change is what is decided. -->
<nav class="crumbs proposal-back" aria-label="Proposal breadcrumb">
  <a class="back" href={proposalHref("", query)}><Icon name="arrow-left" size={16} /><span>Back to queue</span></a>
</nav>
<header class="proposal-summary">
  <div class="proposal-title">
    <h2 bind:this={heading} tabindex="-1">{title(current)}</h2>
    <div class="badges">
      <span class="badge">{current.status}</span><span class="badge">{current.source}</span>{#if current.isRetire}<span
          class="badge">Retirement</span
        >{/if}
    </div>
  </div>
  <div class="proposal-location">
    <span class="mono wrap small">{current.ref}</span>{#if detail.diff?.isNew}<span class="muted small">New asset</span
      >{:else}<a
        class="target-link"
        href={`/library/asset?ref=${encodeURIComponent(current.ref)}&view=files&returnTo=${encodeURIComponent(proposalHref(current.id, query))}`}
        >Open in Files</a
      >{/if}
  </div>
</header>
{#key current.id}<ReviewEvidence {detail} {noop}>
    <section class="change" aria-label="Proposed change">
      <h3>Proposed change</h3>
      {#if detail.diff}<Diff
          before={detail.diff.before}
          after={detail.diff.after}
          unified={detail.diff.unified ?? ""}
          redacted={detail.diff.redacted ?? false}
          truncated={detail.diff.truncated ?? false}
        />{:else}<p class="muted">No change preview is available.</p>{/if}
    </section>
  </ReviewEvidence>{/key}

<style>
  .proposal-back {
    display: none;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    text-decoration: none;
  }
  .back span {
    text-decoration: underline;
  }
  .proposal-summary {
    margin: 0 0 var(--space-2);
  }
  .proposal-title,
  .proposal-location {
    display: flex;
    align-items: center;
    gap: 0.5rem 1rem;
    flex-wrap: wrap;
  }
  .proposal-title h2 {
    font-size: var(--text-xl);
    margin: 0;
    scroll-margin-top: calc(var(--top-inset) + 8px);
  }
  .proposal-location {
    margin-top: var(--space-1);
  }
  .target-link {
    font-size: var(--text-s);
  }
  .change {
    margin-block-start: var(--space-2);
    scroll-margin-block-start: calc(var(--top-inset) + var(--space-2));
  }
  section h3 {
    font-size: var(--text-m);
    margin: var(--space-2) 0 var(--space-2);
  }
  .wrap {
    overflow-wrap: anywhere;
  }
  section :global(.change-preview) {
    margin-block-start: 0;
  }
  @media (max-width: 850px) {
    .proposal-back {
      display: block;
      margin: 0 0 var(--space-3);
    }
  }
  @media (min-width: 851px) and (max-height: 700px) {
    .proposal-back {
      display: block;
      margin: 0 0 var(--space-2);
    }
  }
</style>

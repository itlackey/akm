<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import type { ProposalDetail } from "./types";
  import { plural, record, relativeAge, rows, text, type ReviewProposal } from "./review-model";
  import { date } from "./client";

  let { detail, noop }: { detail: ProposalDetail; noop: boolean } = $props();
  const p = $derived(detail.proposal as ReviewProposal);
  const validation = $derived(record(detail.validation));
  const findings = $derived(rows(validation.findings));
  const errors = $derived(findings.filter((f) => f.severity === "error"));
  const others = $derived(findings.filter((f) => f.severity !== "error"));
  const retirement = $derived(record(p.retirement));
  const risk = $derived(record(retirement.continuityRisk));
  const review = $derived(record(p.review));
  // A retirement carries its own judge and reason; show them where the proposal has none of its own.
  const reasonText = $derived(p.reason || (p.retirement ? text(retirement.judgeReason, "") : ""));
  const judgeText = $derived(
    p.gateDecision?.outcome ?? (p.retirement && typeof retirement.judgeLabel === "string" ? retirement.judgeLabel : ""),
  );
  const severityLabel = (value: unknown) =>
    (({ error: "Error", warn: "Warning", warning: "Warning", info: "Info" }) as Record<string, string>)[
      text(value, "info")
    ] ?? text(value, "info");
  const missing = (value: string) => value === "Not recorded" || value === "Unavailable";
  const validationText = $derived(
    detail.validation == null
      ? "Unavailable"
      : validation.ok === false
        ? "Did not pass"
        : findings.length
          ? plural(findings.length, "finding")
          : "Passed",
  );
</script>

<!-- Actionable warnings come first and are never hidden beneath the diff. -->
{#if validation.ok === false}<div class="notice notice-fail">
    <strong>Validation did not pass.</strong> Read the findings below before deciding.
  </div>{/if}
{#if noop}<div class="notice notice-warn">
    <strong>This proposal changes nothing.</strong> Its proposed content matches the current asset. Reject it as a no-op,
    or accept anyway.
  </div>{/if}
{#if p.retirement && risk.failingQueries !== undefined}<div class="notice notice-warn">
    <strong>Continuity risk flagged.</strong>
    {text(risk.failingQueries, "Unknown")} failing and {text(risk.unverifiedQueries, "0")} unverified queries. See retirement
    evidence below.
  </div>{/if}
{#if detail.diffError}<div class="notice notice-warn">
    <strong>Change preview unavailable:</strong>
    {detail.diffError}. AKM still validates a decision.
  </div>{/if}

<section class="why" aria-labelledby="review-why">
  <h3 id="review-why">Why AKM proposed this</h3>
  {#if reasonText}<p class="reason">{reasonText}</p>{:else}<p class="reason muted">No reason recorded.</p>{/if}
  <dl class="facts">
    <div>
      <dt>Process</dt>
      <dd>{p.source}</dd>
    </div>
    <div>
      <dt>Waiting</dt>
      <dd class={missing(relativeAge(p.waitingSince)) ? "missing" : undefined}>
        <span title={date(p.waitingSince)}>{relativeAge(p.waitingSince)}</span>
      </dd>
    </div>
    <div>
      <dt>Judge</dt>
      <dd class={judgeText ? undefined : "missing"}>{judgeText || "Not recorded"}</dd>
    </div>
    <div>
      <dt>Confidence</dt>
      <dd class={typeof p.confidence === "number" ? undefined : "missing"}>
        {typeof p.confidence === "number" ? p.confidence.toFixed(2) : "Not recorded"}
      </dd>
    </div>
    <div>
      <dt>Validation</dt>
      <dd class={missing(validationText) ? "missing" : undefined}>{validationText}</dd>
    </div>
  </dl>
  {#if p.gateDecision?.reason}<p class="judge muted small" title={p.gateDecision.reason}>
      Judge: {p.gateDecision.reason}
    </p>{/if}
  {#if findings.length}<ul class="plain findings" aria-label="Validation findings">
      {#each errors as finding}{@render item(finding)}{/each}
      {#each others.slice(0, 3) as finding}{@render item(finding)}{/each}
    </ul>
    {#if others.length > 3}<details>
        <summary>Show all {findings.length} findings</summary>
        <ul class="plain findings">
          {#each others.slice(3) as finding}{@render item(finding)}{/each}
        </ul>
      </details>{/if}{/if}
  {#if p.retirement}
    <p class="retire">
      Retires <a class="mono wrap" href={`/library/asset?ref=${encodeURIComponent(text(retirement.retiredRef, p.ref))}`}
        >{text(retirement.retiredRef, p.ref)}</a
      >
      →
      {#if typeof retirement.successorRef === "string"}<a
          class="mono wrap"
          href={`/library/asset?ref=${encodeURIComponent(retirement.successorRef)}`}>{retirement.successorRef}</a
        >{:else}no successor{/if}
      · similarity {typeof retirement.cosine === "number" ? retirement.cosine.toFixed(2) : "not recorded"}
    </p>
    <p class="muted small">Reason: {text(retirement.reason)}</p>
    <details>
      <summary>Retirement details</summary>
      <dl class="evidence-grid">
        <dt>Judge</dt>
        <dd>{text(retirement.judgeLabel)} — {text(retirement.judgeReason)}</dd>
        {#each [["onlyInRetired", "Only in retired"], ["onlyInSuccessor", "Only in successor"]] as [key, label]}<dt>
            {label}
          </dt>
          <dd>
            {#if Array.isArray(retirement[key]) && retirement[key].length}<ul>
                {#each retirement[key] as entry}<li>{text(entry)}</li>{/each}
              </ul>{:else}Nothing recorded{/if}
          </dd>{/each}
      </dl>
      {#if rows(risk.ranks).length}<div class="risk-table">
          <table>
            <thead><tr><th>Query</th><th>Retired rank</th><th>Successor rank</th></tr></thead><tbody
              >{#each rows(risk.ranks) as rank}<tr
                  ><th>{text(rank.query)}</th><td>{text(rank.retiredRank)}</td><td
                    >{text(rank.successorRank, "Not in top 10")}</td
                  ></tr
                >{/each}</tbody
            >
          </table>
        </div>{/if}
    </details>
  {/if}
  <details>
    <summary>Provenance and changed files ({rows(p.changes).length})</summary>
    <dl class="evidence-grid">
      <dt>Proposal ID</dt>
      <dd class="mono wrap">{p.id}</dd>
      <dt>Created</dt>
      <dd>{date(p.createdAt)}</dd>
      {#if p.sourceRun}<dt>Source run</dt>
        <dd class="mono wrap">{p.sourceRun}</dd>{/if}
      {#if p.gateDecision?.reason}<dt>Judge reason</dt>
        <dd>{p.gateDecision.reason}</dd>{/if}
      {#if p.proposedTarget}<dt>Target bundle</dt>
        <dd>{p.proposedTarget.source}</dd>
        <dt>Target directory</dt>
        <dd class="mono wrap">{p.proposedTarget.root}</dd>{/if}
      {#if p.review}<dt>Decision</dt>
        <dd>{text(review.outcome)} · {date(review.decidedAt)} · {p.decider ?? "Decider unknown"}</dd>
        <dt>Reason</dt>
        <dd>{text(review.reason)}</dd>{/if}
    </dl>
    {#if rows(p.changes).length}<ul class="plain">
        {#each rows(p.changes) as change}<li>
            <span class="badge">{text(change.op)}</span> <code class="wrap">{text(change.path)}</code>
          </li>{/each}
      </ul>{:else}<p class="muted">No changed-file metadata recorded.</p>{/if}
  </details>
</section>

{#snippet item(finding: Record<string, unknown>)}
  <li>
    <span class="badge" data-tone={finding.severity === "error" ? "fail" : "warn"}
      >{severityLabel(finding.severity)}</span
    >
    <strong>{text(finding.kind, "Finding")}</strong>
    <span>{text(finding.message)}</span>
  </li>
{/snippet}

<style>
  .why {
    margin-block: var(--space-3);
  }
  h3 {
    font-size: var(--text-m);
    margin: 0 0 var(--space-2);
  }
  .reason {
    max-width: 72ch;
    margin: 0 0 var(--space-2);
    font-size: var(--text-m);
    line-height: var(--leading-snug);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: var(--text-s);
    margin: 0;
  }
  .facts dt {
    display: inline;
    color: var(--muted);
  }
  .facts dd {
    display: inline;
    margin: 0 0 0 4px;
    font-weight: 550;
  }
  .facts dd.missing {
    color: var(--muted);
    font-weight: 400;
  }
  .judge {
    margin: var(--space-1) 0 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .findings {
    margin-block: var(--space-2);
    font-size: var(--text-s);
  }
  .findings li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-2);
    margin-block: var(--space-1);
  }
  .retire {
    margin: var(--space-2) 0 0;
    font-size: var(--text-s);
  }
  details {
    margin-block: var(--space-1) 0;
    font-size: var(--text-s);
  }
  .evidence-grid {
    display: grid;
    grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
    gap: 0.45rem 1rem;
    font-size: var(--text-s);
  }
  .evidence-grid dt {
    color: var(--muted);
  }
  .evidence-grid dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .risk-table {
    overflow-x: auto;
  }
  .notice {
    margin-block: var(--space-2);
    padding-block: var(--space-2);
  }
</style>

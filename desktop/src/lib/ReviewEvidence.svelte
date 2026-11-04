<script lang="ts">
  import type { ProposalDetail } from './types';
  import { record, rows, text, type ReviewProposal } from './review-model';
  import { date } from './client';
  export let detail: ProposalDetail;
  $: p = detail.proposal as ReviewProposal;
  $: findings = rows(record(detail.validation).findings);
  $: retirement = record(p.retirement);
  $: review = record(p.review);
</script>
<section class="review-evidence" aria-label="Evidence and validation">
<section class="why" aria-labelledby="review-why"><h3 id="review-why">Why AKM proposed this</h3>
  <dl class="evidence-grid"><dt>Process</dt><dd>{p.source}</dd><dt>Waiting since</dt><dd>{date(p.waitingSince)}</dd>
    {#if p.sourceRun}<dt>Source run</dt><dd class="mono wrap">{p.sourceRun}</dd>{/if}
    {#if p.gateDecision}<dt>Judge</dt><dd>{p.gateDecision.outcome}{p.gateDecision.reason ? `: ${p.gateDecision.reason}` : ''}</dd>{/if}
    <dt>Confidence</dt><dd>{typeof p.confidence === 'number' ? p.confidence.toFixed(2) : 'Not recorded'}</dd>
    <dt>Validation</dt><dd>{detail.validation == null ? 'Unavailable' : record(detail.validation).ok === false ? 'Did not pass' : findings.length ? `${findings.length} findings` : 'No findings'}</dd>
  </dl>
</section>
{#if findings.length}<section aria-label="Validation findings"><h3>Validation findings</h3><ul class="plain findings">{#each findings as finding}<li><span class="badge" class:fail={finding.severity === 'error'}>{text(finding.severity, 'info')}</span> <strong>{text(finding.kind, 'Finding')}</strong><p>{text(finding.message)}</p></li>{/each}</ul></section>{/if}
{#if p.retirement}<section aria-label="Retirement evidence"><h3>Retirement evidence</h3><dl class="evidence-grid">
  <dt>Retires</dt><dd><a class="mono wrap" href={`#/asset?ref=${encodeURIComponent(text(retirement.retiredRef, p.ref))}`}>{text(retirement.retiredRef, p.ref)}</a></dd>
  {#if typeof retirement.successorRef === 'string'}<dt>Successor</dt><dd><a class="mono wrap" href={`#/asset?ref=${encodeURIComponent(retirement.successorRef)}`}>{retirement.successorRef}</a></dd>{/if}
  <dt>Reason</dt><dd>{text(retirement.reason)}</dd><dt>Judge</dt><dd>{text(retirement.judgeLabel)} — {text(retirement.judgeReason)}</dd>
  <dt>Similarity</dt><dd>{typeof retirement.cosine === 'number' ? `${retirement.cosine.toFixed(2)} cosine` : 'Not recorded'}</dd>
  {#each [['onlyInRetired', 'Only in retired'], ['onlyInSuccessor', 'Only in successor']] as [key, label]}<dt>{label}</dt><dd>{#if Array.isArray(retirement[key]) && retirement[key].length}<ul>{#each retirement[key] as item}<li>{text(item)}</li>{/each}</ul>{:else}Nothing recorded{/if}</dd>{/each}
  <dt>Continuity risk</dt><dd>{retirement.continuityRisk ? 'Flagged — inspect query evidence below before accepting.' : 'None flagged'}</dd>
  </dl>
  {#if retirement.continuityRisk}{@const risk = record(retirement.continuityRisk)}<p>{text(risk.failingQueries, 'Unknown')} failing queries · {text(risk.unverifiedQueries, '0')} unverified queries.</p>{#if rows(risk.ranks).length}<div class="risk-table"><table><thead><tr><th>Query</th><th>Retired rank</th><th>Successor rank</th></tr></thead><tbody>{#each rows(risk.ranks) as rank}<tr><th>{text(rank.query)}</th><td>{text(rank.retiredRank)}</td><td>{text(rank.successorRank, 'Not in top 10')}</td></tr>{/each}</tbody></table></div>{/if}{/if}
</section>{/if}
<details><summary>Proposal provenance and changed files</summary><dl class="evidence-grid"><dt>Proposal ID</dt><dd class="mono wrap">{p.id}</dd><dt>Created</dt><dd>{date(p.createdAt)}</dd>
  {#if p.proposedTarget}<dt>Target bundle</dt><dd>{p.proposedTarget.source}</dd><dt>Target directory</dt><dd class="mono wrap">{p.proposedTarget.root}</dd>{/if}
  {#if p.review}<dt>Decision</dt><dd>{text(review.outcome)} · {date(review.decidedAt)} · {p.decider ?? 'Decider unknown'}</dd><dt>Reason</dt><dd>{text(review.reason)}</dd>{/if}
</dl>{#if rows(p.changes).length}<ul class="plain">{#each rows(p.changes) as change}<li><span class="badge">{text(change.op)}</span> <code class="wrap">{text(change.path)}</code></li>{/each}</ul>{:else}<p class="muted">No changed-file metadata recorded.</p>{/if}</details>
</section>
<style>
  .review-evidence { border-top:1px solid var(--border); margin-block:1rem .5rem; padding-top:1rem; }
  .review-evidence>section:first-child { margin-top:0; }
  .evidence-grid { display: grid; grid-template-columns: minmax(7rem, auto) minmax(0, 1fr); gap: .45rem 1rem; font-size: .875rem; }
  dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
  .findings li { margin-block: .5rem; } .findings p { margin: .25rem 0; }
  .fail { color: var(--fail); } section { margin-block: 1rem; }
  .risk-table { overflow-x: auto; }
</style>

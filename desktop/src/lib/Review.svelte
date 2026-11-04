<script lang="ts">
  import { navigate } from './navigation';
  import { onMount, tick } from 'svelte';
  import { api, date, title, toggleSelection } from './client';
  import Diff from './Diff.svelte';
  import ReviewEvidence from './ReviewEvidence.svelte';
  import Icon from './Icon.svelte';
  import { ageBands, rejectionChoices, rejectionReason, rejectionError, proposalId, proposalHref, activityReturn, commitOutcome, conceptLocation, record, text, type ReviewQueue, type ReviewProposal } from './review-model';
  import type { ProposalDetail, WriteResult } from './types';
  export let route = 'proposals';
  export let query = new URLSearchParams();
  let status = 'pending', source = '', age = '', week = '', outcome = '', queue: ReviewQueue | null = null, detail: ProposalDetail | null = null, selected: string[] = [];
  let error = '', queueError = '', detailError = '', busy = false, loading = false, opening = false, intent = '', reason = '', choice = '';
  let receipt: WriteResult | null = null, receiptKind = '', receiptId = '', reviewed = 0, locked = false;
  let queueGeneration = 0, detailGeneration = 0, mounted = false, previousRoute = '', desiredId = '', queuedAction = '', region: HTMLElement;
  let shortcutsEnabled = false, decisionTrigger: HTMLElement | null = null, decisionTriggerKey = '';
  let detailHeading: HTMLHeadingElement;
  $: current = detail?.proposal as ReviewProposal | undefined;
  $: analyticsReturn = activityReturn(query.get('returnTo'));
  $: noop = !!(current?.status === 'pending' && detail?.diff && !detail.diff.redacted && !detail.diff.truncated && typeof detail.diff.before === 'string' && detail.diff.before === detail.diff.after);
  $: if (mounted) syncRoute(route, String(query));
  onMount(() => { mounted = true; return () => { ++queueGeneration; ++detailGeneration; }; });

  function syncRoute(path: string, params: string) {
    const key = `${path}?${params}`;
    if (previousRoute === key) return;
    previousRoute = key;
    const nextStatus = query.get('status') === 'recent' ? 'recent' : 'pending';
    const nextSource = query.get('source') ?? '', nextAge = query.get('age') ?? '';
    const nextWeek = query.get('week') ?? '', nextOutcome = query.get('class') ?? '';
    const changed = nextStatus !== status || nextSource !== source || nextAge !== age || nextWeek !== week || nextOutcome !== outcome;
    status = nextStatus; source = nextSource; age = nextAge; week = nextWeek; outcome = nextOutcome;
    if (changed || !queue) { if (changed) queue = null; selected = []; void load(); }
    const id = proposalId(path, query);
    if (id !== desiredId) {
      const previousId = desiredId;
      desiredId = id; intent = ''; error = ''; reason = ''; choice = '';
      if (id) void open(id); else { ++detailGeneration; detail = null; detailError = ''; opening = false; }
      if (!id && previousId && !changed) void restoreQueueFocus(previousId);
    }
  }
  async function load() {
    const generation = ++queueGeneration;
    queueError = ''; loading = true;
    try { const next = await api<ReviewQueue>('/proposals', { status, source, age, week, class: outcome, limit: '200' }); if (generation === queueGeneration) queue = next; }
    catch (e) { if (generation === queueGeneration) queueError = (e as Error).message; }
    finally { if (generation === queueGeneration) loading = false; }
  }
  async function open(id: string) {
    const generation = ++detailGeneration;
    detailError = ''; detail = null; opening = true;
    try { const next = await api<ProposalDetail>(`/proposals/${encodeURIComponent(id)}`); if (generation === detailGeneration) { detail = next; if (queuedAction) { const action = queuedAction; queuedAction = ''; void begin(action); } } }
    catch (e) { if (generation === detailGeneration) detailError = (e as Error).message; }
    finally {
      if (generation === detailGeneration) {
        opening = false;
        await tick();
        if (generation === detailGeneration && !intent && matchMedia('(max-width:850px)').matches) {
          detailHeading?.focus({ preventScroll: true });
          detailHeading?.scrollIntoView({ block: 'start' });
        }
      }
    }
  }
  async function restoreQueueFocus(previousId: string) {
    await tick();
    [...(region?.querySelectorAll<HTMLAnchorElement>('.review-item') ?? [])].find(link => proposalId(link.hash.replace(/^#\//, '').split('?')[0], new URLSearchParams(link.hash.split('?')[1])) === previousId)?.focus();
  }
  function select(id: string) { void navigate(proposalHref(id, query)); }
  function queueDate(value: unknown) { const parsed = new Date(String(value ?? '')); return Number.isNaN(parsed.valueOf()) ? 'Date unavailable' : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function receiptAction(action: string) { if (desiredId === receiptId) void begin(action); else { queuedAction = action; select(receiptId); } }
  function filter(key: string, value: string) {
    const params = new URLSearchParams(query); params.delete('id');
    if (value) params.set(key, value); else params.delete(key);
    void navigate(proposalHref('', params));
  }
  async function begin(action: string) {
    decisionTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    decisionTriggerKey = action;
    intent = action; error = '';
    if (noop && action === 'reject') { choice = 'Other'; reason = 'No-op: the proposed content matches the current asset.'; }
    await tick(); region?.querySelector<HTMLElement>(action.includes('reject') ? '[name="reject-choice"]' : '[data-confirm]')?.focus();
  }
  async function cancel() { intent = ''; await tick(); if (decisionTrigger?.isConnected) decisionTrigger.focus(); else (region?.querySelector<HTMLElement>(`[data-decision="${decisionTriggerKey}"]`) ?? region?.querySelector<HTMLElement>('[data-primary-decision]'))?.focus(); }
  async function decide() {
    if (!intent || busy || locked) return;
    if (intent.includes('reject')) { error = rejectionError(choice, reason); if (error) return; }
    const isBatch = intent.startsWith('batch-'), action = intent.replace('batch-', ''), targetId = current?.id;
    if ((!isBatch && !targetId) || (isBatch && !selected.length)) return;
    busy = true; error = ''; receipt = null;
    try {
      const payload = action === 'reject' ? { reason: rejectionReason(choice, reason) } : {};
      receipt = await api<WriteResult>(isBatch ? `/proposals/${action}` : `/proposals/${encodeURIComponent(targetId!)}/${action}`, {}, isBatch ? { ids: [...selected], ...payload } : payload);
      window.dispatchEvent(new CustomEvent('akm-proposals-changed'));
      receiptKind = action; receiptId = isBatch ? '' : targetId!;
      if (action === 'accept' || action === 'reject') reviewed += isBatch ? receipt.accepted ?? receipt.rejected ?? 0 : 1;
      intent = ''; reason = ''; choice = '';
      if (isBatch) selected = (receipt.results ?? []).filter(r => !r.ok).map(r => r.id);
      await load(); if (targetId && desiredId === targetId) await open(targetId);
      await tick(); region?.querySelector<HTMLElement>('[data-receipt]')?.focus();
    } catch (e) {
      error = (e as Error).message;
      if (record(e).code === 'INVALID_COMMAND_RESPONSE') { locked = true; error += ' State may already have changed. Reload before making another decision; do not repeat automatically.'; }
    } finally { busy = false; }
  }
  async function refresh() { locked = false; error = ''; await load(); if (desiredId) await open(desiredId); }
  function go(direction: number) {
    const proposals = queue?.proposals ?? [], index = proposals.findIndex(p => p.id === desiredId);
    const next = proposals[index < 0 ? direction > 0 ? 0 : proposals.length - 1 : (index + direction + proposals.length) % proposals.length];
    if (next) select(next.id);
  }
  function keydown(event: KeyboardEvent) {
    if (region?.closest('[hidden]')) return;
    const target = event.target as HTMLElement;
    if (event.key === 'Escape' && intent && !busy) { event.preventDefault(); void cancel(); return; }
    if (!shortcutsEnabled || event.repeat || !region?.contains(target)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || target?.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (busy || locked) return;
    switch (event.key.toLowerCase()) {
      case 'j': case 'n': event.preventDefault(); go(1); break;
      case 'k': event.preventDefault(); go(-1); break;
      case 'a': if (selected.length || current?.status === 'pending') { event.preventDefault(); const action = selected.length ? 'batch-accept' : 'accept'; intent === action ? void decide() : void begin(action); } break;
      case 'r': if (selected.length || current?.status === 'pending') { event.preventDefault(); void begin(selected.length ? 'batch-reject' : 'reject'); } break;
      case 'u': if (current?.status === 'accepted' && current.revertable) { event.preventDefault(); void begin('revert'); } break;
      case 'x': if (current?.status === 'pending') { event.preventDefault(); selected = toggleSelection(selected, current.id, 200); } break;
      case '[': case ']': {
        const all = [...region.querySelectorAll<HTMLElement>('.sbs-pane:first-child .drow, .dcol.inline .drow')];
        const starts = all.filter(row => row.matches('.add,.del') && !row.previousElementSibling?.matches('.add,.del'));
        if (!starts.length) break;
        event.preventDefault(); const at = starts.indexOf(document.activeElement as HTMLElement), direction = event.key === ']' ? 1 : -1;
        const next = starts[at < 0 ? direction > 0 ? 0 : starts.length - 1 : (at + direction + starts.length) % starts.length]; next.tabIndex = -1; next.focus(); break;
      }
    }
  }
</script>
<svelte:window on:keydown={keydown} />
<div class="review-page" data-detail={desiredId ? '' : undefined} bind:this={region}>
<div class="page-heading"><div><h1>Review</h1>{#if analyticsReturn}<a class="return-link" href={analyticsReturn}><Icon name="arrow-left" size={16} /> Back to {analyticsReturn.startsWith('#/improve') ? 'improve impact' : 'activity'}</a>{/if}</div><button class="btn-quiet" on:click={refresh} disabled={busy || loading}><Icon name="refresh" size={16} /> Refresh queue</button></div>
<div class="review-filters"><nav class="tabs" aria-label="Proposal status"><a class="tab" aria-current={status === 'pending' ? 'page' : undefined} href={proposalHref('', new URLSearchParams({ status: 'pending' }))}>Pending</a><a class="tab" aria-current={status === 'recent' ? 'page' : undefined} href={proposalHref('', new URLSearchParams({ status: 'recent' }))}>Recent decisions</a></nav>
<label>Source<select value={source} on:change={e => filter('source', e.currentTarget.value)}><option value="">All processes</option>{#each [...new Set([...Object.keys(queue?.bySource ?? {}), ...(source ? [source] : [])])] as s}<option value={s}>{s} ({queue?.bySource[s] ?? 0})</option>{/each}</select></label>
<label>Waiting age<select value={age} on:change={e => filter('age', e.currentTarget.value)}><option value="">Any age</option>{#each Object.entries(ageBands) as [key, label]}<option value={key}>{label}</option>{/each}</select></label>
</div>
{#if source || age || week || outcome}<p class="muted small active-filters">Active filters: {[source, age ? ageBands[age as keyof typeof ageBands] : '', week, outcome].filter(Boolean).join(' · ')} · <a href={proposalHref('', new URLSearchParams({ status }))}>Clear filters</a></p>{/if}
{#if queueError}<div class="notice notice-fail" role="alert">Queue could not refresh: {queueError} <button class="btn-secondary" on:click={load}>Retry queue</button></div>{/if}
{#if error}<div class="notice notice-fail" role="alert">{error}</div>{/if}
<div class="review review-workspace" data-detail={desiredId ? '' : undefined}><section class="review-list proposal-list" aria-label="Proposals">
{#if queue}<section class="queue-summary" aria-label="Queue summary"><p><strong class="num">{queue.fullCount ?? queue.totalCount}</strong> {status === 'pending' ? 'waiting for review' : 'recent decisions'}{#if source || age || week || outcome}<span class="muted"> · {queue.totalCount} match the filters</span>{/if}</p></section>{/if}

{#if status === 'pending' && queue?.proposals.length}<label class="select-all"><input type="checkbox" checked={queue.proposals.every(p => selected.includes(p.id))} disabled={busy} on:change={e => selected = e.currentTarget.checked ? queue!.proposals.map(p => p.id) : []} />Select all shown</label>{/if}
{#if loading && !queue}<p class="muted" role="status">Loading proposals…</p>{/if}
<ul class="review-items">{#each queue?.proposals ?? [] as p (p.id)}<li class="review-row" class:active={desiredId === p.id}>{#if status === 'pending'}<input type="checkbox" aria-label={`Select ${p.ref}`} checked={selected.includes(p.id)} disabled={busy} on:change={() => selected = toggleSelection(selected, p.id, 200)} />{/if}<a class="review-item" title={p.ref} aria-current={desiredId === p.id ? 'true' : undefined} href={proposalHref(p.id, query)}><strong>{title(p)}</strong><span class="queue-location">{conceptLocation(p.ref)}</span><span class="queue-meta"><span>{p.isRetire ? 'Retirement' : p.source}</span><time title={date(status === 'recent' ? record(p.review).decidedAt ?? p.updatedAt : p.waitingSince)}>{queueDate(status === 'recent' ? record(p.review).decidedAt ?? p.updatedAt : p.waitingSince)}</time></span>{#if status === 'recent'}<span class="small muted">{p.status}{record(p.review).reason ? ` · ${text(record(p.review).reason)}` : ''}</span>{/if}</a></li>{/each}</ul>
{#if queue && !queue.proposals.length}<div class="state"><h2>{source || age ? 'No proposals match these filters' : status === 'pending' ? 'Nothing waiting for review' : 'No recent decisions'}</h2><p class="muted">{source || age ? 'Clear a filter to inspect the rest of the queue.' : 'AKM’s recorded proposals appear here.'}</p></div>{/if}
{#if queue && queue.totalCount > queue.proposals.length}<p class="muted small">Showing the first {queue.proposals.length} of {queue.totalCount}. Narrow by source or waiting age.</p>{/if}<p class="muted small">{reviewed} reviewed this session.</p>
<div class="queue-utilities">{#if queue?.backlog?.length && status === 'pending'}<details><summary>By source and age</summary><p class="muted small">Age counts from the last reopening.</p><div class="table-wrap"><table><thead><tr><th>Process</th>{#each Object.values(ageBands) as label}<th>{label}</th>{/each}</tr></thead><tbody>{#each queue.backlog as row}<tr><th>{row.source}</th>{#each Object.keys(ageBands) as band}<td><a href={proposalHref('', new URLSearchParams({ source: row.source, age: band }))}>{row[band as keyof typeof row]}</a></td>{/each}</tr>{/each}</tbody></table></div></details>{/if}
<details class="shortcuts"><summary>Keyboard shortcuts</summary><label class="check-label"><input type="checkbox" bind:checked={shortcutsEnabled} /> Enable single-key shortcuts for this window</label><p class="muted small"><kbd>j</kbd>/<kbd>k</kbd> next/previous · <kbd>a</kbd> accept, again to confirm · <kbd>r</kbd> reject · <kbd>x</kbd> select · <kbd>u</kbd> undo confirmation · <kbd>[</kbd>/<kbd>]</kbd> changed blocks · <kbd>Esc</kbd> cancel. Accept and reject apply to the selection when items are selected. Shortcuts only work inside Review when you are not typing.</p></details></div>
</section><section class="review-pane inspector" aria-label="Proposal detail"><div class="review-scroll">
{#if opening}<p role="status" class="muted">Loading proposal…</p>{:else if detailError}<div class="notice notice-fail" role="alert">{detailError}<button class="btn-secondary" on:click={() => open(desiredId)}>Retry proposal</button></div>{:else if detail && current}
<nav class="crumbs proposal-back" aria-label="Proposal breadcrumb"><a href={proposalHref('', query)}>Back to queue</a></nav>
<header class="proposal-summary"><div class="proposal-title"><h2 bind:this={detailHeading} tabindex="-1">{title(current)}</h2><div class="badges"><span class="badge">{current.status}</span><span class="badge">{current.source}</span>{#if current.isRetire}<span class="badge">Retirement</span>{/if}</div></div>
<div class="proposal-location"><span class="mono wrap small">{current.ref}</span>{#if detail.diff?.isNew}<span class="muted small">New asset</span>{:else}<a class="target-link" href={`#/asset?ref=${encodeURIComponent(current.ref)}&view=files&returnTo=${encodeURIComponent(proposalHref(current.id, query))}`}>Open in Files</a>{/if}</div>
{#if current.reason}<p class="proposal-reason">{current.reason}</p>{/if}</header>
{#if record(detail.validation).ok === false}<p class="notice notice-warn" role="alert">Validation did not pass. Inspect the validation evidence below before deciding.</p>{/if}
{#if noop}<div class="notice notice-warn"><strong>This proposal changes nothing.</strong><p>Its proposed source matches the current asset. Reject it as a no-op to clear the queue, or accept anyway.</p></div>{/if}
<section aria-label="Proposed change"><h3>Proposed change</h3>{#if detail.diffError}<p class="notice notice-fail">Change preview unavailable: {detail.diffError}. AKM still validates a decision.</p>{/if}
{#if detail.diff}<Diff before={detail.diff.before} after={detail.diff.after} unified={detail.diff.unified ?? ''} redacted={detail.diff.redacted ?? false} truncated={detail.diff.truncated ?? false} />{:else}<p class="muted">No change preview is available.</p>{/if}</section>
{#key current.id}<ReviewEvidence {detail} />{/key}
{:else}<div class="state welcome"><h2>Select a proposal</h2><p>Inspect the source change and evidence before deciding.</p></div>{/if}
</div>
{#if current || intent || receipt || selected.length}<footer class="decision-shelf" aria-label="Proposal decision">
{#if receipt && (!receiptId || receiptId === current?.id || !current)}<section class="notice receipt" class:notice-warn={(receipt.failed ?? 0) > 0} class:notice-ok={!(receipt.failed ?? 0)} role="status" tabindex="-1" data-receipt><strong>Decision recorded</strong><p>{receipt.results ? `${receipt.accepted ?? receipt.rejected ?? 0} completed · ${receipt.failed ?? 0} failed. Failed items remain selected.` : `${receiptKind === 'revert' ? 'Reverted' : receiptKind === 'reopen' ? 'Reopened' : receiptKind === 'reject' ? 'Rejected' : 'Accepted'} ${receiptId}.`}</p>
{#if receiptKind === 'accept'}<p>{commitOutcome(receipt.commit)}</p>{/if}
{#if receipt.results}<ul class="plain">{#each receipt.results as r}<li><span class="badge">{r.ok ? 'Completed' : 'Failed'}</span> <a href={proposalHref(r.id, query)}>{r.ref ?? r.id}</a>{#if !r.ok} — {r.error ?? r.code} <code>{r.code ?? ''}</code>{/if}</li>{/each}</ul>{/if}
<div class="btn-row">{#if receiptId && receiptId !== current?.id && receiptKind === 'reject'}<button class="btn-secondary" on:click={() => receiptAction('reopen')}>Reopen…</button>{/if}{#if receiptId && receiptId !== current?.id && receiptKind === 'accept' && record(receipt.proposal).revertable}<button class="btn-secondary" on:click={() => receiptAction('revert')}>Undo…</button>{/if}<button class="btn-secondary" on:click={() => receipt = null}>Dismiss</button></div></section>{/if}
{#if selected.length && !intent}<div class="batch-bar"><strong>{selected.length} selected</strong><div class="btn-row"><button on:click={() => begin('batch-accept')} disabled={busy || locked}>Accept selected…</button><button class="btn-secondary" on:click={() => begin('batch-reject')} disabled={busy || locked}>Reject selected…</button><button class="btn-quiet" on:click={() => selected = []} disabled={busy}>Clear selection</button></div></div>{/if}
{#if intent}<section class="confirmation notice" aria-label="Confirm decision"><h2>{intent.includes('reject') ? 'Reject' : intent.includes('reopen') ? 'Reopen' : intent.includes('revert') ? 'Revert' : 'Accept'} {intent.startsWith('batch-') ? `${selected.length} selected proposals` : 'this proposal'}?</h2><p>{intent.includes('accept') ? 'Accepted content is written through AKM. Git-backed changes are committed and may be pushed. A batch can partially succeed.' : intent.includes('revert') ? 'Restore the backup retained when this proposal was accepted. AKM refuses to overwrite subsequent edits.' : intent.includes('reopen') ? 'Return this rejected proposal to the pending queue, if its target remains valid.' : 'Your reason is recorded for each rejection. Rejected proposals can be reopened if their targets remain valid.'}</p>
{#if intent.includes('reject')}<fieldset class="reason-chips"><legend>Why reject this proposal?</legend><div class="segmented">{#each rejectionChoices as chip}<label><input type="radio" name="reject-choice" value={chip} bind:group={choice} disabled={busy} /><span>{chip}</span></label>{/each}</div></fieldset><label>Rejection reason<textarea bind:value={reason} rows="3" maxlength="2000" disabled={busy} aria-describedby="reason-hint"></textarea></label><p class="muted small" id="reason-hint">{choice && choice !== 'Other' ? 'Details optional with a reason above.' : 'Choose a reason or write details. Other requires details.'} At most 2000 characters including the selected reason.</p>{/if}
<div class="btn-row"><button data-confirm disabled={busy || locked} on:click={decide}>{busy ? 'Recording…' : 'Confirm decision'}</button><button class="btn-secondary" disabled={busy} on:click={cancel}>Cancel</button></div></section>{/if}

{#if current && !intent && !selected.length}<div class="decision-row"><div class="decision-context"><span>{current.status === 'pending' ? 'Changes follow the bundle’s Git policy.' : 'Recorded outcome'}</span></div><div class="btn-row">{#if current.status === 'pending'}<button data-primary-decision disabled={busy || locked} data-decision="accept" on:click={() => begin('accept')}>Accept…</button><button class="btn-secondary" disabled={busy || locked} data-decision="reject" on:click={() => begin('reject')}>Reject…</button>{:else if current.status === 'rejected'}<button data-primary-decision disabled={busy || locked} data-decision="reopen" on:click={() => begin('reopen')}>Reopen…</button>{:else if current.status === 'accepted' && current.revertable}<button data-primary-decision disabled={busy || locked} data-decision="revert" on:click={() => begin('revert')}>Revert accepted change…</button>{/if}<button class="btn-quiet" aria-label={status === 'pending' ? 'Next pending' : 'Next decision'} disabled={busy || !queue?.proposals.some(p => p.id !== current?.id)} on:click={() => go(1)}>Next<span class="next-context">{status === 'pending' ? ' pending' : ' decision'}</span><Icon name="arrow-right" size={16} /></button></div></div>{/if}
</footer>{/if}
</section></div></div>
<style>
  .review-page { min-width:0; display:flex; flex-direction:column; height:100%; min-height:0; }
  .page-heading,.review-filters,.batch-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
  .page-heading { margin-bottom:.5rem; flex:none; } .page-heading h1 { margin:0; }
  .review-filters { justify-content:flex-start; align-items:center; margin-bottom:.5rem; flex:none; }
  .review-filters .tabs { margin:0; }
  .review-filters label { display:flex; align-items:center; gap:.5rem; font-size:.8125rem; }
  .shortcuts { font-size:.8125rem; } .shortcuts .check-label { display:flex; margin-block:.75rem; }
  .queue-utilities { margin-top:1.5rem; font-size:.8125rem; } .queue-utilities details { margin:.5rem 0; }
  .queue-meta { display:flex; justify-content:space-between; flex-wrap:wrap; gap:.25rem .5rem; color:var(--muted); font-size:.75rem; } .queue-meta time { white-space:nowrap; }
  .queue-location { color:var(--muted); font-size:.75rem; overflow-wrap:anywhere; }
  .review-workspace { display:grid; grid-template-columns:minmax(14rem,24%) minmax(0,1fr); gap:0; align-items:stretch; flex:1; min-height:0; margin:0; border-top:1px solid var(--border); }
  .review-workspace>.review-list { display:block; }
  .return-link { display:inline-block; font-size:.8125rem; margin-top:.5rem; }
  .review-list { min-width:0; margin:0; padding:1rem 1rem 1rem 0; overflow-y:auto; }
  .queue-summary { margin:0 0 1rem; font-size:.8125rem; } .queue-summary p { margin:0 0 .5rem; }
  .review-pane { min-width:0; min-height:0; margin:0; padding:0; border-left:1px solid var(--border); display:flex; flex-direction:column; }
  .review-scroll { flex:1; min-height:0; overflow-y:auto; padding:1rem 1.5rem 1.5rem; }
  .review-items { list-style:none; padding:0; margin:.5rem 0; }
  .review-row { display:flex; align-items:start; gap:.5rem; border-radius:6px; margin-bottom:.25rem; }
  .review-row>input { margin-top:1rem; }
  .review-item { display:grid; gap:.5rem; padding:.875rem .5rem; min-width:0; width:100%; color:inherit; text-decoration:none; }
  .review-item:hover,.review-row.active { background:var(--surface-2); } .review-item[aria-current] { box-shadow:inset 3px 0 var(--accent); }
  .review-item strong { font-size:.875rem; }
  .select-all { font-size:.8125rem; display:flex; gap:.5rem; align-items:center; }
  .proposal-back { display:none; }
  .proposal-summary { margin:0 0 1rem; }
  .proposal-title,.proposal-location { display:flex; align-items:center; gap:.5rem 1rem; flex-wrap:wrap; }
  .proposal-title h2 { font-size:1.25rem; margin:0; }
  .proposal-location { margin-top:.5rem; }
  .proposal-reason { margin:.75rem 0 0; font-size:.875rem; line-height:1.5; }
  .target-link { display:inline-block; font-size:.8125rem; }
  .review-scroll>section { margin-top:1rem; } .review-scroll h3 { font-size:.875rem; margin:0 0 .5rem; }
  .review-scroll :global(.change-preview) { margin-block-start:.75rem; }
  .decision-shelf { flex:none; border-top:1px solid var(--border); padding:1rem 1.5rem; background:var(--surface); max-height:55vh; overflow-y:auto; }
  .decision-row { display:flex; align-items:center; gap:1rem; justify-content:space-between; }
  .decision-context { flex:1; font-size:.75rem; color:var(--muted); min-width:0; }
  .btn-row { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
  .batch-bar { position:static; box-shadow:none; padding:0; border:0; margin:0; font-size:.8125rem; }
  .confirmation { margin:0; padding:0; border:0; background:none; box-shadow:none; } .confirmation h2 { font-size:1rem; margin-top:0; } .confirmation p { font-size:.8125rem; } .confirmation textarea { width:100%; box-sizing:border-box; }
  .receipt { margin:0 0 1rem; padding:1rem; } .receipt p,.receipt li { font-size:.8125rem; overflow-wrap:anywhere; }
  .table-wrap { overflow-x:auto; } .state { padding:2rem 1rem; } .wrap { overflow-wrap:anywhere; }
  .welcome { border:0; background:none; box-shadow:none; text-align:left; padding:2rem .5rem; }
  @media(max-width:1050px) { .review-workspace { grid-template-columns:14rem minmax(0,1fr); } .review-scroll { padding:1.25rem; } .decision-row { flex-wrap:wrap; } .decision-context { flex-basis:100%; } }
  @media(max-width:850px) { .review-workspace { display:block; min-height:0; } .review-list { padding-right:0; } .review-workspace[data-detail]>.review-list { display:none; } .review-workspace:not([data-detail]) .review-pane { border:0; } .review-pane { border-left:0; } .review-scroll { padding:1rem 0 2rem; overflow:visible; } .proposal-back { display:block; margin:0 0 1rem; } .decision-shelf { position:sticky; bottom:0; padding:1rem; z-index:2; } .review-filters { gap:.75rem; } .review-filters label { display:grid; gap:.3rem; flex:1; } .shortcuts { margin-inline-start:0; } }
  @media(max-width:850px),(max-height:700px) {
    .review-page[data-detail]>.review-filters,.review-page[data-detail]>.active-filters { display:none; }
    .decision-context { display:none; }
    .decision-row>.btn-row { width:100%; flex-wrap:nowrap; align-items:stretch; }
    .decision-row>.btn-row>button { flex:1; min-width:0; padding-inline:.5rem; }
    .next-context { display:none; }
    .decision-shelf { padding:.75rem; }
  }
  @media(min-width:851px) and (max-height:700px) {
    .review-page[data-detail]>.page-heading { display:none; }
    .review-workspace[data-detail] { display:block; }
    .review-workspace[data-detail]>.review-list { display:none; }
    .review-workspace[data-detail]>.review-pane { height:100%; border-left:0; }
    .proposal-back { display:block; margin:0 0 .5rem; }
    .review-scroll { padding:.75rem 0; }
    .proposal-summary { margin-bottom:.25rem; }
    .review-scroll>section { margin-top:.25rem; }
    .review-scroll :global(.change-preview) { margin-block-start:.25rem; }
  }
</style>

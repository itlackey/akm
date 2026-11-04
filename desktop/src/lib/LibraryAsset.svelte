<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { api, assetSource, date, bodyOf } from './client';
  import { documentTitle, libraryRead, typedLinks } from './library-model';
  import type { AssetRead, Improvement, SearchHit } from './library-model';
  import type { Bundle, History, Source, WriteResult } from './types';
  import { splitFrontmatter, headingId } from './upstream/markdown.js';
  import { sparkline } from './upstream/lib.js';
  import Markdown from './Markdown.svelte';
  import Diff from './Diff.svelte';
  import Icon from './Icon.svelte';
  import AssetRelated from './AssetRelated.svelte';
  import AssetOrganize from './AssetOrganize.svelte';
  import SensitiveAsset from './SensitiveAsset.svelte';
  export let ref: string;
  export let query = new URLSearchParams();
  export let returnTo = '#/search';
  export let bundles: Bundle[] = [];
  export let defaultWriteTarget = '';
  export let match: SearchHit | null = null;
  export let mode: 'search' | 'files' = 'search';
  export let filesHref = '';
  export let editHref = '';
  export let readingHref = '';
  const dispatch = createEventDispatcher<{ loaded: AssetRead; compare: string; comparePair: string[]; changed: void }>();
  type Retirement = { proposalId: string; ref: string; bundle: string; archiveDirs: string[]; warnings: string[] };
  let retired: Retirement | null = null, retireRevision = '';
  let data: AssetRead | null = null, improve: Improvement | null = null, history: History | null = null;
  let error = '', loading = false, tab = 'Read', busy = false, notice = '';
  let signal = 'positive', reason = '', tags = '', replace = '', replacement = '', fixReason = '', fixSource = '';
  let copying = false, target = '', newName = '', receipt: WriteResult | null = null;
  let more: HTMLElement, moreTrigger: HTMLButtonElement, copyDestination: HTMLSelectElement;
  let heading: HTMLHeadingElement, viewHeading: HTMLHeadingElement;
  let outlineOpen = false;
  let controller: AbortController, previous = '', generation = 0;
  // Library stays mounted when another primary section is selected. A top-layer
  // popover must not outlive its route, even when its ancestor becomes hidden.
  afterNavigate(() => { if (more?.isConnected && more.matches(':popover-open')) more.hidePopover(); });
  $: canonical = data?.durableRef ?? ref;
  $: pending = improve?.proposals.filter(p => p.status === 'pending') ?? [];
  $: viewTitle = ({ Move: 'Rename or move', Related: 'Related assets', Source: 'Markdown source', History: 'Document history', Details: 'Asset details', Feedback: 'Give feedback', Fix: 'Suggest a fix', Copy: 'Copy to a bundle' } as Record<string, string>)[tab] ?? '';
  $: editorHref = editHref || `#/edit?ref=${encodeURIComponent(canonical)}&returnTo=${encodeURIComponent(filesHref || returnTo)}&readingFrom=${encodeURIComponent(readingHref || `#/asset?ref=${encodeURIComponent(canonical)}&returnTo=${encodeURIComponent(returnTo)}`)}`;
  $: source = assetSource(data?.asset);
  $: fields = splitFrontmatter(source).fields;
  $: openingTitle = bodyOf(source).match(/^#[ \t]+([^\n]+)(?:\n|$)/)?.[1]?.trim();
  $: titleAnchor = openingTitle === documentTitle(data?.asset) && data?.headings?.[0]?.text === openingTitle ? headingId(data.headings[0].slug) : undefined;
  $: links = typedLinks(data?.asset.links);
  $: usageSpark = sparkline((improve?.usageByWeek ?? []).map((week) => week.hits), 'Weekly finds and opens, last 90 days');
  $: writable = bundles.filter((b) => b.enabled && b.writable && b.components.some((c) => c.adapter === 'akm'));
  $: sameBundle = target === (data?.bundle ?? data?.asset.origin);
  $: copyNameInvalid = sameBundle && (!newName.trim() || newName.trim() === canonical.split('/').at(-1));
  $: if (ref && ref !== previous) { previous = ref; load(ref); }
  $: if (query.get('section') && data) revealHeading(query.get('section')!);
  async function revealHeading(slug: string) { await tick(); document.getElementById(headingId(slug))?.scrollIntoView({ block: 'start' }); }
  async function load(selected: string) {
    retired = null; retireRevision = '';
    controller?.abort(); controller = new AbortController(); const request = ++generation;
    loading = true; error = ''; data = null; improve = null; history = null; tab = query.get('history') === '1' ? 'History' : 'Read'; notice = ''; receipt = null; copying = false; reason = ''; tags = ''; replace = ''; replacement = ''; fixReason = ''; fixSource = '';
    try {
      const read = await libraryRead<AssetRead>('/asset', { ref: selected }, controller.signal);
      if (request !== generation) return; data = read; dispatch('loaded', read);
      if (!read.redacted) {
        if (read.asset.editable && !['skill', 'secret', 'env', 'session'].includes(read.asset.type ?? ''))
          api<Source>('/asset/source', { ref: read.durableRef ?? selected }).then(source => { if (request === generation) retireRevision = source.revision; }).catch(() => {});
        libraryRead<Improvement>('/asset/improve', { ref: read.durableRef ?? selected }, controller.signal).then((next) => { if (request === generation) improve = next; }).catch(() => {});
        if (tab === 'History') await loadHistory();
      }
    } catch (e) { if ((e as Error).name !== 'AbortError' && request === generation) error = (e as Error).message; }
    finally {
      if (request === generation) {
        loading = false;
        await tick();
        if (request === generation && !query.get('section')) {
          heading?.focus({ preventScroll: true });
          heading?.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  }
  async function loadHistory(revision = '') {
    const request = generation;
    try { const read = await libraryRead<History>('/asset/history', { ref: canonical, revision }, controller?.signal); if (request === generation) history = read; }
    catch (e) { if ((e as Error).name !== 'AbortError' && request === generation) error = (e as Error).message; }
  }
  async function copyRef() { more.hidePopover(); try { await navigator.clipboard.writeText(canonical); notice = 'Reference copied.'; } catch { notice = 'Could not copy the reference.'; } await tick(); moreTrigger?.focus(); }
  async function retire() {
    if (busy || !retireRevision) return;
    more.hidePopover(); busy = true; error = '';
    const request = generation, selected = canonical;
    try {
      const result = await api<Retirement>('/asset/retire', {}, { ref: selected, revision: retireRevision });
      if (request === generation) retired = result;
      dispatch('changed');
    } catch (cause) { error = (cause as Error).message; } finally { busy = false; }
  }
  async function undoRetirement() {
    if (!retired || busy) return;
    busy = true; error = '';
    try {
      await api('/proposals/' + encodeURIComponent(retired.proposalId) + '/revert', {}, {});
      await load(ref); notice = 'Asset restored.';
      dispatch('changed');
    } catch (cause) { error = (cause as Error).message; } finally { busy = false; }
  }
  async function feedback(fix = false) {
    const selected = canonical, request = generation;
    busy = true; error = ''; notice = ''; receipt = null;
    try {
      const outcome = await api<WriteResult>('/feedback', {}, fix ? { ref: canonical, signal: 'negative', reason: fixReason, replace: [replace], with: [replacement], source: fixSource } : { ref: canonical, signal, reason, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) });
      if (request !== generation) return;
      receipt = outcome; notice = fix ? 'Suggested fix recorded for review.' : 'Feedback recorded.'; if (!fix) reason = '';
      const refreshed = await libraryRead<AssetRead>('/asset', { ref: selected }); if (request === generation) data = refreshed;
    } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
  async function copy() {
    if (copyNameInvalid) return;
    const request = generation;
    busy = true; error = ''; notice = ''; receipt = null;
    try { const outcome = await api<WriteResult>('/asset/copy', {}, { sourceRef: canonical, target, ...(newName ? { newName } : {}) }); if (request !== generation) return; receipt = outcome; notice = 'Copy completed without overwriting an existing asset.'; copying = false; tab = 'Read'; }
    catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
  async function closeCopy() { copying = false; tab = 'Read'; await tick(); moreTrigger?.focus(); }
  async function beginCopy() {
    more.hidePopover(); copying = true; tab = 'Copy'; newName = '';
    target = writable.find(b => b.name === defaultWriteTarget)?.name ?? writable[0]?.name ?? '';
    await tick(); copyDestination?.focus();
  }
  async function showView(view: string) {
    more?.hidePopover();
    tab = view;
    if (view === 'History') await loadHistory();
    await tick();
    const target = view === 'Read' ? heading : viewHeading;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }
  function compare() { more.hidePopover(); dispatch('compare', canonical); }
  function measureReader(node: HTMLElement) {
    let wide: boolean | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width >= 960;
      if (next !== wide) { wide = next; outlineOpen = next; }
    });
    observer.observe(node);
    return { destroy() { observer.disconnect(); } };
  }
  function assetHref(selected: string) {
    if (mode === 'files') {
      const params = selected === canonical ? new URLSearchParams(query) : new URLSearchParams();
      params.delete('section'); params.set('ref', selected); params.set('open', '1'); if (readingHref) params.set('readingFrom', readingHref);
      return `#/files?${params}`;
    }
    return `#/asset?ref=${encodeURIComponent(selected)}&returnTo=${encodeURIComponent(returnTo)}`;
  }
  onDestroy(() => controller?.abort());
</script>

{#if error}<div class="notice notice-warn" role="alert">{error}{#if !data}<p><button class="btn-secondary" on:click={() => load(ref)}>Retry loading asset</button></p>{/if}</div>{/if}
{#if loading}<p class="state" role="status">Loading asset…</p>
{:else if retired}
  <section class="retirement-receipt" aria-label="Retirement receipt">
    <h2>Asset archived</h2>
    <p>Recorded as an accepted retirement. Undo it here, or revert it later from Review.</p>
    <div class="page-actions"><button on:click={undoRetirement} disabled={busy}>{busy ? 'Restoring…' : 'Undo retirement'}</button><a class="btn btn-secondary" href={returnTo}>Back to {mode === 'files' ? 'folder' : 'results'}</a></div>
    {#each retired.warnings as warning}<p class="notice notice-warn">{warning}</p>{/each}
    <h3>Archive location</h3>
    {#each retired.archiveDirs as dir}<p class="mono wrap small">{retired.bundle}: {dir}</p>{/each}
  </section>
{:else if data}
  {#if data.redacted}{#key canonical}<SensitiveAsset ref={canonical} on:changed={() => dispatch('changed')} />{/key}
  {:else}
    {#if mode === 'search'}<div class="reader-navigation"><a href={returnTo}><Icon name="arrow-left" size={16} />Search results</a></div>{/if}
    <header class="asset-heading">
      <div class="asset-title-row">
        <h2 bind:this={heading} id={titleAnchor} tabindex="-1">{documentTitle(data.asset)}</h2>
        <div class="page-actions">
        {#if data.asset.editable && !['env', 'secret', 'session'].includes(data.asset.type ?? '')}<a class="btn btn-secondary" href={editorHref}><Icon name="edit" size={16} />Edit page</a>{/if}
        <div class="more-actions">
          <button type="button" class="more-trigger" bind:this={moreTrigger} popovertarget="asset-actions"><Icon name="more" size={18} />More</button>
          <div id="asset-actions" class="action-menu" popover="auto" role="group" aria-label="Page actions" bind:this={more}>
            <div class="menu-group" role="group" aria-label="Inspect page">
              <span class="menu-label">Inspect</span>
              <button on:click={() => showView('Source')}><Icon name="file" size={16} />Source</button>
              <button on:click={() => showView('History')}><Icon name="history" size={16} />History</button>
              <button on:click={() => showView('Details')}><Icon name="sliders" size={16} />Details</button>
            </div>
            <div class="menu-group" role="group" aria-label="Organize page">
              <span class="menu-label">Organize</span>
              <button on:click={compare}>Compare with another asset</button>
              <button on:click={copyRef}><Icon name="link" size={16} />Copy ref</button>
              {#if writable.length}<button on:click={beginCopy}><Icon name="copy" size={16} />Copy to bundle…</button>{/if}
              {#if data.asset.editable && !['env', 'secret', 'session', 'skill'].includes(data.asset.type ?? '')}
                <button on:click={() => showView('Move')}><Icon name="folder" size={16} />Rename or move…</button>
                <button on:click={retire} disabled={busy || !retireRevision} title="Move to the recoverable archive now"><Icon name="history" size={16} />Retire</button>
              {/if}
            </div>
          </div>
        </div>
        </div>
      </div>
      <div class="asset-context">
        <span>{data.bundle || data.asset.origin || 'Local'} · {data.asset.type}{!data.asset.editable ? ' · Read only' : ''}</span>
        {#if mode === 'search' && filesHref}<a href={filesHref}><Icon name="folder" size={15} />View in folder</a>{/if}
        <button class="text-action" on:click={() => showView('Related')}><Icon name="link" size={15} />Related assets</button>
        {#if pending.length}<a class="pending-review" href={'#/proposals/' + encodeURIComponent(pending[0].id)}>{pending.length} proposed {pending.length === 1 ? 'change' : 'changes'}</a>{/if}
      </div>
    </header>
    {#if notice}<div class="operation-notice" role="status">{notice}{#if receipt}<details><summary>Operation receipt</summary>{#each Object.entries(receipt).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)) as [key, value]}<p class="small wrap"><strong>{key}</strong>: {String(value)}</p>{/each}</details>{/if}</div>{/if}
    <div class="asset-main" use:measureReader>
      {#if tab !== 'Read'}<div class="view-heading"><h3 bind:this={viewHeading} tabindex="-1">{viewTitle}</h3><button class="text-action" on:click={() => showView('Read')}><Icon name="arrow-left" size={16} />Read</button></div>{/if}
      {#if tab === 'Read'}
        <div class="reading-layout" class:has-outline={(data.headings?.length ?? 0) > 1}>
        {#if (data.headings?.length ?? 0) > 1}<details class="heading-navigation" bind:open={outlineOpen}><summary>On this page</summary><ul>{#each data.headings ?? [] as h}<li><a href={assetHref(canonical) + '&section=' + encodeURIComponent(h.slug)}>{h.text}</a></li>{/each}</ul></details>{/if}
        <section class="document-body" aria-label="Content">
          {#if bodyOf(source).trim()}<Markdown content={source} omitHeading={documentTitle(data.asset)} ref={canonical} bundle={data.bundle ?? ''} links={data.links ?? {}} headings={data.headings ?? []} />
          {:else}<p class="state">This asset has no body.</p>{/if}
        </section>
        </div>
        <div class="reading-feedback"><span>Help improve this page</span><button class="text-action" on:click={() => showView('Feedback')}>Add feedback</button>{#if data.durableRef}<button class="text-action" on:click={() => showView('Fix')}>Suggest a correction</button>{/if}</div>
      {:else if tab === 'Move'}
        {#key canonical}<AssetOrganize ref={canonical} {bundles} on:changed={() => dispatch('changed')} />{/key}
      {:else if tab === 'Related'}
        {#key canonical}<AssetRelated ref={canonical} links={data.asset.links} href={assetHref} on:compare={event => dispatch('comparePair', event.detail)} />{/key}
      {:else if tab === 'Source'}
        <pre class="code raw-source" role="group" aria-label="Markdown source">{source || 'This asset has no body.'}</pre>
      {:else if tab === 'History'}
        {#if !history}<p class="muted">Reading history…</p>
        {:else if !history.available}<p class="state">No Git history is available for this bundle. General manual-edit undo is not available for a non-Git source.</p>
        {:else}
          <ul class="history-list">{#each history.commits as c}<li><button class="btn-secondary" on:click={() => loadHistory(c.sha)}>{c.sha.slice(0, 8)}</button><div>{c.subject}<p class="muted small">{date(c.time)} · {c.author}</p></div></li>{/each}</ul>
          {#if !history.commits.length}<p class="muted">No committed versions of this file.</p>{/if}
          {#if history.diff}<Diff before={history.diff.before} after={history.diff.after} unified={history.diff.unified ?? ''} truncated={history.diff.truncated ?? false} redacted={history.diff.redacted ?? false} />{/if}
        {/if}
      {:else if tab === 'Copy' && copying}
        <form class="task-form form-grid" on:submit|preventDefault={copy}>
          <p class="muted">The original stays unchanged. Existing files are never overwritten.</p>
          <label>Destination bundle<select bind:this={copyDestination} bind:value={target}>{#each writable as b}<option value={b.name}>{b.name}</option>{/each}</select></label>
          <label>New name {sameBundle ? '(required in this bundle)' : '(optional)'}<input bind:value={newName} required={sameBundle} aria-describedby="copy-name-hint" /></label>
          <p id="copy-name-hint" class="muted small">{sameBundle ? 'Choose a different name to keep both copies in this bundle.' : 'Leave blank to keep the original name.'}</p>
          <div class="task-submit"><button disabled={busy || copyNameInvalid}>Confirm copy</button><button type="button" class="text-action" on:click={closeCopy}>Cancel</button></div>
          <p class="muted small">The destination’s AKM write and Git publication policy applies.</p>
        </form>
      {:else if tab === 'Feedback'}
        <section class="feedback-view" id="asset-feedback" aria-label="Feedback">
          <form class="task-form form-grid" on:submit|preventDefault={() => feedback()}>
            <label>How was this page?<select bind:value={signal}><option value="positive">Helpful</option><option value="negative">Incorrect or stale</option></select></label>
            <label>Reason<textarea bind:value={reason} rows="3" required={signal === 'negative' && data.feedbackRequireReason}></textarea></label>
            <p class="muted small">Choose “Incorrect or stale” for content problems, not simply a poor match for your task.</p>
            <label>Tags <span class="muted">(optional)</span><input bind:value={tags} placeholder="key:value tags, comma-separated" /></label>
            <div class="task-submit"><button disabled={busy}>Record feedback</button><button type="button" class="text-action" on:click={() => showView('Read')}>Cancel</button></div>
          </form>
          <section class="feedback-history"><h3>Feedback history</h3><p class="muted small"><strong>{data.feedback?.counts.positive ?? 0}</strong> positive · <strong>{data.feedback?.counts.negative ?? 0}</strong> negative</p>
          {#if data.feedback?.history.length}<div class="table-wrap"><table><thead><tr><th>When</th><th>Signal</th><th>Source</th><th>Reason / tags</th></tr></thead><tbody>{#each data.feedback.history as event}<tr><td>{date(event.at)}</td><td>{event.signal}</td><td>{event.source}</td><td>{event.reason ?? ''} {(event.tags ?? []).join(', ')}</td></tr>{/each}</tbody></table></div>{:else}<p class="muted small">No feedback recorded for this asset.</p>{/if}</section>
        </section>
      {:else if tab === 'Fix' && data.durableRef}
        <form class="task-form form-grid" id="asset-fix" on:submit|preventDefault={() => feedback(true)}>
          <p class="muted">Propose a specific correction for review. This does not edit the original page.</p>
          <label>Replace this exact text<textarea bind:value={replace} required rows="3"></textarea></label>
          <label>With<textarea bind:value={replacement} required rows="3"></textarea></label>
          <label>Why<input bind:value={fixReason} required /></label>
          <label>Source <span class="muted">(optional)</span><input bind:value={fixSource} placeholder="URL, command, or file that shows it" /></label>
          <p class="muted small">The original text must appear exactly once in the source.</p>
          <div class="task-submit"><button disabled={busy}>Send suggested fix</button><button type="button" class="text-action" on:click={() => showView('Read')}>Cancel</button></div>
        </form>
      {:else if tab === 'Details'}
        <div class="asset-details">
          {#if improve?.proposals.some(p => p.status === 'pending')}<section><h3>Pending changes</h3><ul>{#each improve.proposals.filter(p => p.status === 'pending') as p}<li><a href={'#/proposals/' + encodeURIComponent(p.id)}>{p.id}</a> · {p.source}</li>{/each}</ul></section>{/if}
          <dl class="asset-definition"><dt>Name</dt><dd>{data.asset.name}</dd><dt>Durable ref</dt><dd class="mono wrap">{data.durableRef ?? 'Not indexed'}</dd><dt>Path</dt><dd class="mono wrap">{data.asset.path ?? 'Not returned'}</dd></dl>
          {#if match}<section><h3>Search match</h3>{#if match.description}<p>{match.description}</p>{/if}{#if typeof match.score === 'number'}<p class="muted small">Search score: {match.score.toFixed(3)}</p>{/if}{#if match.tags?.length}<p>{match.tags.join(' · ')}</p>{/if}</section>{/if}
          {#if fields.length}<section><h3>Frontmatter</h3><div class="table-wrap"><table class="fm"><tbody>{#each fields as [key, value]}<tr><th scope="row">{key}</th><td class="wrap pre-wrap">{value}</td></tr>{/each}</tbody></table></div></section>{/if}
          {#if links.length}<section><h3>Links</h3><div class="table-wrap"><table><thead><tr><th>Direction</th><th>Kind</th><th>Assets</th></tr></thead><tbody>{#each links as row}<tr><td>{row.direction}</td><td>{row.kind}</td><td>{#each row.refs as linked}<p><a class="mono wrap" href={assetHref(linked)}>{linked}</a></p>{/each}{#if row.total > row.refs.length}<span class="muted">{row.total} total</span>{/if}</td></tr>{/each}</tbody></table></div></section>{/if}
          <section><h3>Usage and review history</h3>{#if improve}<div class="usage-spark">{@html typeof usageSpark === 'string' ? usageSpark : usageSpark.text}</div><p class="muted small">{improve.usageByWeek.reduce((sum, w) => sum + w.hits, 0)} finds and opens · last 90 days</p><h4>Recent decisions</h4><ul class="plain">{#each improve.proposals.filter(p => p.status !== 'pending').slice(0, 5) as p}<li class="small"><a href={'#/proposals/' + encodeURIComponent(p.id)}>{p.outcome === 'you' ? 'Accepted by you' : p.outcome === 'judge' ? 'Accepted by judge' : p.outcome === 'unknown' ? 'Accepted · reviewer unknown' : p.outcome}</a> · {p.source} <span class="muted">{date(p.decidedAt)}</span></li>{/each}</ul>{#if !improve.proposals.length}<p class="muted small">No proposals recorded for this asset.</p>{/if}{:else}<p class="muted small">Usage and proposal context unavailable.</p>{/if}</section>
        </div>
      {/if}
    </div>
  {/if}
{/if}
<style>
  .retirement-receipt{max-width:760px;padding:24px 0}.retirement-receipt>p{line-height:1.65}.retirement-receipt h3{margin-top:32px;font-size:15px}.retirement-receipt .page-actions{justify-content:flex-start;margin-top:24px;gap:12px}
  .reader-navigation{display:flex;align-items:center;gap:16px;margin:0 0 16px;font-size:13px}
  .reader-navigation>a{display:inline-flex;align-items:center;gap:8px;min-height:var(--control-height,40px);color:var(--muted);font-weight:500;text-decoration:none}
  .reader-navigation>a:hover{color:var(--text)}
  .asset-heading{margin-bottom:32px}
  .asset-title-row{display:flex;align-items:start;justify-content:space-between;gap:24px}
  .asset-heading h2{font-size:clamp(26px,2.5vw,34px);line-height:1.25;letter-spacing:-.025em;margin:0;overflow-wrap:anywhere}
  .page-actions{display:flex;align-items:center;gap:8px;flex:none}
  .page-actions>.btn{white-space:nowrap}
  .asset-heading h2[tabindex="-1"]:focus{outline:none}
  .asset-context{display:flex;align-items:center;flex-wrap:wrap;gap:4px 20px;margin-top:12px;font-size:13px;color:var(--muted)}
  .asset-context>a{display:inline-flex;align-items:center;gap:6px;min-height:32px;font-weight:400;color:var(--muted);text-decoration:none}
  .asset-context>a:hover{color:var(--accent)}.asset-context>.pending-review{font-weight:400;color:var(--accent)}
  .more-actions{position:relative;border:0;background:none;padding:0}
  .more-trigger{display:flex;align-items:center;gap:6px;padding:8px 10px;min-height:var(--control-height,40px);border:0;background:none;color:var(--muted);font-size:13px;font-weight:500;border-radius:6px;anchor-name:--asset-actions}
  .action-menu{position:fixed;position-anchor:--asset-actions;position-area:bottom span-left;position-try-fallbacks:flip-block,flip-inline;inset:auto;justify-self:end;margin:8px 0;width:248px;max-width:calc(100vw - 24px);max-height:min(calc(100% - 16px),calc(100dvh - 24px));overflow:auto;padding:6px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgb(0 0 0 / .12)}
  .action-menu button{display:flex;align-items:center;justify-content:start;gap:8px;min-height:var(--control-height,40px);width:100%;text-align:left;background:none;border:0;color:var(--text);padding:8px 10px;font-size:13px;font-weight:400}
  .menu-group+.menu-group{border-top:1px solid var(--border);padding-top:6px;margin-top:6px}.menu-label{display:block;color:var(--muted);font-size:11px;padding:6px 10px}
  .action-menu button:hover{background:var(--surface-2)}
  .asset-main{min-width:0;container-type:inline-size}.document-body{max-width:76ch;font-size:16px;line-height:1.75;margin:0;min-width:0}
  .document-body :global(.md){padding:0;border:0;background:none}
  .document-body :global(blockquote){border-inline-start:2px solid var(--border-strong);padding:8px 20px;margin:24px 0;color:var(--muted)}
  .document-body :global(.markdown>p:first-child){margin-top:0}
  .document-body :global(.markdown h2){margin-top:32px}
  .view-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.view-heading h3{margin:0;font-size:20px}
  .text-action{display:inline-flex;align-items:center;gap:8px;background:none;border:0;color:var(--accent);font-size:13px;min-height:var(--control-height,40px);padding:6px 0}
  .heading-navigation{border:0;background:none;margin:0 0 24px;padding:0}
  .heading-navigation>summary{min-height:var(--control-height,36px);padding:8px 0;background:none;border:0;font-size:12px;color:var(--muted)}
  .heading-navigation ul{list-style:none;padding:0;margin:8px 0 0}.heading-navigation li{margin:0 0 8px;font-size:13px;line-height:1.5}.heading-navigation a{display:block;padding:4px 0;color:var(--muted)}.heading-navigation a:hover{color:var(--accent)}
  @container(min-width:960px){.reading-layout.has-outline{display:grid;grid-template-columns:minmax(0,76ch) minmax(150px,1fr);gap:48px}.document-body{grid-row:1;grid-column:1}.heading-navigation{grid-row:1;grid-column:2;align-self:start;position:sticky;top:24px;margin:0}.heading-navigation>summary{font-weight:600;font-size:12px}}
  .raw-source{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
  .task-form{max-width:640px;gap:20px;margin:0}.task-form>p{margin:0}.task-submit{display:flex;align-items:center;gap:20px}.feedback-view{margin:0}.feedback-history{margin-top:40px;border-top:1px solid var(--border);padding-top:24px}.feedback-history h3{margin:0}.reading-feedback{display:flex;align-items:center;flex-wrap:wrap;gap:8px 20px;max-width:76ch;margin-top:40px;padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--muted)}.reading-feedback .text-action{font-size:12px}
  .operation-notice{font-size:13px;margin:0 0 20px;color:var(--ok)}.operation-notice details{margin-top:12px}
  .asset-definition{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px 24px;font-size:13px;margin:0 0 32px}.asset-definition dt{color:var(--muted)}.asset-definition dd{margin:0}
  .asset-details{max-width:880px}.asset-details>section{margin-top:32px}.asset-details h3{font-size:17px;margin:0 0 16px}.asset-details h4{font-size:14px;margin:24px 0 12px}.asset-details table{font-size:13px}
  .history-list{list-style:none;padding:0}.history-list li{display:flex;gap:16px;align-items:start;margin-bottom:20px}.history-list p{margin:4px 0}
  @media(max-width:850px){.reader-navigation{margin-bottom:16px}.asset-heading h2{font-size:28px}.asset-title-row{flex-wrap:wrap;gap:16px}.page-actions{margin-left:auto}.asset-context{gap:4px 16px}.asset-definition{grid-template-columns:1fr;gap:4px}.asset-definition dd{margin-bottom:12px}.reading-feedback{gap:4px 16px}.reading-feedback>span{flex-basis:100%}}
</style>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { api } from './client';
  import type { Bundle } from './types';
  import Diff from './Diff.svelte';
  const dispatch = createEventDispatcher<{ changed: void }>();
  export let ref: string;
  export let bundles: Bundle[];
  export let type = '';
  let bundle = ref.split('//')[0], name = ref.split('//')[1]?.split('/').slice(1).join('/') ?? '', fixLinks = true;
  let busy = false, error = '', selected = 0;
  type Preview = { revision: string; ref: string; warnings: string[]; changes: Array<{ from: string; to: string; bundle: string; before: string; after: string }> };
  type Result = { ref: string; complete: boolean; location: { bundle: string; path: string; parent: string }; warnings: string[]; recoveries: string[]; changedFiles: number; checks: Array<{ bundle: string; issues: Array<{ file: string; detail: string }> }> };
  let preview: Preview | null = null, result: Result | null = null;
  const parameters = () => ({ ref, bundle, name, fixLinks });
  $: skill = type === 'skill';
  $: writable = bundles.filter(bundle => bundle.enabled && bundle.writable && (!skill || bundle.name !== ref.split('//')[0]) && bundle.components.some(component => component.adapter === 'akm'));
  $: if (skill && bundle === ref.split('//')[0]) bundle = writable[0]?.name ?? '';
  async function prepare() {
    busy = true; error = ''; preview = null;
    try { preview = await api<Preview>('/asset/move/preview', {}, parameters()); selected = 0; }
    catch (cause) { error = (cause as Error).message; } finally { busy = false; }
  }
  async function apply() {
    if (!preview) return;
    busy = true; error = '';
    try { result = await api<Result>('/asset/move', {}, { ...parameters(), revision: preview.revision }); preview = null; dispatch('changed'); }
    catch (cause) { error = (cause as Error).message; preview = null; } finally { busy = false; }
  }
</script>

{#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
{#if result}
  <section class="operation-result" aria-label="Move result">
    <h4>{result.complete ? 'Move completed' : 'Move needs attention'}</h4>
    <p>{result.changedFiles} files involved. AKM checked the affected bundles.</p>
    {#if result.complete}<a class="btn" href={'#/files?' + new URLSearchParams({ bundle: result.location.bundle, path: result.location.parent, file: result.location.path, ref: result.ref, open: '1', saved: '1' })}>Open moved asset</a>{/if}
    {#if result.warnings.length}<ul class="muted small">{#each result.warnings as warning}<li>{warning}</li>{/each}</ul>{/if}
    {#each result.checks as check}
      <p class="small">{check.bundle}: {check.issues.length ? check.issues.length + ' links or files need review' : 'no link issues reported by AKM'}.</p>
      {#if check.issues.length}<ul class="small">{#each check.issues as issue}<li><span class="mono wrap">{issue.file}</span> — {issue.detail}</li>{/each}</ul>{/if}
    {/each}
    <details><summary>Recovery copies</summary><p class="small">Each recovery directory contains the original files and restore.json describing their paths. Review before restoring; never overwrite newer work.</p>{#each result.recoveries as recovery}<p class="mono wrap small">{recovery}</p>{/each}</details>
  </section>
{:else}
  <form class="organize-form" on:submit|preventDefault={prepare} on:input={() => preview = null} on:change={() => preview = null}>
    <div class="destination-fields"><label>Bundle<select bind:value={bundle} disabled={busy}>{#each writable as target}<option value={target.name}>{target.name}</option>{/each}</select></label><label>Name or folder/name<input bind:value={name} required disabled={busy || skill} /></label></div>
    <p class="muted small">{skill ? 'Moves the complete skill folder, including scripts, references and other supporting files. The folder name stays the same.' : 'Keeps the asset type and existing file extension.'}</p>
    <label class="check-line"><input type="checkbox" bind:checked={fixLinks} disabled={busy} />Repair supported links in indexed Markdown files</label>
    <p class="identity-note">Moving changes the asset’s reference. Existing usage, feedback and proposal history do not transfer to the new identity.</p>
    <div><button class="btn-secondary" disabled={busy || !bundle}>{busy ? 'Working…' : 'Preview changes'}</button></div>
  </form>
  {#if preview}
    <section class="move-preview" aria-label="Move preview">
      <header><div><h4>{preview.changes.length} affected {preview.changes.length === 1 ? 'file' : 'files'}</h4><p class="mono wrap small">{preview.ref}</p></div><button disabled={busy} on:click={apply}>{busy ? 'Moving…' : 'Confirm move'}</button></header>
      <p class="muted small">Originals are kept in .akm/desktop-moves/. AKM’s configured Git and indexing policies apply, including provider calls if embeddings are enabled.</p>
      <ul class="muted small">{#each preview.warnings as warning}<li>{warning}</li>{/each}</ul>
      <label>Inspect file<select bind:value={selected}>{#each preview.changes as change, index}<option value={index}>{change.bundle} / {change.from}{change.from !== change.to ? ' → ' + change.to : ' (links)'}</option>{/each}</select></label>
      {#if preview.changes[selected]}{@const change = preview.changes[selected]}<Diff before={change.before} after={change.after} beforeLabel={change.from} afterLabel={change.to} />{/if}
    </section>
  {/if}
{/if}

<style>
  .organize-form{max-width:760px;display:grid;gap:20px}.organize-form>p{margin:0;line-height:1.65}.organize-form label,.move-preview>label{display:grid;gap:8px;font-size:13px;font-weight:550}
  .destination-fields{display:grid;grid-template-columns:1fr 2fr;gap:20px}.organize-form .check-line{display:flex;align-items:center;gap:10px;font-weight:400}.check-line input{width:16px;height:16px}
  .identity-note{color:var(--muted);font-size:13px;padding:16px 0;border-block:1px solid var(--border)}
  .move-preview{margin-top:32px;padding-top:24px;border-top:1px solid var(--border)}.move-preview header{display:flex;align-items:center;justify-content:space-between;gap:24px}.move-preview h4,.operation-result h4{font-size:18px;margin:0}.move-preview>label{margin:24px 0}
  .move-preview li,.operation-result li{margin:8px 0;line-height:1.5}.operation-result details{margin-top:24px}.operation-result summary{cursor:pointer}
  @media(max-width:700px){.destination-fields{grid-template-columns:1fr}.move-preview header{align-items:stretch;flex-direction:column}}
</style>

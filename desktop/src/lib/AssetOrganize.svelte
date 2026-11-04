<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { api } from './client';
  import type { Bundle, Source } from './types';
  const dispatch = createEventDispatcher<{ changed: void }>();
  export let ref: string;
  export let bundles: Bundle[];
  let bundle = ref.split('//')[0], name = ref.split('//')[1]?.split('/').slice(1).join('/') ?? '';
  let busy = false, error = '';
  type Moved = { ref: string; proposalId?: string; retireError?: string };
  let moved: Moved | null = null;
  $: writable = bundles.filter(bundle => bundle.enabled && bundle.writable && bundle.components.some(component => component.adapter === 'akm'));
  $: unchanged = bundle === ref.split('//')[0] && name.trim() === (ref.split('//')[1]?.split('/').slice(1).join('/') ?? '');
  // A move is AKM's copy, then AKM's retire of the original, so the original is recoverable from Review.
  async function move() {
    busy = true; error = ''; moved = null;
    try {
      const { revision } = await api<Source>('/desktop/file', { ref });
      const copy = await api<{ destination: { ref?: string } }>('/asset/copy', {}, { sourceRef: ref, target: bundle, newName: name.trim() });
      const destination = copy.destination.ref ?? bundle + '//' + ref.split('//')[1]!.split('/')[0] + '/' + name.trim();
      try {
        const retired = await api<{ proposalId: string }>('/asset/retire', {}, { ref, revision });
        moved = { ref: destination, proposalId: retired.proposalId };
      } catch (cause) { moved = { ref: destination, retireError: (cause as Error).message }; }
      dispatch('changed');
    } catch (cause) { error = (cause as Error).message; } finally { busy = false; }
  }
</script>

{#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
{#if moved}
  <section class="operation-result" aria-label="Move result">
    <h4>{moved.retireError ? 'Copied; the original needs attention' : 'Move completed'}</h4>
    {#if moved.retireError}<p class="notice notice-warn">The copy was made, but the original could not be retired: {moved.retireError} Retire it from its page when ready.</p>
    {:else}<p>Copied to the new name, then the original was retired. Undo the retirement from <a href={'#/proposals/' + encodeURIComponent(moved.proposalId ?? '')}>Review</a>; the copy stays in place.</p>{/if}
    <a class="btn" href={'#/asset?ref=' + encodeURIComponent(moved.ref)}>Open the copy</a>
  </section>
{:else}
  <form class="organize-form" on:submit|preventDefault={move}>
    <div class="destination-fields"><label>Bundle<select bind:value={bundle} disabled={busy}>{#each writable as target}<option value={target.name}>{target.name}</option>{/each}</select></label><label>Name or folder/name<input bind:value={name} required disabled={busy} /></label></div>
    <p class="muted small">Copies the asset to the new bundle and name, then retires the original. Nothing is overwritten and links to the old name are not rewritten.</p>
    <p class="identity-note">Moving changes the asset’s reference. Existing usage, feedback and proposal history do not transfer to the new identity.</p>
    <div><button disabled={busy || unchanged || !bundle || !name.trim()}>{busy ? 'Moving…' : 'Move'}</button></div>
  </form>
{/if}

<style>
  .organize-form{max-width:760px;display:grid;gap:20px}.organize-form>p{margin:0;line-height:1.65}.organize-form label{display:grid;gap:8px;font-size:13px;font-weight:550}
  .destination-fields{display:grid;grid-template-columns:1fr 2fr;gap:20px}
  .identity-note{color:var(--muted);font-size:13px;padding:16px 0;border-block:1px solid var(--border)}
  .operation-result h4{font-size:18px;margin:0}
  @media(max-width:700px){.destination-fields{grid-template-columns:1fr}}
</style>

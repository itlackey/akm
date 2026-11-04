<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api } from './client';
  import Icon from './Icon.svelte';
  type Harness = { id: string; installed: boolean; runnable?: boolean; version?: string; path?: string; major?: number;
    plugin?: { state: string; version?: string; spec?: string; note?: string } };
  type Snapshot = {
    desktop: { version?: string; supported: boolean; phase: string; reason?: string; error?: string; progress?: number;
      availableVersion?: string; checkedAt?: string; repository?: string;
      menu?: { supported: boolean; installed: boolean; busy: boolean; runningInstalledCopy?: boolean; replacesExistingCopy?: boolean; appImage?: string; error?: string };
      settings: { automatic: boolean; authenticated: boolean; remembered: boolean; canRemember: boolean; error?: string } };
    host: { phase: string; cli: Harness | null; harnesses: Harness[]; error?: string; receipt?: string; checkedAt?: string; command?: string;
      upgrade?: { latestVersion?: string; currentVersion?: string; updateAvailable?: boolean; installMethod?: string; channel?: string } };
  };
  let data: Snapshot | null = null, error = '', submitting = false, token = '', remember = true, channel = 'latest';
  let timer: ReturnType<typeof setInterval>, alive = true;
  let editingConnection = false;
  const names: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', opencode2: 'OpenCode 2' };
  $: hostBusy = submitting || Boolean(data && data.host.phase !== 'idle');
  $: updateBusy = submitting || Boolean(data && (['checking', 'downloading'].includes(data.desktop.phase) || data.desktop.menu?.busy));
  async function refresh() {
    try { const next = await api<Snapshot>('/desktop/software'); if (alive) data = next; }
    catch (cause) { if (alive) error = (cause as Error).message; }
  }
  async function act(action: string, details: Record<string, unknown> = {}) {
    submitting = true; error = '';
    try { await api('/desktop/software', {}, { action, ...details }); if (action === 'desktop-settings') { token = ''; editingConnection = false; } await refresh(); }
    catch (cause) { error = (cause as Error).message; }
    finally { submitting = false; }
  }
  onMount(async () => {
    await refresh();
    if (!alive) return;
    if (!data?.host.cli && data?.host.phase === 'idle') await act('check');
    timer = setInterval(() => void refresh(), 2000);
  });
  onDestroy(() => { alive = false; clearInterval(timer); });
  function desktopLabel() {
    if (!data) return 'Loading…';
    const { desktop } = data;
    if (!desktop.supported) return 'AppImage required';
    if (desktop.phase === 'ready') return `${desktop.availableVersion} ready · installs when you quit`;
    if (desktop.phase === 'downloading') return `Downloading ${desktop.availableVersion ?? ''}${desktop.progress === undefined ? '' : ` · ${desktop.progress}%`}`;
    if (desktop.phase === 'checking') return 'Checking…';
    if (desktop.phase === 'error') return 'Needs attention';
    if (!desktop.settings.authenticated) return 'Connect private repository';
    return desktop.phase === 'current' ? 'Up to date' : 'Ready to check';
  }
</script>

<div class="software">
  <div class="intro"><h2>Software</h2><p class="muted">Desktop, host CLI and integrations on this computer.</p></div>
  {#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
  {#if !data}<p role="status">Loading software status…</p>{:else}
    <section aria-labelledby="desktop-software">
      <div class="software-row">
        <div><h3 id="desktop-software">AKM Desktop <span class="muted mono">{data.desktop.version ?? ''}</span></h3><p role="status">{desktopLabel()}</p></div>
        {#if data.desktop.supported}<button class="btn-secondary icon-label" disabled={updateBusy || !data.desktop.settings.authenticated || data.desktop.phase === 'ready'} on:click={() => act('desktop-check')}><Icon name="refresh" />Check for update</button>{/if}
      </div>
      {#if data.desktop.progress !== undefined}<progress value={data.desktop.progress} max="100" aria-label="Desktop download progress"></progress>{/if}
      {#if data.desktop.menu?.supported}
        <div class="menu-install">
          <div class="software-row">
            <div><h4>Application menu</h4><p role="status">{data.desktop.menu.busy ? 'Installing menu entry…' : data.desktop.menu.installed ? 'Added to your application menu' : 'Open AKM Desktop without finding the download.'}</p></div>
            <button class="btn-secondary" disabled={updateBusy || data.desktop.phase === 'ready' || data.desktop.phase === 'installing'} on:click={() => act('desktop-menu-install')}>
              {data.desktop.menu.installed ? data.desktop.menu.runningInstalledCopy ? 'Repair menu entry' : 'Replace menu copy…' : 'Add to application menu'}
            </button>
          </div>
          {#if data.desktop.menu.installed && !data.desktop.menu.runningInstalledCopy}<p class="field-hint">Close this download and open AKM Desktop from your application menu. Updates will then apply to that installed copy.</p>
          {:else if !data.desktop.menu.installed}<p class="field-hint">Installs a copy for your account only. No administrator password needed; the download stays where it is.</p>{/if}
          {#if ['checking', 'downloading', 'ready', 'installing'].includes(data.desktop.phase)}<p class="field-hint">Finish the desktop update and reopen the app before installing a menu copy.</p>{/if}
          {#if data.desktop.menu.error}<p class="notice notice-warn" role="alert">{data.desktop.menu.error}</p>{/if}
        </div>
      {/if}
      {#if data.desktop.error || data.desktop.settings.error}<p class="notice notice-warn" role="alert">{data.desktop.error ?? data.desktop.settings.error}</p>{/if}
      {#if !data.desktop.supported}<p class="muted">{data.desktop.reason}</p>{:else}
      <label class="check-label"><input type="checkbox" checked={data.desktop.settings.automatic} disabled={updateBusy || !data.desktop.supported || data.desktop.phase === 'ready'} on:change={event => act('desktop-settings', { settings: { automatic: event.currentTarget.checked } })} /> Download desktop updates automatically</label>
      <p class="field-hint">Checks at launch and every four hours. Installs after you close the app, without interrupting your work.</p>
      {#if data.desktop.settings.authenticated && !editingConnection}
        <div class="connection-status"><span class="icon-label"><Icon name="check" /><span>Private updates connected <span class="muted small">{data.desktop.settings.remembered ? '· Saved in system keyring' : '· This session only'}</span></span></span><button class="btn-quiet" disabled={updateBusy || data.desktop.phase === 'ready'} on:click={() => editingConnection = true}>Change connection</button></div>
      {:else}
      <div class="connection">
        <h4>{data.desktop.settings.authenticated ? 'Change update connection' : 'Connect private updates'}</h4>
        <form on:submit|preventDefault={() => act('desktop-settings', { settings: { token, remember: remember && data!.desktop.settings.canRemember } })}>
          <p>Use a Gitea token with read-only repository access to <a href="https://code.lab.fwdslsh.dev/fwdslsh/akm-desktop" target="_blank" rel="noreferrer">fwdslsh/akm-desktop</a>.</p>
          <label class="field">Repository token<input type="password" bind:value={token} autocomplete="off" required /></label>
          {#if data.desktop.settings.canRemember}<label class="check-label"><input type="checkbox" bind:checked={remember} /> Remember with the system keyring</label>
          {:else}<p class="field-hint">No system keyring is available. The token will be used for this session only.</p>{/if}
          <div class="btn-row"><button disabled={updateBusy || !data.desktop.supported || !token.trim() || data.desktop.phase === 'ready'}>Connect updates</button>{#if data.desktop.settings.authenticated}<button type="button" class="btn-quiet" disabled={updateBusy || data.desktop.phase === 'ready'} on:click={() => act('desktop-settings', { settings: { token: '', remember: false } })}>Disconnect</button><button type="button" class="btn-quiet" on:click={() => { token = ''; editingConnection = false; }}>Cancel</button>{/if}</div>
        </form>
      </div>
      {/if}
      {/if}
    </section>
    <section aria-labelledby="host-cli">
      <div class="software-row">
        <div><h3 id="host-cli">Host AKM CLI <span class="muted mono">{data.host.cli?.version ?? ''}</span></h3>
          <p role="status">{data.host.phase !== 'idle' ? 'Working…' : !data.host.cli ? 'Not checked' : !data.host.cli.installed ? 'Not installed' : !data.host.cli.runnable ? 'Installed, but not runnable' : data.host.upgrade?.updateAvailable ? `Update available · ${data.host.upgrade.latestVersion}` : data.host.upgrade ? 'Checked by AKM' : 'Installed'}</p></div>
        <div class="btn-row"><button class="btn-quiet icon-label" disabled={hostBusy} on:click={() => act('check')}><Icon name="refresh" />Check CLI & plugins</button>
          {#if data.host.cli && !data.host.cli.installed}<button disabled={hostBusy} on:click={() => act('install-cli')}>Install AKM CLI</button>
          {:else if data.host.cli?.runnable}<button disabled={hostBusy} on:click={() => act('upgrade-cli')}>Update CLI & plugins</button>{/if}
        </div>
      </div>
      {#if data.host.error}<p class="notice notice-warn" role="alert">{data.host.error}</p>{/if}
      {#if data.host.receipt}<p class="notice" role="status">{data.host.receipt}</p>{/if}
      <p class="field-hint">Updates use <code>akm upgrade</code>, including its migration checks and installed plugins. The desktop’s bundled engine updates with the app.</p>
      <details><summary>Installation details</summary><dl><dt>CLI path</dt><dd class="mono">{data.host.cli?.path ?? '~/.local/bin/akm (new installations)'}</dd><dt>Installer</dt><dd>{data.host.upgrade?.installMethod ?? 'Official AKM release installer'}</dd><dt>Last command</dt><dd class="mono">{data.host.command ?? 'Not run'}</dd></dl></details>
    </section>
    <section aria-labelledby="harness-plugins">
      <div class="plugin-heading"><div><h3 id="harness-plugins">Harness plugins</h3><p class="muted">Add AKM to a harness you already use.</p></div><label class="field">New plugin channel<select bind:value={channel} disabled={hostBusy}><option value="latest">Stable</option><option value="next">Prerelease</option></select></label></div>
      <div class="plugin-list">{#each data.host.harnesses as harness (harness.id)}
        <div class="plugin-row">
          <div><h4>{names[harness.id]} <span class="muted small">{harness.version ?? ''}</span></h4>
            <p class="muted small">{!harness.installed ? 'Harness not found' : !harness.runnable ? 'Harness could not start' : harness.plugin?.state === 'missing' ? 'AKM plugin not installed' : `AKM · ${harness.plugin?.state ?? 'not checked'} ${harness.plugin?.version ?? harness.plugin?.spec ?? ''}`}</p>
            {#if harness.plugin?.note}<p class="field-hint">{harness.plugin.note}</p>{/if}
          </div>
          {#if harness.plugin?.state === 'missing'}<button class="btn-secondary" disabled={hostBusy || !data.host.cli?.runnable} on:click={() => act('install-plugin', { harness: harness.id, channel })}>Install AKM plugin</button>{/if}
        </div>
      {/each}</div>
      <p class="field-hint">Native installers preserve existing configuration and marketplace channels. Plugin installation does not sign you in or approve hooks.</p>
    </section>
  {/if}
</div>

<style>
  .software{max-width:1000px;padding:0 8px}.intro{margin:32px 0}.intro h2{margin:0;font-size:24px}.intro p{margin:8px 0 0}
  section{padding:32px 0;margin:0;border-top:1px solid var(--border)}h3,h4{margin:0;font-size:16px;text-transform:none;letter-spacing:0}h3{font-size:18px}h3 span,h4 span{font-weight:400;margin-left:8px}
  .software-row,.plugin-row,.plugin-heading{display:flex;align-items:center;justify-content:space-between;gap:24px}.software-row p,.plugin-row p{margin:8px 0 0}
  .software-row{margin-bottom:20px}.btn-row{flex-wrap:wrap}.btn-row button{min-height:var(--control-height)}
  .menu-install{margin:24px 0 32px}.menu-install .software-row{margin-bottom:8px}.menu-install button{flex-shrink:0}
  details{margin-top:20px}summary{cursor:pointer;color:var(--muted)}form{max-width:560px;display:grid;gap:16px;padding-top:12px}
  .connection{padding:24px;margin-top:24px;border-radius:var(--radius);background:var(--surface-2)}
  .connection-status{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:24px}
  .connection-status>.icon-label{gap:12px}.connection-status .small{display:block;margin-top:4px}
  dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
  .plugin-heading{margin-bottom:12px}.plugin-heading p{margin:8px 0}.plugin-heading label{font-size:12px;min-width:145px}
  .plugin-row{padding:20px 0;border-bottom:1px solid var(--border)}.plugin-row:last-child{border:0}.plugin-row>div{min-width:0}.plugin-row p{overflow-wrap:anywhere}
  .plugin-row button{flex:none}.field-hint{max-width:75ch;margin-top:12px}progress{width:100%;height:6px;margin:0 0 20px}
  @media(max-width:700px){.software-row,.plugin-heading,.plugin-row{align-items:flex-start;flex-wrap:wrap;gap:16px}.software-row>.btn-row{width:100%}dl{grid-template-columns:1fr;gap:6px}dd{margin-bottom:10px}}
</style>

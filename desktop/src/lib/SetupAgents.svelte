<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api } from "./client";
  import { classifyEngineSkew, hostUpgradeOutrunsDesktop } from "./engine-skew";
  import Icon from "./Icon.svelte";
  import { akmPlatform, pluginChannel, type AgentCard } from "./setup-model";
  import { actSoftware, runSoftware, software, type Outcome } from "./state/software.svelte";
  import { workspace } from "./state/workspace.svelte";

  let {
    cards,
    engine,
    onconfigured,
  }: { cards: AgentCard[]; engine: string | undefined; onconfigured: () => Promise<void> } = $props();

  // A box is ticked unless the person has said otherwise; learning is the reverse, because it spends model quota.
  let installCli = $state<boolean | undefined>(undefined),
    plugins = $state<Record<string, boolean>>({}),
    learning = $state<Record<string, boolean>>({}),
    busy = $state(false),
    outcomes = $state<Array<Outcome & { label: string }>>([]),
    copied = $state(false);

  const host = $derived(software.data?.host),
    cli = $derived(host?.cli),
    channel = $derived(pluginChannel(engine)),
    skew = $derived(classifyEngineSkew(engine, cli?.version)),
    desktopBehind = $derived(hostUpgradeOutrunsDesktop(engine, host?.upgrade?.latestVersion)),
    version = $derived(software.data?.desktop.version),
    builtFor = $derived(engine?.split(".").slice(0, 2).join(".")),
    release = $derived(version && version !== "0.0.0" ? `akm ${version}` : "the latest akm"),
    wantsCli = $derived(installCli ?? true),
    cliMissing = $derived(Boolean(cli && !cli.installed)),
    installable = $derived(cards.filter((card) => card.state === "ready" && !card.needsBun)),
    pending = $derived(installable.filter((card) => plugins[card.id] ?? true)),
    library = $derived(!workspace.unconfigured),
    learnable = $derived(
      cards.filter((card) => library && learning[card.id] && card.learning.available && !card.learning.enabled),
    ),
    work = $derived((cliMissing && wantsCli ? 1 : 0) + pending.length + learnable.length),
    hostBusy = $derived(busy || Boolean(host && host.phase !== "idle"));

  async function run() {
    busy = true;
    outcomes = [];
    try {
      let cliOk = !cliMissing;
      if (cliMissing && wantsCli) {
        const outcome = await runSoftware("install-cli");
        outcomes.push({ label: "akm command-line tool", ...outcome });
        cliOk = !outcome.error;
      }
      for (const card of pending) {
        if (!cliOk) {
          outcomes.push({ label: card.name, error: "Skipped: the akm command-line tool is not installed." });
          continue;
        }
        outcomes.push({ label: card.name, ...(await runSoftware("install-plugin", { harness: card.id, channel })) });
      }
      if (learnable.length) {
        const platforms = [...new Set(learnable.map((card) => akmPlatform(card.id)))];
        try {
          await api("/setup/apply", {}, { harness: platforms });
          outcomes.push({ label: "Learning", receipt: `akm may now use ${learnable.map((c) => c.name).join(", ")}.` });
        } catch (cause) {
          outcomes.push({ label: "Learning", error: (cause as Error).message });
        }
        await onconfigured();
      }
    } finally {
      busy = false;
    }
  }
  async function update() {
    outcomes = [{ label: "akm command-line tool", ...(await runSoftware("upgrade-cli")) }];
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }
  const after: Record<string, string> = {
    claude: "Restart Claude Code, or run /reload-plugins in a session that is already open.",
    codex: "Open Codex, run /hooks, and trust the two AKM hooks. Installing the plugin does not approve them.",
    opencode: "Restart OpenCode to load the plugin.",
    opencode2: "Restart OpenCode to load the plugin.",
  };
</script>

<section class="setup-step" aria-labelledby="setup-agents">
  <div class="step-head">
    <h2 id="setup-agents">2. Connect your agents</h2>
    <span class="badge" data-tone={cards.some((card) => card.state === "connected") ? "ok" : "warn"}
      >{cards.filter((card) => card.state === "connected").length
        ? `✓ ${cards.filter((card) => card.state === "connected").length} connected`
        : "None connected yet"}</span
    >
  </div>
  {#if !software.data}<p role="status">Looking for agents on this computer…</p>{:else}
    <p>
      The akm plugin lets an agent search your library and learn from its work. The command-line tool lets any agent
      without a plugin use akm too.
    </p>

    <div class="item">
      <h3>akm command-line tool</h3>
      {#if cliMissing}
        <label class="check-label">
          <input type="checkbox" checked={wantsCli} onchange={(event) => (installCli = event.currentTarget.checked)} />
          Install {release} to <code>~/.local/bin</code>
        </label>
        <p class="field-hint">
          Uses the official release installer, which checks its download. No administrator password. Add that folder to
          your terminal's PATH if it is not there; Desktop finds it either way.
        </p>
      {:else if cli?.installed && cli.runnable}
        <p><span class="badge" data-tone="ok">✓ Installed</span> akm {cli.version} at <code>{cli.path}</code></p>
        {#if desktopBehind}<p class="notice notice-warn">
            A newer akm exists than the one built into this app. Update AKM Desktop first, then update the CLI.
          </p>
        {:else if skew === "host-older"}<p class="notice">
            This akm is older than the engine built into this app ({engine}).
            <button class="btn-secondary" disabled={hostBusy} onclick={update}>Update CLI &amp; plugins</button>
          </p>
        {:else if skew === "host-newer"}<p class="notice">
            This akm is newer than the engine built into this app ({engine}). If Desktop says the library was upgraded
            by a newer akm, update AKM Desktop.
          </p>{/if}
      {:else if cli?.installed}
        <p class="notice notice-warn">akm is installed at <code>{cli.path}</code> but did not report a version.</p>
      {/if}
    </div>

    {#each cards as card (card.id)}
      <div class="item">
        <h3>
          {card.name}
          <span class="muted small">{card.version ?? ""}</span>
          {#if card.state === "connected"}<span class="badge" data-tone={card.plugin?.mismatch ? "warn" : "ok"}
              >✓ {card.plugin?.text}</span
            >{/if}
        </h3>
        {#if card.state === "stopped"}
          <p class="notice notice-warn">This program is installed but did not start, so nothing was changed.</p>
        {:else if card.state === "unverified"}
          <p class="notice notice-warn">
            {card.name} could not say whether the akm plugin is installed, so nothing was installed over it. Check it in Settings
            → Software.
          </p>
        {:else if card.state === "ready"}
          <label class="check-label">
            <input
              type="checkbox"
              checked={(plugins[card.id] ?? true) && !card.needsBun}
              disabled={card.needsBun}
              onchange={(event) => (plugins[card.id] = event.currentTarget.checked)}
            />
            Install the akm plugin ({channel === "next" ? "prerelease" : "stable"} channel, for akm {builtFor})
          </label>
        {:else if card.plugin?.mismatch}
          <p class="notice notice-warn">
            This plugin was built for a different akm than {engine}. Use Update CLI &amp; plugins in Settings →
            Software.
          </p>
        {/if}
        {#if card.needsBun}
          <div class="notice notice-warn">
            <p>
              The {card.name} plugin's hooks run on Bun, and Bun is not installed. Desktop does not install it. Run this in
              a terminal, then check again:
            </p>
            <div class="command">
              <code>{host?.bun?.installCommand}</code>
              <button class="btn-secondary" onclick={() => copy(host?.bun?.installCommand ?? "")}
                ><Icon name="copy" size={16} />{copied ? "Copied" : "Copy"}</button
              >
              <button class="btn-secondary" disabled={hostBusy} onclick={() => actSoftware("check")}
                ><Icon name="refresh" size={16} />Check again</button
              >
            </div>
          </div>
        {/if}
        {#if card.state === "connected"}<p class="field-hint">{after[card.id]}</p>{/if}
        {#if card.state !== "stopped"}
          <label class="check-label">
            <input
              type="checkbox"
              checked={card.learning.enabled || (learning[card.id] ?? false)}
              disabled={card.learning.enabled || !card.learning.available || !library}
              onchange={(event) => (learning[card.id] = event.currentTarget.checked)}
            />
            Let akm use {card.name} for learning
          </label>
          <p class="field-hint">
            {card.learning.enabled
              ? "akm may run background learning on this agent."
              : !card.learning.available
                ? "akm could not find this program on its own PATH, so it cannot use it."
                : !library
                  ? "Create your library first."
                  : "Off unless you tick it. Learning runs this agent's model on your behalf, so it uses your quota."}
          </p>
        {/if}
      </div>
    {:else}
      <p class="muted">No agent program (Claude Code, Codex or OpenCode) was found on this computer.</p>
    {/each}

    <div class="btn-row">
      <button disabled={hostBusy || work === 0} onclick={run}
        >{busy ? "Working…" : work ? `Install ${work} selected` : "Nothing selected"}</button
      >
    </div>
    {#each outcomes as outcome}
      {#if outcome.error}
        <div class="notice notice-warn" role="alert">
          <p><strong>{outcome.label}.</strong> {outcome.error}</p>
          {#if outcome.errorDetail}<details>
              <summary>Details</summary>
              <pre class="mono">{outcome.errorDetail}</pre>
            </details>{/if}
        </div>
      {:else}<p class="notice notice-ok" role="status">
          <strong>{outcome.label}.</strong>
          {outcome.receipt ?? "Done."}
        </p>
      {/if}
    {/each}
    {#if software.error}<p class="notice notice-warn" role="alert">{software.error}</p>{/if}
  {/if}
</section>

<style>
  .item {
    margin: 20px 0;
    padding: 16px 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .item h3 {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin: 0 0 8px;
    font-size: 16px;
  }
  .item p {
    margin: 8px 0;
  }
  .command {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .command code {
    flex: 1 1 280px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .btn-row {
    display: flex;
    gap: 20px;
    align-items: center;
    flex-wrap: wrap;
  }
</style>

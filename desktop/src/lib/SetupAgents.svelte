<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api } from "./client";
  import { classifyEngineSkew, hostUpgradeOutrunsDesktop } from "./engine-skew";
  import Icon from "./Icon.svelte";
  import SetupLearning from "./SetupLearning.svelte";
  import { learnPlan, learnReceipt, learningRuns, pluginChannel, type AgentCard, type Detected } from "./setup-model";
  import { actSoftware, runSoftware, software, type Outcome } from "./state/software.svelte";
  import { workspace } from "./state/workspace.svelte";

  let {
    cards,
    detected,
    engine,
    onconfigured,
  }: {
    cards: AgentCard[];
    detected: Detected;
    engine: string | undefined;
    onconfigured: (detected: Detected) => void;
  } = $props();

  // A box is ticked unless the person has said otherwise. Background learning is the reverse, because it spends model quota.
  let installCli = $state<boolean | undefined>(undefined),
    plugins = $state<Record<string, boolean>>({}),
    use = $state<Record<string, boolean>>({}),
    learn = $state<boolean | undefined>(undefined),
    where = $state<string | undefined>(undefined),
    endpoint = $state(""),
    model = $state(""),
    keyEnv = $state(""),
    busy = $state(false),
    outcomes = $state<Array<Outcome & { label: string }>>([]),
    // The harnesses whose plugin this page installed: only they need the restart note.
    installedNow = $state<string[]>([]),
    copied = $state(false);

  const host = $derived(software.data?.host),
    cli = $derived(host?.cli),
    channel = $derived(pluginChannel(engine, software.data?.preferences?.pluginChannel)),
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
    // Agents akm may use: those already enabled, and those ticked that akm can run.
    usable = $derived(cards.filter((card) => card.state !== "stopped" && card.learning.available)),
    enabling = $derived(usable.filter((card) => library && !card.learning.enabled && (use[card.id] ?? true))),
    allowed = $derived(usable.filter((card) => card.learning.enabled || enabling.includes(card))),
    plan = $derived(
      learnPlan(
        detected,
        allowed.map((card) => card.id),
        { learn, where, endpoint, model, keyEnv },
      ),
    ),
    agent = $derived(allowed.find((card) => card.id === plan.learning?.harness)),
    moves = $derived(library && plan.changed),
    work = $derived((cliMissing && wantsCli ? 1 : 0) + pending.length + enabling.length + (moves ? 1 : 0)),
    hostBusy = $derived(busy || Boolean(host && host.phase !== "idle"));

  // The buttons stay focusable while busy or with nothing to do (aria-disabled), so these handlers do the refusing.
  async function run() {
    if (hostBusy || work === 0) return;
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
        const outcome = await runSoftware("install-plugin", { harness: card.id, channel });
        if (!outcome.error) installedNow.push(card.id);
        outcomes.push({ label: card.name, ...outcome });
      }
      if (enabling.length || moves) {
        const enabled = new Set([...detected.enabled, ...enabling.map((card) => card.id)]);
        const { learning, connection } = plan;
        const agentName = agent?.name;
        try {
          // akm says what is true afterwards; that, not the ticked boxes, is what the receipt reports.
          const next = await api<Detected>(
            "/setup/apply",
            {},
            {
              harness: [...enabled],
              ...(connection ? { connection } : {}),
              ...(learning ? { learning } : {}),
            },
          );
          const wantedOn = learning?.on ?? learningRuns(next);
          onconfigured(next);
          use = {};
          where = undefined;
          learn = undefined;
          endpoint = model = keyEnv = "";
          outcomes.push({
            label: "Agents and learning",
            receipt: `${enabled.size} agent${enabled.size === 1 ? " is" : "s are"} enabled for akm. ${learnReceipt(next, wantedOn, agentName)}${next.warnings?.length ? ` ${next.warnings.join(" ")}` : ""}`,
          });
        } catch (cause) {
          outcomes.push({ label: "Agents and learning", error: (cause as Error).message });
        }
      }
    } finally {
      busy = false;
    }
  }
  async function update() {
    if (hostBusy) return;
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
  // Said once, after this page installed the plugin; a plugin found installed was loaded long ago.
  const after: Record<string, string> = {
    claude: "Restart Claude Code, or run /reload-plugins in a session that is already open.",
    codex: "Open Codex, run /hooks, and trust the two AKM hooks. Installing the plugin does not approve them.",
    opencode: "Restart OpenCode to load the plugin.",
  };
</script>

<section class="setup-step" aria-labelledby="setup-agents" aria-busy={hostBusy}>
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

    <!-- Each card is a named group; a hint is the description of the control it explains. -->
    <div class="item" role="group" aria-labelledby="setup-cli-name">
      <h3 id="setup-cli-name">akm command-line tool</h3>
      {#if cliMissing}
        <label class="check-label">
          <input
            type="checkbox"
            checked={wantsCli}
            aria-describedby="setup-cli-hint"
            onchange={(event) => (installCli = event.currentTarget.checked)}
          />
          Install {release} to <code>{host?.cliDirectory}</code>
        </label>
        <p class="field-hint" id="setup-cli-hint">
          Uses the official release installer, which checks its download. No administrator password. Desktop finds akm
          there; your terminal needs that folder on its PATH.
        </p>
      {:else if cli?.installed && cli.runnable}
        <p><span class="badge" data-tone="ok">✓ Installed</span> akm {cli.version} at <code>{cli.path}</code></p>
        {#if desktopBehind}<p class="notice notice-warn">
            A newer akm exists than the one built into this app. Update AKM Desktop first, then update the CLI.
          </p>
        {:else if skew === "host-older"}<p class="notice">
            This akm is older than the engine built into this app ({engine}).
            <button class="btn-secondary" aria-disabled={hostBusy} onclick={update}>Update CLI &amp; plugins</button>
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
      {@const restart = card.state === "connected" && installedNow.includes(card.id)}
      <div
        class="item"
        role="group"
        aria-labelledby="agent-{card.id}-name"
        aria-describedby={restart ? `agent-${card.id}-after` : undefined}
      >
        <h3 id="agent-{card.id}-name">
          {card.name}
          <span class="muted small">{card.version ?? ""}</span>
          <!-- The tick is for a plugin that matches this akm; a mismatch is the warning below, not a ticked badge in another colour. -->
          {#if card.state === "connected"}<span class="badge" data-tone={card.plugin?.mismatch ? "warn" : "ok"}
              >{card.plugin?.mismatch ? "" : "✓ "}{card.plugin?.text}</span
            >{/if}
        </h3>
        {#if card.state === "stopped"}
          <p class="notice notice-warn">This program is installed but did not start, so nothing was changed.</p>
        {:else if card.state === "disabled"}
          <p class="notice notice-warn">
            The akm plugin is installed in {card.name} but turned off. Turn it on there (<code>/plugin</code>).
          </p>
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
              aria-describedby={card.needsBun ? `agent-${card.id}-bun` : undefined}
              onchange={(event) => (plugins[card.id] = event.currentTarget.checked)}
            />
            Install the akm plugin for {card.name} ({channel === "next" ? "prerelease" : "stable"} channel, for akm {builtFor})
          </label>
        {:else if card.plugin?.mismatch}
          <p class="notice notice-warn">
            This plugin was built for a different akm than {engine}. Use Update CLI &amp; plugins in Settings →
            Software.
          </p>
        {/if}
        {#if card.needsBun}
          <div class="notice notice-warn">
            <p id="agent-{card.id}-bun">
              The {card.name} plugin's hooks run on Bun, and Bun is not installed. Desktop does not install it. Run this in
              a terminal, then check again:
            </p>
            <div class="command">
              <code>{host?.bun?.installCommand}</code>
              <!-- The names say what is copied and what is checked; they start with the visible words. -->
              <button
                class="btn-secondary"
                aria-label={copied ? "Copied Bun's install command" : "Copy Bun's install command"}
                onclick={() => copy(host?.bun?.installCommand ?? "")}
                ><Icon name="copy" size={16} />{copied ? "Copied" : "Copy"}</button
              >
              <button
                class="btn-secondary"
                aria-label="Check again for Bun"
                aria-disabled={hostBusy}
                onclick={() => !hostBusy && actSoftware("check")}><Icon name="refresh" size={16} />Check again</button
              >
              <span class="sr-only" role="status">{copied ? "Bun's install command copied." : ""}</span>
            </div>
          </div>
        {/if}
        {#if restart}<p class="field-hint" id="agent-{card.id}-after">
            {after[card.id]}
          </p>{/if}
        {#if card.state !== "stopped"}
          <label class="check-label">
            <input
              type="checkbox"
              checked={card.learning.enabled || (use[card.id] ?? true)}
              disabled={card.learning.enabled || !card.learning.available || !library}
              aria-describedby="agent-{card.id}-use-hint"
              onchange={(event) => (use[card.id] = event.currentTarget.checked)}
            />
            Let akm use {card.name}
          </label>
          <p class="field-hint" id="agent-{card.id}-use-hint">
            {card.learning.enabled
              ? "Enabled: akm can run work on this agent (akm agent, tasks)."
              : !card.learning.available
                ? "akm could not find this program on its own PATH, so it cannot use it."
                : !library
                  ? "Create your library first."
                  : "Lets akm run agent work and tasks on it. This does not run akm's background learning on it."}
          </p>
        {/if}
      </div>
    {:else}
      <p class="muted">No agent program (Claude Code, Codex or OpenCode) was found on this computer.</p>
    {/each}

    {#if allowed.length || learningRuns(detected) || plan.on}
      <SetupLearning {detected} {plan} {library} {allowed} bind:learn bind:where bind:endpoint bind:model bind:keyEnv />
    {/if}

    <div class="btn-row">
      <!-- Not `disabled`: the button keeps keyboard focus while it works, so the results below can be reached from it. -->
      <button aria-disabled={hostBusy || work === 0} onclick={run}
        >{busy ? "Working…" : work ? `Install ${work} selected` : "Nothing selected"}</button
      >
      <a href="#setup-try">Skip this step</a>
    </div>
    <!-- The region is always there, so each result arriving in it is announced. -->
    <div aria-live="polite">
      {#each outcomes as outcome}
        {#if outcome.error}
          <div class="notice notice-warn" role="alert">
            <p><strong>{outcome.label}.</strong> {outcome.error}</p>
            {#if software.data?.host.consent}<p>
                <a href="/settings/software">Continue in Settings → Software</a>, where you can choose to install from
                the existing marketplace or replace the CLI.
              </p>{/if}
            {#if outcome.errorDetail}<details>
                <summary>Details</summary>
                <pre class="mono">{outcome.errorDetail}</pre>
              </details>{/if}
          </div>
        {:else}<p class="notice notice-ok">
            <strong>{outcome.label}.</strong>
            {outcome.receipt ?? "Done."}
          </p>
        {/if}
      {/each}
    </div>
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

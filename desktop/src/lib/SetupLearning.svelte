<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { akmPlatform, type AgentCard, type Detected, type LearnPlan } from "./setup-model";

  let {
    detected,
    plan,
    library,
    allowed,
    learn = $bindable(),
    where = $bindable(),
    endpoint = $bindable(),
    model = $bindable(),
    keyEnv = $bindable(),
  }: {
    detected: Detected;
    plan: LearnPlan;
    library: boolean;
    allowed: AgentCard[];
    learn: boolean | undefined;
    where: string | undefined;
    endpoint: string;
    model: string;
    keyEnv: string;
  } = $props();

  const hasConnection = $derived(detected.connection !== null || Boolean(endpoint.trim() && model.trim()));
</script>

<div class="item">
  <h3>Background learning</h3>
  <label class="check-label">
    <input
      type="checkbox"
      checked={plan.on}
      disabled={!library}
      onchange={(event) => (learn = event.currentTarget.checked)}
    />
    Let akm learn in the background
  </label>
  <p class="field-hint">
    Off unless you turn it on. Learning is akm's own model calls (improving assets, judging, and extracting what a
    session taught when it ends), and it uses model quota. Turning it on also schedules akm's improve task.
    {detected.learning.on ? `Now: on, ${detected.modelCalls.description.replace(/\.$/, "")}.` : "Now: off."}
  </p>
  {#if plan.on}
    <fieldset class="learn-where">
      <legend>Where should it run?</legend>
      <label class="check-label">
        <input
          type="radio"
          name="learn-where"
          checked={plan.where === "internal"}
          disabled={!hasConnection}
          onchange={() => (where = "internal")}
        />
        akm itself (a model connection)
      </label>
      <p class="field-hint">
        {hasConnection
          ? `akm calls a model through ${detected.connection ? `its connection "${detected.connection}"` : "the connection below"}, not through an agent program.`
          : "Not available yet: akm has no model connection. Enter one below, or choose an agent."}
      </p>
      {#each allowed as card (card.id)}
        <label class="check-label">
          <input
            type="radio"
            name="learn-where"
            checked={plan.where === akmPlatform(card.id)}
            onchange={() => (where = akmPlatform(card.id))}
          />
          {card.name}
        </label>
        <p class="field-hint">
          akm runs {card.name} for this: {card.learning.note}.{card.learning.note.includes("cannot be restricted")
            ? " Choose it only if you accept that."
            : ""}
        </p>
      {/each}
    </fieldset>
    <fieldset class="learn-where">
      <legend
        >{detected.connection
          ? `Change the connection "${detected.connection}" (optional)`
          : "A model connection for akm itself"}</legend
      >
      <div class="learn-field">
        <label for="learn-endpoint">Endpoint</label>
        <input id="learn-endpoint" type="url" placeholder="http://localhost:11434/v1" bind:value={endpoint} />
      </div>
      <div class="learn-field">
        <label for="learn-model">Model</label>
        <input id="learn-model" type="text" placeholder="a model name the endpoint serves" bind:value={model} />
      </div>
      <div class="learn-field">
        <label for="learn-key">API key variable (optional)</label>
        <input id="learn-key" type="text" placeholder="MY_API_KEY" bind:value={keyEnv} />
      </div>
      <p class="field-hint">
        Give the name of the environment variable that holds the key, never the key itself. akm reads it from the
        environment each time it starts.
      </p>
    </fieldset>
    {#if plan.problem}<p class="notice notice-warn" role="status">{plan.problem}</p>{/if}
  {/if}
</div>

<style>
  .item {
    margin: 20px 0;
    padding: 16px 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .item h3 {
    margin: 0 0 8px;
    font-size: 16px;
  }
  .item p {
    margin: 8px 0;
  }
  .learn-where {
    margin: 12px 0 0;
    padding: 0;
    border: 0;
  }
  .learn-field {
    display: grid;
    gap: 4px;
    margin: 8px 0;
    max-width: 480px;
  }
</style>

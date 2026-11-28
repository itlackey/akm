<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, tick } from "svelte";
  import { api } from "./client";
  import { moveRule, type RuleChoices } from "./projects-model";

  let {
    rules = $bindable(),
    project,
    name,
    busy,
  }: {
    /** The refs to write, in load order; empty: automatic selection. */
    rules: string[];
    /** The saved project whose list and effect akm reports; empty when adding. */
    project: string;
    /** The name in the form, for the automatic-selection sentence. */
    name: string;
    busy: boolean;
  } = $props();

  let choices = $state<RuleChoices | null>(null),
    error = $state(""),
    announce = $state(""),
    order = $state<HTMLElement>(),
    fieldset = $state<HTMLElement>();

  onMount(async () => {
    try {
      choices = await api<RuleChoices>("/rules/choices", { project });
    } catch (cause) {
      error = (cause as Error).message;
    }
  });

  const found = (ref: string) => choices?.listed.find((item) => item.ref === ref);
  const describe = (ref: string) =>
    found(ref)?.description ?? choices?.available.find((item) => item.ref === ref)?.description ?? "";
  /** A rule is chosen under the spelling it was listed with, which may differ from the one akm prints. */
  const spellings = (ref: string) => rules.filter((entry) => entry === ref || found(entry)?.resolved === ref);

  function toggle(ref: string, on: boolean) {
    rules = on ? [...rules, ref] : rules.filter((entry) => !spellings(ref).includes(entry));
  }
  async function move(index: number, by: -1 | 1, label: string) {
    rules = moveRule(rules, index, by);
    announce = `${label} is now ${index + by + 1} of ${rules.length}.`;
    await tick();
    // The buttons stay where the rule was; follow it, and stay on the same direction until it reaches an end.
    const item = order?.children[index + by];
    const same = item?.querySelector<HTMLElement>(`[data-move="${by < 0 ? "up" : "down"}"]:not(:disabled)`);
    (same ?? item?.querySelector<HTMLElement>("[data-move]:not(:disabled)"))?.focus();
  }
  async function drop(index: number, label: string) {
    rules = rules.filter((_, i) => i !== index);
    announce = `${label} removed.`;
    await tick();
    const next = order?.children[Math.min(index, rules.length - 1)];
    (next?.querySelector<HTMLElement>("[data-drop]") ?? fieldset?.querySelector<HTMLElement>("input"))?.focus();
  }
</script>

<fieldset class="field wide rules" bind:this={fieldset}>
  <legend class="field-label">Rules to load</legend>
  <p class="field-hint">
    {#if rules.length}A list replaces automatic selection: only these rules load, in this order, from any enabled
      bundle.{:else}With no list, this project gets the rules marked project={name.trim() || "<name>"} plus the shared rules
      (those that name no project). Choose rules to load exactly those instead, in the order you set.{/if}
  </p>
  {#if error}<p class="notice notice-fail" role="alert">The rules could not be listed: {error}</p>{/if}
  {#if choices}
    {#if choices.available.length}
      {#each choices.available as rule (rule.ref)}
        <label class="check-label rule-choice"
          ><input
            type="checkbox"
            checked={spellings(rule.ref).length > 0}
            disabled={busy}
            onchange={(event) => toggle(rule.ref, event.currentTarget.checked)}
          />
          <span class="mono">{rule.ref}</span>{#if rule.description}<span class="muted small">{rule.description}</span
            >{/if}</label
        >
      {/each}
    {:else}<p class="muted">No enabled bundle has rules yet (files in a bundle's top-level rules/ folder).</p>{/if}
  {/if}
  {#if rules.length}
    <h3 class="rules-order" id="rules-order">Load order</h3>
    <ol class="plain rule-order" aria-labelledby="rules-order" bind:this={order}>
      {#each rules as ref, index}
        {@const problem = found(ref)?.problem}
        <li class="rule-item">
          <span class="rule-text"
            ><span class="mono wrap">{ref}</span>
            {#if problem}<span class="field-error" role="status">Not found: {problem}. Remove it.</span
              >{:else if describe(ref)}<span class="muted small">{describe(ref)}</span>{/if}</span
          >
          <span class="rule-actions">
            <button
              type="button"
              class="btn-quiet"
              data-move="up"
              disabled={busy || index === 0}
              aria-label={`Move ${ref} up`}
              onclick={() => move(index, -1, ref)}>Up</button
            >
            <button
              type="button"
              class="btn-quiet"
              data-move="down"
              disabled={busy || index === rules.length - 1}
              aria-label={`Move ${ref} down`}
              onclick={() => move(index, 1, ref)}>Down</button
            >
            <button
              type="button"
              class="btn-quiet"
              data-drop
              disabled={busy}
              aria-label={`Remove ${ref} from the list`}
              onclick={() => drop(index, ref)}>Remove</button
            >
          </span>
        </li>
      {/each}
    </ol>
  {/if}
  <p class="sr-only" role="status">{announce}</p>
  {#if project && choices}
    <p class="muted small">
      {#if choices.applies.length}Loaded today (saved settings): <span class="mono wrap"
          >{choices.applies.map((rule) => rule.ref).join(", ")}</span
        >{:else}Loaded today (saved settings): no rules.{/if}
    </p>
  {/if}
</fieldset>

<style>
  .rule-choice {
    align-items: baseline;
    column-gap: var(--space-3);
  }
  .rule-order {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }
  .rule-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding-block: var(--space-2);
    border-block-end: 1px solid var(--border);
  }
  .rule-actions {
    display: flex;
    gap: var(--space-2);
  }
  @media (width < 48rem) {
    .rule-item {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .rule-text {
    display: grid;
    min-inline-size: 0;
  }
  .rules-order {
    margin: var(--space-3) 0 0;
    font-size: var(--text-m);
  }
</style>

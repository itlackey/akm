<script lang="ts">
  import { provenance } from "./settings-presenter";
  import type { SettingsField } from "./settings-presenter";
  export let field: SettingsField;
  export let value: string;
  export let source: string | null | undefined;
  export let disabled = false;
  $: id = `setting-${field.key.replace(/[^a-zA-Z0-9-]/g, "-")}`;
</script>

<div class="field" class:field-row={field.kind === "boolean"}>
  <div class="field-text">
    <div class="field-head">
      <label class="field-label" for={id}>{field.label}</label><span class="source-badge">{provenance(source)}</span>
    </div>
    {#if field.hint}<p class="field-hint" id={`${id}-hint`}>{field.hint}</p>{/if}
  </div>
  {#if field.kind === "boolean"}<input
      type="checkbox"
      role="switch"
      class="switch"
      {id}
      {disabled}
      checked={value === "true"}
      on:change={(event) => (value = String(event.currentTarget.checked))}
      aria-describedby={field.hint ? `${id}-hint` : undefined}
    />
  {:else if field.kind === "select"}<select
      {id}
      bind:value
      {disabled}
      aria-describedby={field.hint ? `${id}-hint` : undefined}
      >{#each field.options ?? [] as [option, label]}<option
          value={option}
          disabled={field.disabledOptions?.includes(option)}>{label}</option
        >{/each}</select
    >
  {:else}<input
      {id}
      {disabled}
      type={field.kind === "number" ? "number" : field.kind === "url" ? "url" : "text"}
      bind:value
      placeholder={field.placeholder}
      autocomplete="off"
      spellcheck="false"
      aria-describedby={field.hint ? `${id}-hint` : undefined}
    />{/if}
</div>

<style>
  .source-badge {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .field-head {
    flex-wrap: wrap;
    gap: 0.35rem 0.75rem;
  }
</style>

<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import type { FrontmatterRead, Json } from "./types";
  let {
    properties,
    disabled = false,
    onChange,
  }: {
    /** akm's reading of the file's frontmatter and the keys it knows for the type. */
    properties: FrontmatterRead;
    disabled?: boolean;
    /** A key was set (`value`) or removed; the editor asks akm to apply it to the text. */
    onChange: (change: { key: string; value?: Json; remove?: true }) => void;
  } = $props();
  let newKey = $state(""),
    newValue = $state("");
  const present = $derived(new Map(properties.entries.map((entry) => [entry.key, entry.value])));
  const other = $derived(properties.entries.filter((entry) => !entry.known));
  const scalar = (value: Json | undefined) => value === null || value === undefined || typeof value !== "object";
  /** A value the form can show as one field: text, a number, a flag or a plain list. */
  const expressible = (kind: string, value: Json | undefined) =>
    kind !== "map" && (scalar(value) || Array.isArray(value));
  const text = (value: Json | undefined) =>
    value === undefined || value === null
      ? ""
      : Array.isArray(value) && value.every(scalar)
        ? value.join(", ")
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
  /** The value to set for what was typed; a number stays a number. */
  function typed(raw: string, before: Json | undefined): Json {
    return typeof before === "number" && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  function commitText(key: string, raw: string, kind: string) {
    const before = present.get(key);
    if (raw === text(before)) return;
    if (!raw.trim()) onChange({ key, remove: true });
    else if (kind === "list")
      onChange({
        key,
        value: raw
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      });
    else onChange({ key, value: typed(raw, before) });
  }
  function add() {
    if (!newKey.trim()) return;
    onChange({ key: newKey.trim(), value: newValue });
    newKey = "";
    newValue = "";
  }
</script>

<fieldset class="properties-form" {disabled}>
  <legend>Properties</legend>
  <div class="grid">
    {#each properties.keys as known (known.key)}
      {@const value = present.get(known.key)}
      <label class="field" for={`prop-${known.key}`}
        >{known.key}{known.required ? " (required)" : ""}
        {#if known.kind === "flag"}<input
            id={`prop-${known.key}`}
            type="checkbox"
            checked={value === true}
            aria-describedby={`prop-hint-${known.key}`}
            onchange={(event) => onChange({ key: known.key, value: event.currentTarget.checked })}
          />{:else if !expressible(known.kind, value)}<input
            id={`prop-${known.key}`}
            value={text(value)}
            readonly
            aria-describedby={`prop-hint-${known.key}`}
          />{:else if known.values}<select
            id={`prop-${known.key}`}
            aria-describedby={`prop-hint-${known.key}`}
            onchange={(event) => commitText(known.key, event.currentTarget.value, known.kind)}
            ><option value="" selected={value === undefined}>Not set</option>{#each known.values as option}<option
                value={option}
                selected={value === option}>{option}</option
              >{/each}</select
          >{:else}<input
            id={`prop-${known.key}`}
            value={text(value)}
            aria-describedby={`prop-hint-${known.key}`}
            onchange={(event) => commitText(known.key, event.currentTarget.value, known.kind)}
          />{/if}
      </label>
      <p class="hint muted small" id={`prop-hint-${known.key}`}>
        {known.hint}{known.kind === "list" ? " Separate items with commas." : ""}{expressible(known.kind, value)
          ? ""
          : " Edit this one as text."}{known.stamped ? " akm sets it when it writes the file." : ""}
      </p>
    {/each}
    {#each other as entry (entry.key)}
      <label class="field" for={`prop-${entry.key}`}
        >{entry.key}
        <input
          id={`prop-${entry.key}`}
          value={text(entry.value)}
          readonly={!expressible("text", entry.value)}
          onchange={(event) =>
            commitText(entry.key, event.currentTarget.value, Array.isArray(entry.value) ? "list" : "text")}
        />
      </label>
      <p class="hint">
        <button type="button" class="quiet" onclick={() => onChange({ key: entry.key, remove: true })}
          >Remove {entry.key}</button
        >
      </p>
    {/each}
  </div>
  <div class="add">
    <label>New property<input bind:value={newKey} /></label><label>Value<input bind:value={newValue} /></label><button
      type="button"
      class="btn-secondary"
      aria-disabled={newKey.trim() ? undefined : "true"}
      onclick={add}>Add property</button
    >
  </div>
</fieldset>

<style>
  .properties-form {
    margin: 0 0 var(--space-4);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-inline-size: 0;
  }
  legend {
    font-size: var(--text-xs);
    font-weight: 600;
    padding-inline: var(--space-1);
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-1) var(--space-4);
  }
  .field {
    display: grid;
    gap: var(--space-1);
    font-size: var(--text-xs);
    font-weight: 550;
  }
  .hint {
    margin: 0 0 var(--space-2);
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-2) var(--space-3);
    margin-top: var(--space-2);
    font-size: var(--text-xs);
  }
  .add label {
    display: grid;
    gap: var(--space-1);
    font-weight: 550;
  }
</style>

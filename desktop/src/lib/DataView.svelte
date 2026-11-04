<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  export let value: unknown;
  export let depth = 0;
  const label = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
  function rowLabel(row: unknown, index: number) {
    if (row && typeof row === "object") {
      const record = row as Record<string, unknown>;
      for (const key of ["name", "taskId", "ref", "id", "date", "week", "startedAt"])
        if (typeof record[key] === "string") return record[key];
    }
    return `Record ${index + 1}`;
  }
</script>

{#if value === null || value === undefined}<span class="muted">Unavailable / not recorded</span>
{:else if Array.isArray(value)}
  {#if value.length === 0}<p class="muted">No records in this window.</p>
  {:else if value.every((item) => item === null || typeof item !== "object")}<p>{value.join(" · ")}</p>
  {:else}<div class="records">
      {#each value as row, i}<details open={depth === 0 && value.length < 5}>
          <summary>{rowLabel(row, i)}</summary><svelte:self value={row} depth={depth + 1} />
        </details>{/each}
    </div>{/if}
{:else if typeof value === "object"}
  <dl class="data-list">
    {#each Object.entries(value) as [key, child]}
      <div>
        <dt>{label(key)}</dt>
        <dd>
          {#if child !== null && typeof child === "object"}<details open={depth < 1}>
              <summary>{Array.isArray(child) ? `${child.length} records` : "Details"}</summary><svelte:self
                value={child}
                depth={depth + 1}
              />
            </details>{:else}<svelte:self value={child} depth={depth + 1} />{/if}
        </dd>
      </div>
    {/each}
  </dl>
{:else}<span class:mono={typeof value === "number"}
    >{typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}</span
  >{/if}

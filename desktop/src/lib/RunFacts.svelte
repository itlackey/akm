<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { date } from "./client";
  import { number } from "./activity-presenter";
  import { workflowFacts } from "./run-model";
  import type { WorkflowTrace } from "./activity-types";

  /** What went wrong in one workflow run, and what it used, from the records of its units and attempts. */
  let { trace }: { trace: WorkflowTrace } = $props();
  const facts = $derived(workflowFacts(trace));
  const unreported = $derived(facts.engines.reduce((sum, row) => sum + row.unreported, 0));
  const most = $derived(Math.max(1, ...facts.engines.map((row) => row.tokens)));
</script>

<section class="facts" aria-label="What failed and what the run used">
  <div>
    <h3>What failed, and when</h3>
    {#if facts.failures.length}<table>
        <caption>Failed attempts in the order they ended</caption><thead
          ><tr><th>When</th><th>Step</th><th>Unit</th><th>Attempt</th><th>Recorded reason</th></tr></thead
        ><tbody
          >{#each facts.failures as failure}<tr
              ><td>{date(failure.at)}</td><td>{failure.step}</td><td class="mono">{failure.unit}</td><td
                >{failure.attempt}</td
              ><td>{failure.reason ?? "No reason recorded"}</td></tr
            >{/each}</tbody
        >
      </table>{:else if facts.failedWithoutFailedUnit}<p>
        The run is recorded as failed, and no attempt of it is. akm records a run that was abandoned or stopped as
        failed too, so this does not say which happened.
      </p>{:else}<p class="muted">No failed attempt is recorded for this run.</p>{/if}
  </div>
  <div>
    <h3>Model usage</h3>
    {#if facts.engines.length}<table>
        <caption>Tokens by execution target</caption><thead
          ><tr><th>Target</th><th>Attempts</th><th>Failed</th><th>Tokens reported</th></tr></thead
        ><tbody
          >{#each facts.engines as row}<tr
              ><th>{row.engine}</th><td>{row.attempts}</td><td>{row.failed}</td><td class="usage"
                ><span
                  class="usage-bar"
                  style={`inline-size:${Math.max(row.tokens ? 2 : 0, (row.tokens / most) * 100)}%`}
                ></span><span class="num"
                  >{row.tokens ? number(row.tokens) : row.unreported ? "Not reported" : "0"}</span
                ></td
              ></tr
            >{/each}</tbody
        >
      </table>
      <p class="muted small">
        {unreported
          ? `${unreported} attempt${unreported === 1 ? "" : "s"} reported no tokens: they are counted as unreported, not as zero. `
          : ""}Tokens are not money. akm records the target of each unit, not the model, for a workflow run.
      </p>{:else}<p class="muted">No units are recorded, so there is no model usage to show.</p>{/if}
  </div>
</section>

<style>
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
    gap: 1.5rem;
    margin-block: 1rem;
  }
  .facts h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
  .usage {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .usage-bar {
    block-size: 0.5rem;
    max-inline-size: 8rem;
    min-inline-size: 0;
    flex: none;
    background: var(--s1);
    border-radius: 0 2px 2px 0;
  }
</style>

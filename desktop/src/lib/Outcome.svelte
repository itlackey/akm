<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { OUTCOME_LABEL, type Outcome } from "./run-model";
  /** A run's outcome: a mark and a word, never colour alone. `detail` is the recorded status when it says more. */
  let { outcome, detail = "" }: { outcome: Outcome; detail?: string } = $props();
  const tone = { completed: "ok", failed: "fail", terminated: "warn", unknown: "neutral" } as const;
  const mark = { completed: "●", failed: "▲", terminated: "■", unknown: "◆" } as const;
</script>

<span class="badge" data-tone={tone[outcome]}
  ><span aria-hidden="true">{mark[outcome]}</span>{OUTCOME_LABEL[outcome]}{detail ? ` (${detail})` : ""}</span
>

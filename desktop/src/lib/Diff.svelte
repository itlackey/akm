<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { diffSection } from "./ui/diff-view.js";
  import { mount } from "./ui/lib.js";
  // Preserve AKM's reviewed diff algorithm, escaped markup and keyboard-operable controls.
  export let before: string | null = "";
  export let after: string | null = "";
  export let beforeLabel = "Current";
  export let afterLabel = "Proposed";
  export let unified = "";
  export let truncated = false;
  export let redacted = false;
  export let comparing = false;

  function render(
    node: HTMLElement,
    value: { before: string | null; after: string | null; unified: string; truncated: boolean; redacted: boolean },
  ) {
    function draw(next: typeof value) {
      const section = diffSection(next, comparing ? { before: beforeLabel, after: afterLabel } : undefined);
      mount(node, section.markup);
      section.wire?.(node);
    }
    draw(value);
    return { update: draw };
  }
</script>

<section class="change-preview" aria-label={`${beforeLabel} compared with ${afterLabel}`}>
  {#if beforeLabel !== "Current" || afterLabel !== "Proposed"}<p class="muted small">
      {comparing ? "First asset" : "Current"}: {beforeLabel} · {comparing ? "Second asset" : "Proposed"}: {afterLabel}
    </p>{/if}
  {#if redacted}<p class="notice notice-warn">Sensitive values are hidden. No source text is displayed.</p>{/if}
  <div use:render={{ before, after, unified, truncated, redacted }}></div>
</section>

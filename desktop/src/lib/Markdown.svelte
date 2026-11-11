<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { markdown, splitFrontmatter } from "./ui/markdown.js";
  let {
    content = "",
    omitHeading = "",
    links = {},
    ref = "",
    bundle = "",
    headings = [],
  }: {
    content?: string;
    // Reuse AKM's title suppression only when the body opens with the displayed title.
    omitHeading?: string;
    links?: Record<string, string>;
    ref?: string;
    bundle?: string;
    headings?: Array<{ line: number; slug: string; text?: string }>;
  } = $props();
  const source = $derived(splitFrontmatter(content));
  const skipTitle = $derived(
    source.body.match(/^#[ \t]+([^\n]+)(?:\n|$)/)?.[1]?.trim() === omitHeading ? omitHeading : undefined,
  );
  const rendered = $derived(
    markdown(source.body, { ref, bundle, links, headings, startLine: source.startLine, skipTitle }),
  );
</script>

<div class="markdown">{@html rendered.text}</div>

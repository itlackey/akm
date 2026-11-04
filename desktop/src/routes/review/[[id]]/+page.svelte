<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { page } from "$app/state";
  import Review from "../../../lib/Review.svelte";
</script>

<div class="review-page-shell">
  <Review id={page.params.id ?? ""} query={new URLSearchParams(page.url.search)} />
</div>

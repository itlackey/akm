<script lang="ts">
  import { page } from "$app/state";
  import Review from "../../../lib/Review.svelte";
</script>

<div class="review-page-shell">
  <Review id={page.params.id ?? ""} query={new URLSearchParams(page.url.search)} />
</div>

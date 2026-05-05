---
description: Web components integration guide for Svelte
tags:
  - svelte
  - web components
  - custom elements
quality: curated
---
# Web Components with Svelte

## Custom Elements

Svelte components can be compiled as custom elements for use outside Svelte apps.

```svelte
<svelte:options customElement="my-element" />

<script>
  export let name = "world";
</script>

<p>Hello {name}!</p>
```

## Shadow DOM

Custom elements use Shadow DOM by default for style encapsulation.

## Interoperability

Use web components from other frameworks inside Svelte applications.

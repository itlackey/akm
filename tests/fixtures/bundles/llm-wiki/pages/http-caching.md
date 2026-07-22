---
description: How HTTP caching decides freshness and revalidation.
pageKind: concept
xrefs:
  - wiki:sample-wiki/pages/entities/varnish
sources:
  - raw/2026-07-http-rfc.md
---

# HTTP caching

Caching reuses stored responses. Freshness comes from `Cache-Control`/`Expires`;
stale responses are revalidated with conditional requests. See
[varnish](entities/varnish.md) for a concrete cache implementation.

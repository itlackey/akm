---
description: A note whose only cross-reference points at a page that does not exist.
pageKind: note
xrefs:
  - wiki:sample-wiki/pages/does-not-exist
---

# Orphan note

<!--
INTENTIONAL (fixture): the xref target pages/does-not-exist does not exist, so
the wiki lint golden reports a broken-xref finding. This page also has no
`sources:` and no inbound xrefs, so it is a link orphan.
-->

A dangling note. It references [a missing page](does-not-exist.md).

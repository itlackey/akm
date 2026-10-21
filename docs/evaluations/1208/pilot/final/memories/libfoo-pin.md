---
description: libfoo upgrade pin.
updated: 2026-05-20
---

Upgrading libfoo from 2.3 to 2.4 breaks `--legacy-flag` in the export tool. Pin `libfoo==2.3.9` in `requirements.lock` until the vendor ships the 2.4.2 patch, then remove the pin.

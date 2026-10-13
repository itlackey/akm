# Bundle Types

This page has moved. AKM's bundle-format documentation is now split in two:
the public compatibility table lives at
[Supported Formats](supported-formats.md), and the adapter internals — probe
order, the `BundleAdapter` interface, and the write allowlists — live at
[Architecture → Adapters](https://github.com/itlackey/akm/blob/main/docs/architecture/adapters.md).

- [Supported Formats](supported-formats.md) — the format-by-format table:
  what AKM indexes, the auto-detection marker, current read/write support,
  and typical use, for all 11 built-in formats (`akm` native, `okf`,
  `llm-wiki`, `claude`, `opencode`, `agent-skills`, `dotenv`,
  `akm-workflow`, `akm-task`, `website-snapshot`, `generic-files`).
- [Architecture → Adapters](https://github.com/itlackey/akm/blob/main/docs/architecture/adapters.md) — how AKM picks an
  adapter for a bundle, the `BundleAdapter` interface contract, the write allowlists that actually gate
  `akm remember`/`import`/`proposal accept`/etc., and per-adapter
  implementation caveats.

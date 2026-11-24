# Bundle Types

AKM's bundle-format documentation is split in two: the public compatibility
table lives at
[Supported Formats](supported-formats.md), and the adapter internals — probe
order, the `BundleAdapter` interface, the asset facade, identity, retire and
delete, and which adapters write and retire — live at
[Architecture → Adapters](../architecture/adapters.md). The config shape of a
bundle (`adapter`, `root`, `writable`, `location`) is in
[Configuration](configuration.md#bundles-and-write-target).

- [Supported Formats](supported-formats.md) — the format-by-format table:
  what AKM indexes, the auto-detection marker, current read/write support,
  and typical use, for all 14 built-in formats (`akm` native, `okf`,
  `llm-wiki`, `claude`, `opencode`, `agent-skills`, `dotenv`,
  `akm-workflow`, `akm-task`, `website-snapshot`, `generic-files`, `code-project`,
  and the secret managers `secret-tool` and `azure-key-vault`).
- [Architecture → Adapters](../architecture/adapters.md) — how AKM picks an
  adapter for a bundle, the `BundleAdapter` interface contract, which adapters write (what actually gates
  `akm remember`/`import`/`proposal accept`/etc.), and per-adapter
  implementation caveats.

Usage:
  akm proposal list

Description:
  List proposal queue entries.

  (The flat `akm proposals` alias was removed in 0.9.0 — use `akm proposal list`.)

Options:
  --status <status>    Filter by pending, accepted, or rejected
  --type <type>        Filter by asset type
  --ref <ref>          Filter by exact asset ref

Examples:
  akm proposal list
  akm proposal list --status pending
  akm proposal list --type skill

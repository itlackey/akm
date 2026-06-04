Usage:
  akm proposal list

Description:
  List proposal queue entries.

  (`akm proposals` is a deprecated alias for `akm proposal list`; it warns on
  stderr and is removed in 0.9.0.)

Options:
  --status <status>    Filter by pending, accepted, or rejected
  --type <type>        Filter by asset type
  --ref <ref>          Filter by exact asset ref

Examples:
  akm proposal list
  akm proposal list --status pending
  akm proposal list --type skill

Usage:
  akm proposal reject <id> --reason "..."

Description:
  Reject a proposal and record the reason.

  (`akm reject` is a deprecated alias for `akm proposal reject`; it warns on
  stderr and is removed in 0.9.0.)

Examples:
  akm proposal reject proposal_123 --reason "duplicates existing workflow"

Usage:
  akm propose <type> <name> --task "..."
  akm propose <type> <name> --file <path>

Description:
  Create a proposal for a brand-new AKM asset.

Input:
  --task <text>        Inline task or prompt text
  --file <path>        Read task or prompt text from a file

Rules:
  Exactly one of --task or --file is required.

Examples:
  akm propose skill release-auditor --task "review release artifacts before publish"
  akm propose workflow hotfix-triage --file ./prompts/hotfix-triage.md

# Task: set storage account lifecycle policy (variant A)

Append the exact `az` CLI command (no comments, no shell pipes) to
`commands.txt` that creates a management lifecycle-policy rule on an
existing storage account named `mystorage` in resource group `myrg`.

The rule must:
- delete blobs after 30 days since modification,
- target the `blockBlob` blob type,
- be installed via the `az storage account management-policy create`
  subcommand with both `--account-name` and `--resource-group` flags.

Do not run the command. Only write what you would run.

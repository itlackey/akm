# Task: list resources by compound tag selector

Append the exact `az` CLI command (no comments, no shell pipes) to
`commands.txt` that lists resources whose tag `env` is `prod` AND whose
tag `tier` is `data`, projecting the columns `name`, `type`, and
`location` via the JMESPath `--query` operator and emitting tab-separated
output.

Do not run the command. Only write what you would run.

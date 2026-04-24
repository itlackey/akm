## 9. Schema Reference

The two `.env.schema` files in `assets/` provide machine-parseable documentation for every
environment variable. They are safe to commit — they contain no secret values.

| File | Documents |
|---|---|
| [`assets/secrets.env.schema`](../../assets/secrets.env.schema) | All variables in `CONFIG_HOME/secrets.env` (user-managed) |
| [`assets/stack.env.schema`](../../assets/stack.env.schema) | All variables in `DATA_HOME/stack.env` (system-managed) |

### Varlock decorator syntax

Each variable entry uses decorator comments to declare its type, sensitivity, and
whether it is required:

| Decorator | Meaning | Example |
|---|---|---|
| `@type=<spec>` | Value type and constraints | `@type=string(minLength=16)`, `@type=url`, `@type=integer(min=0,max=65534)` |
| `@sensitive` / `@sensitive=false` | Whether the value is a secret (controls masking in logs and UI) | `@sensitive`, `@sensitive=false` |
| `@required` / `@required=infer` | Whether the variable must be set before the stack can start | `@required`, `@defaultRequired=infer` |

File-level header decorators (`@defaultSensitive`, `@defaultRequired`) set the
default for all variables in the file unless overridden per-variable.

`secrets.env.schema` uses `@defaultSensitive=true` (all values are secrets unless
explicitly marked `@sensitive=false`) and `@defaultRequired=infer` (required status
is inferred from whether the variable has a default value).

`stack.env.schema` uses `@defaultSensitive=false` (path and identity vars are not
secrets) and `@defaultRequired=true` (all system-managed vars are always present).

The schema files are used by the [Varlock](https://varlock.dev) CLI for validation
(`varlock load --path <dir>/`) and secret-leak scanning
(`varlock scan --path <dir>/`). In practice, the schema (`.env.schema`) and its
corresponding `.env` file are copied into a temporary directory, and varlock is
invoked with `--path <tmpDir>/` so it discovers both files together.

---
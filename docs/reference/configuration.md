# Configuration

AKM reads one user configuration file: `$XDG_CONFIG_HOME/akm/config.json`
(normally `~/.config/akm/config.json` on Linux and macOS, or
`%APPDATA%\akm\config.json` on Windows). Set `AKM_CONFIG_DIR` to override the
directory. Project `.akm/config.json` files are not merged. A config file may
optionally extend one other config via `extends` (see "Sharing configuration
across installs" below) — this is a single, explicit, user-opted-in key, not
automatic project-config discovery.

## Version 0.9

`configVersion` is `"0.9.0"`, the only value akm has ever shipped. It is
read, never gated on: a file without the field loads silently, and a file
declaring any other value is named once on stderr (`config.json declares
configVersion "X"; this release reads it as 0.9.0.`) and read as the
current shape anyway — nothing is rewritten on disk. The next config write
(`akm config set`, etc.) and `akm migrate apply`'s config step both persist
`"0.9.0"`, which silences the note. When a newer akm wrote the shared
config, `akm health`'s `binary-config-skew` advisory is what says so. Pre-0.9
config and database layouts are not runtime inputs. Historical task sources
are handled by the standalone `akm-migrate` executable, also invoked by `akm
migrate` / `akm upgrade`; ordinary runtime code reads only the current shape.

```jsonc
{
  "configVersion": "0.9.0",
  "connections": {
    "default": {
      "endpoint": "http://localhost:11434/v1",
      "models": { "fast": "qwen3-8b", "balanced": "qwen3-32b", "reasoning": "qwen3-32b" }
    }
  },
  "harnesses": { "claude": {} },
  "embedding": { "model": "nomic-embed-text" },
  "workflow": { "maxConcurrency": 8 },
  "improve": {
    "strategy": "nightly",
    "processes": {
      "memoryInference": { "model": "qwen3-8b", "llm": { "temperature": 0.1 } }
    },
    "strategies": {
      "nightly": {
        "processes": { "reflect": { "limit": 10 } }
      }
    }
  }
}
```

A config with no connection and no harness is valid: everything that needs no
model works. [Connections](#connections), [Harnesses](#harnesses) and [Where
each process runs](#where-each-process-runs) say how models are added.

## Scheduler activation

`scheduler.enabled` is this host's list of scheduled refs, such as
`stash//tasks/nightly`, held and written as plain refs. A ref that is not
listed is disabled, and removing a bundle drops its refs. The older
`{kind, ref, sourceId}` entries are read as their `ref` and written back
plain.
A config without the list (written before 0.9.17) means "keep what is
installed": the first `akm task sync`, `akm setup`, `akm task enable`, `akm task
disable` or `akm task add` fills it from the akm-written native scheduler rows.
There are no grants, source identities or fire-time checks. Authored
task/workflow files may describe schedules but cannot put themselves on the
list.

This key is deliberately local: if a config uses `extends`, any `scheduler`
section in the base is ignored with a warning. Only the top-level local config
can activate schedules. Prefer `akm task enable <ref>` and `akm task disable
<ref>` over editing the JSON by hand; both update the allow-list and sync the
affected bundle. An unscoped `akm task sync` reconciles enabled refs across all
enabled configured bundles.

## Connections

A connection is an OpenAI-compatible endpoint akm sends model requests to, and
the models it serves. `connections` maps a name to one. A name is lowercase
kebab-case, at most 63 characters, and cannot start with `akm-`. The
connection named `default` is the default connection; a lone connection is the
default whatever it is called. `akm setup` names the first one `default`.

```jsonc
{
  "connections": {
    "default": {
      "endpoint": "http://localhost:11434/v1",
      "models": {
        "fast": "qwen3-8b",
        "balanced": "qwen3-32b",
        "reasoning": { "model": "glm-5", "reasoning_effort": "high" }
      },
      "top_p": 0.9
    }
  }
}
```

akm reads these keys of a connection:

| Key | Meaning |
| --- | --- |
| `endpoint` | Required. The OpenAI-compatible base URL (`http://localhost:11434/v1`) or the chat-completions URL itself, starting with `http://` or `https://`. Requests go to `<base>/chat/completions` and the model list is read from `<base>/models`; a query string on the URL (a gateway's `api-version`, say) stays after the path on every request, and a `#fragment` is dropped. A username or password in the URL is warned about; put the key in `apiKey` or `credentials.json`. |
| `apiKey` | A `$VAR` or `${VAR}` reference to an environment variable. Absent, the key is the one stored in `credentials.json` for the connection and its endpoint. See [Credentials](#credentials). |
| `apiKeyFile` | Retired. `akm migrate apply` leaves an engine's key file here, as written, when it cannot read the file yet; akm ignores it (never reads it or sends it) and a later `akm migrate apply` moves the key it names into `credentials.json`. |
| `models` | Alias to model. See [Aliases](#aliases). |
| `contextLength` | The model's context window in tokens. `akm improve` sizes its prompts from it (consolidate's chunks, reflect's asset content); unset, it assumes 4096. |
| `timeoutMs` | How long one call may take, in milliseconds; `null` runs unbounded. Unset, a model call stops after 600 000 (ten minutes) and agent work runs until it finishes. The ceiling is 2 147 483 647. |
| `concurrency` | How many requests a workflow `map` step may have in flight on this connection, clamped to 1–64. Unset, 1 on a loopback endpoint (a local model server runs one inference at a time) and 4 on a remote one. akm never sends it. |

Every other key, on the connection or in a model entry, is a request field in
the endpoint's own spelling and is sent with each request as written (`top_p`,
`reasoning_effort`, `chat_template_kwargs`, ...). A connection's fields apply to
all its models and a model entry's override them; an object field on both sides
(`chat_template_kwargs`) merges key by key. `model`, `messages`, `tools`,
`stream` and `response_format` are akm's, on a direct call and in akm's own
runtime alike: the resolved model, the conversation and tool state, whether the
reply streams and the response format a caller asks for are never replaced. A
connection or model entry that writes one of them is ignored for that field,
with one warning.

A transient failure (an HTTP 5xx, a dropped connection) is retried once, within
what is left of the call's timeout. A 4xx is not.

### Settings a call asks for

A command, agent, workflow step or task can run against any endpoint, so it asks
for these in akm's words, and akm writes them as the endpoint's fields over the
connection's own:

| Setting | Request field |
| --- | --- |
| `temperature` | `temperature` |
| `maxTokens` | `max_tokens` |
| `reasoningEffort` (an asset's `effort` is the same setting) | `reasoning_effort` |
| `enableThinking` | `chat_template_kwargs.enable_thinking` and `enable_thinking` |

They are written `akm.inference` (and top-level `temperature` and `effort`) in
an asset's frontmatter, `llm:` on a workflow step (`max_tokens`,
`enable_thinking`, `reasoning_effort`), `inference` in a task, and `llm` on an
improve process, the quality gate or an index pass. Nearest wins: the asset,
then the process, then the model entry, then the connection. A connection and
akm's own runtime take all of them. A harness takes none: set them in the
program's own configuration, and akm reports each as an `untranslated-field`
notice while the call goes on.

akm sends no `max_tokens` unless one is written, on a connection, on a model
entry or by the call: the model and its endpoint know their own limits, and a
default cap would truncate replies silently.

`enableThinking: false` turns thinking off and `reasoningEffort` takes a value
such as `"none"`, `"low"` or `"high"`. akm sends **both** thinking fields,
because which one an endpoint honors is a fact about it and any gateway in front
of it. llama.cpp direct honors both (`reasoning_effort` from build b10644); vLLM
honors `chat_template_kwargs`; Bifrost drops `chat_template_kwargs` and passes
`reasoning_effort` through, so also set `reasoningEffort: "none"` behind it. A
strict hosted API that rejects the two fields (OpenAI answers 400 `Unknown
parameter: 'chat_template_kwargs'`) gets one retry without both, and akm stops
sending them to that endpoint and model for the rest of the process. A response
with reasoning tokens despite `enableThinking: false` triggers a runtime
warning.

Improve's `consolidate` and `reflect` always ask for thinking off, for a
machine-readable payload, and the quality-gate and triage judges do too unless
the judge's connection turns thinking on (`enable_thinking: true` as a request
field, or `llm.enableThinking: true`).

When a call asks for JSON that matches a schema, a connection receives the
schema as `response_format` (`json_schema`, strict). If the endpoint rejects it
with a 4xx other than 429, or with a 5xx that names the response format, akm
retries once without `response_format` and stops sending it to that endpoint and
model for the rest of the process. A harness receives the schema as one
instruction at the end of its prompt (`Respond with ONLY a JSON value matching
this JSON Schema (no prose, no code fences):` followed by the schema).

## Harnesses

A harness is an agent program you already have. `harnesses` maps a name to an
entry; an entry named for a platform enables it, so `{ "claude": {} }` enables
Claude Code. A second install of the same program sets `platform`: `{
"claude-work": { "platform": "claude", "bin": "/opt/claude-work/bin/claude" }
}`. The harness named `default` is the default harness; a lone harness is the
default whatever it is called. With several and none named `default`, there is no
default harness. `akm setup` names the default one `default`.

The platforms (generated from the harness registry; do not edit):

<!-- harness-table:start (generated by scripts/gen-config-schema.ts) -->
| `platform` | Harness | Binary | Session logs | Read-only model work | Native `agent` |
| --- | --- | --- | --- | --- | --- |
| `opencode` | OpenCode | `opencode` | yes | yes | yes |
| `claude` | Claude Code | `claude` | yes | yes | yes |
| `codex` | OpenAI Codex CLI | `codex` | yes | yes | no |
| `copilot` | GitHub Copilot CLI | `copilot` | no | no | no |
| `pi` | Pi | `pi` | no | no | no |
| `gemini` | Gemini CLI | `gemini` | no | no | no |
| `aider` | Aider | `aider` | no | no | no |
| `amazonq` | Amazon Q Developer CLI | `q` | no | no | no |
| `openhands` | OpenHands | `openhands` | no | no | no |
<!-- harness-table:end -->

An entry sets any of:

| Key | Meaning |
| --- | --- |
| `platform` | One of the platforms above. Absent, the entry's name must be one. |
| `bin` | The program to run. Default: the platform's binary above, looked up on `PATH`. |
| `args` | Arguments placed before the ones akm adds. |
| `workspace` | The directory agent work runs in. Default: the directory akm was started in. |
| `agent` | The harness's native agent to run when a request names none (`claude` and `opencode` only). A request's own agent wins, an agent asset's persona is kept, and model work runs no native agent. |
| `timeoutMs` | How long a run may take, in milliseconds; `null` runs unbounded. Unset, agent work runs until it finishes and model work stops after 600 000. |
| `models` | Alias to model name for this harness, over the map akm ships for its platform. See [Aliases](#aliases). |

Asset frontmatter cannot set `workspace`, `environment` or opaque `runtime`
values; those belong to this configuration or to a workflow's environment
bindings.

akm runs the program without a person at the terminal, gives it the prompt and
takes its standard output as the reply. `akm agent` with no `--prompt` starts the
program interactively instead.

**Model work on a harness.** Model work (see [Where each process
runs](#where-each-process-runs)) on a harness program runs in a scratch
directory that akm creates for the call and removes after it. The table's
"Read-only model work" column says whether akm can also run it read-only on that
platform:

- Claude Code runs with `--restricted`, so none of your settings files can widen
  the tools; with `Read` and `Bash` only for `akm search`, `akm show` and `akm
  curate`; with no MCP servers; and with no transcript saved.
- Codex runs with `--sandbox read-only`.
- OpenCode 2 runs with its tools that edit files, run commands or start
  subagents denied, plus akm's own `akm_search`, `akm_show` and `akm_curate`, in
  a fixed directory under akm's cache directory.
- On those three, `args` do not apply to model work, except a `--model` they
  name.
- Every other platform, and OpenCode 1, cannot be restricted: the run is
  unrestricted, in the scratch directory, and akm reports that.

Where model work is restricted (the three above), what it changes in the library
reaches it only as a proposal, through the review queue. Where it cannot be
restricted, nothing but its scratch working directory stands between the run and
your files: the program keeps its own tools and runs with the file and command
authority of the user running akm, in the environment a harness run gets (the
akm directories included), so it can edit files and run commands, in or outside
the library, and akm does not check what it did. `akm setup` says so when you
enable such a harness for akm's model calls ("Model work on `<name>` cannot be
restricted: it can edit files and run commands."), and its summary repeats it.
Any harness may be enabled for model calls; a connection is the way to keep
them from touching anything.

**OpenCode.** The `opencode` platform runs your own OpenCode, choosing how from
the major version `opencode --version` reports:
- OpenCode 2 runs embedded in akm's process (no server, no port), with your
  OpenCode configuration (providers, plugins, MCP servers, agents), your logins
  read from your OpenCode 2 database, and your default model unless akm names one.
  A model name is OpenCode's `provider/model`, from the request, else the
  `--model` in the harness's `args`, as on OpenCode 1. The embedded run carries
  no other `args` (the CLI's flags have no meaning there): any it cannot carry
  are named once. Its sessions are stored in akm's own database,
  `<akm data dir>/opencode.db`.
- akm never migrates your OpenCode database. It reads the database's migration
  ledger first, read-only, and only when the ledger has every migration the
  OpenCode akm embeds carries (your OpenCode is the same release or newer) does
  OpenCode's own credential service read your logins from it. A refreshed OAuth
  token is written back to your OpenCode database, as OpenCode itself does;
  nothing else in it is changed. An older database is left untouched: akm warns
  once and the run goes on without your stored logins until you upgrade
  OpenCode. akm stores no session in it, and its reads of your OpenCode history
  are separate and read-only.
- OpenCode 1 runs as `opencode run`, with the prompt on stdin. It keeps its logins
  in `auth.json`, which akm does not import. akm reads OpenCode 1's session
  history read-only from its `opencode.db`, the same file OpenCode 2 uses.

Nobody can answer an akm run. On the embedded OpenCode (this harness and akm's
own runtime) akm cancels every question and rejects every permission request,
each with a message saying so, and the model carries on without it.

### Without a harness

Agent work runs on akm's own runtime when no harness is configured: OpenCode
embedded in akm's process, driven by the default connection. It needs nothing
installed beyond akm, but its first run downloads the package OpenCode reaches
the endpoint with, `@ai-sdk/openai-compatible`, from the npm registry into
`<akm cache dir>/opencode/npm/`: that first run needs network access to npm,
even for a local model, and later runs use the downloaded copy.

- It uses your connections. It loads no user or project OpenCode configuration
  (so none of your plugins, MCP servers or agents), though OpenCode still reads
  `~/.agents` and its system config (`/etc/opencode`, or macOS managed
  preferences), and OpenCode's free models are off. The connection a run is
  dispatched with (its endpoint, model and context window, as they were when the
  run was planned) is declared as a provider of its own when the run starts, so
  a connection edited or removed afterwards cannot redirect a run that was
  already planned.
- It has OpenCode's tools, editing files and running commands included, and
  akm's `akm_search`, `akm_show` and `akm_curate`.
- Its own files live under `opencode/` in akm's data, cache and state
  directories, and its sessions in `<akm data dir>/opencode.db`. Nothing is
  written under `~/.local/share/opencode`.

## Credentials

akm reads an API key from one of two places, and nowhere else:

- **A `$VAR` reference.** `"apiKey": "$LOCAL_LLM_KEY"` (or `"${LOCAL_LLM_KEY}"`)
  names an environment variable, read when the call is made. An unset or empty
  variable is warned about once and the request goes without a key.
- **`credentials.json`.** With no `apiKey`, the key is the entry stored for the
  block in `credentials.json`, next to `config.json`, written with mode 0600:

  ```json
  { "connections": { "<name>": { "key": "…", "endpoint": "…" } },
    "services":    { "embedding": { "key": "…", "endpoint": "…" } } }
  ```

  A key is stored for one endpoint and read for that endpoint alone. Change a
  block's endpoint and the old key is not sent to the new one (it is named once,
  without its value, and the block goes without until a key is stored for the new
  endpoint). A connection's name and a service (`embedding`, `curateRerank`) are
  different namespaces, so a connection called `embedding` and the embedding
  service hold different keys. An `embedding` that runs on the default connection
  uses that connection's entry. A connection that only an `extends` base defines
  gets its endpoint from that base, so it never uses a stored key: stored keys
  are for the connections your own `config.json` names (name it there, even with
  only its `models`, and a key stored for the endpoint it ends up with is used).
  A key in the older flat `{ "<name>": "<key>" }` form names no endpoint and is
  not used; `akm migrate apply` files it under the endpoint your own config gives
  that block.

`akm setup` asks for a key at a masked prompt and stores it in
`credentials.json` for the endpoint it was typed for; `--api-key-env NAME` sets
`apiKey: "$NAME"` instead. Setup an endpoint change that comes with no key does
not carry the old key to the new endpoint (a `$VAR` is dropped from the entry, a
stored key stays for the old endpoint), and says so. A key
is never written to `config.json` or passed on a command line. A literal
`apiKey` in the file, or a `${secrets/...}` reference, is warned about once and
ignored (never sent), and `akm config set` refuses to write one. `akm migrate
apply` moves such a key into `credentials.json`. The key is sent as
`Authorization: Bearer <key>` and redacted from everything akm prints and logs.

The bundle's `secrets/` store, `akm secret` and `akm env` are for the secrets
your own agents and tasks need, and have nothing to do with these keys.

## Aliases

A model alias names "a model of this kind", so the same bundle means the same
thing on every machine. `fast`, `balanced` and `reasoning` are the standard
ones; add any other you like. A connection's `models` and a harness's `models`
say which of their models answers each:

```jsonc
{
  "connections": {
    "default": {
      "endpoint": "http://localhost:11434/v1",
      "models": { "fast": "qwen3-8b", "balanced": "qwen3-32b", "reasoning": "qwen3-32b" }
    }
  },
  "harnesses": { "claude": { "models": { "fast": "claude-haiku-4-5-20251001" } } }
}
```

A model is asked for by `model:` in an asset's frontmatter, `--model` on a
command, or `model` on an improve process, and it is an alias or an exact model
name:
- An alias is looked up in the selected connection's `models` (or harness's).
- A name that is not an alias is used as written.
- An alias the connection does not map answers with its first model. A
  connection with no `models` at all cannot answer an alias; the error names
  `akm models set`.
- A harness passes no model for an alias it has none for, and the program uses
  its own default; when the harness maps other aliases, akm says so once. Claude
  Code ships a map (`fast` Haiku 4.5, `balanced` Sonnet 4.6, `reasoning` Opus
  4.7), which a `models` entry overrides. No other harness ships one. A
  harness is passed the model name only: an alias written as an object
  (`{ "model": "...", "effort": "high" }`) gives its `model`, and akm says once
  that its other fields are ignored.

A kind of work that names no model asks for a default alias: improve's
processes, the index passes, extraction and `akm remember --enrich` ask for
`fast`; the quality and triage judges and a workflow gate ask for `balanced`;
agent work asks for `balanced`.

`akm models` lists a connection's aliases beside the models its endpoint lists,
and `akm models set <alias> <model>` changes one; see the [CLI
reference](cli.md#models). A harness's `models` is edited with `akm config set`.

## Where each process runs

akm's work is of two kinds, and each has a default place to run.

- **Model work** asks a model for an answer with nobody watching: the improve
  processes (reflect, distill, consolidate, memory inference, extract, and
  validation's repair), the quality and triage judges, the judge of a workflow
  `### gate`, the index passes, and `akm remember --enrich`. It runs on the
  default connection, as a direct request to the endpoint. With no connection it
  runs on the default harness.
- **Agent work** runs an agent: `akm agent`, `akm command run`, `akm proposal
  new`, agent tasks and workflow agent steps. It runs on the default harness.
  With no harness it runs on akm's own runtime, over the default connection.

With neither a connection nor a harness, model features and agent work are off:
each command that needs one says so and points at `akm setup`, and everything
that needs no model keeps working.

Anywhere a connection or harness can be named (config, a flag, an asset's
`connection:` or `harness:`) and none is, the default is used. A name that is
not configured is an error (exit 78), never a reason to use the default: the
message names the selector, says it is not configured, lists the configured
connections (or harnesses) and the nearest name when one is close, and the same
holds for the retired `engine:` and `--engine`. Defaults apply only when nothing
was named, so a call for a private connection is never sent to a remote service,
nor a call that must not touch files to a harness that can, by a typo, a removed
entry, or an entry akm ignored when it loaded the config (`akm health` lists
what is configured).

These settings, all optional, choose another place for one piece of work:

| Key | Chooses where |
| --- | --- |
| `improve.connection`, `improve.harness` | All of `akm improve`'s model work |
| `improve.processes.<process>` | One improve process: `reflect`, `distill`, `consolidate`, `memoryInference`, `extract`, `validation`, or `triage` (its judgment) |
| `improve.qualityGate` | The judge of the reflect and distill quality gates |
| `index.connection`, `index.<pass>` | The index passes (`index.memory`) |

Each takes `connection` or `harness`, `model` (an alias or a name), `llm` (the
[settings a call asks for](#settings-a-call-asks-for)) and `timeoutMs`. A pass
under `index` takes `connection`, not `harness` (one that names nothing runs
where model work does: the default connection, else the default harness), and
`enabled: false` turns it off:

```jsonc
{
  "improve": {
    "connection": "default",
    "processes": {
      "reflect": { "connection": "cloud", "model": "reasoning" },
      "memoryInference": { "model": "qwen3-8b", "llm": { "temperature": 0.1 } }
    },
    "qualityGate": { "connection": "judge", "llm": { "enableThinking": true } }
  },
  "index": { "connection": "default", "memory": { "enabled": false } }
}
```

The nearest setting wins, farthest to nearest: the shipped alias of the kind of
work, `improve.connection` and `improve.harness`, the process's entry in
`improve.processes`, and `--connection`, `--harness` and `--model` on the run,
which reach every call in it, the judges included. The quality-gate judge is the
exception: a process's own entry is the writer's, so `improve.qualityGate`
replaces it, and a `reasoning` model chosen for reflect is not the one that
judges it. An index pass reads `index.*`, then `index.<pass>`. A strategy adds no
layer: it says which processes run, never where.

`akm health` and `akm info` print this as a table, resolved by the same code the
calls use: for each kind of work, the connection or harness and the model.

## Workflows

`workflow.maxConcurrency` is the ceiling on units a workflow run executes at
once. An explicit value is clamped to `1..64`. When absent, akm derives it once
from the CPU count (`min(16, max(1, cores - 2))`) and freezes it into the run
plan, so resuming on a different host or after a config edit does not change the
policy.

`workflow.defaultMapConcurrency` is the width a `map` step freezes when it
declares no `concurrency:` of its own. Unset means 4. An explicit value is
clamped to `1..64`; set it to `1` for serial fan-out. It is only a default: an
authored `map.concurrency` always wins, and a step never runs wider than
`workflow.maxConcurrency`, the selected connection's `concurrency`, or the host
CPU cap.

The judge of a `### gate` rubric is model work, so a workflow with completion
criteria needs a connection or a harness before a new run can be frozen. The
choice is frozen into each run, so later config edits do not change an
in-flight run's verifier. A missing, failed or malformed verdict rejects the
gate; criteria are never silently bypassed.

## Strategies

Improve presets live under `improve.strategies`; invoke one with
`akm improve --strategy <name>`. The selection order is `--strategy`,
`improve.strategy`, then built-in `default`. A strategy says which processes run
and how each is tuned (`enabled`, limits, gates), never where: where each process
runs is [Where each process runs](#where-each-process-runs), whichever strategy
is selected.

```jsonc
{
  "improve": {
    "strategy": "nightly",
    "strategies": {
      "nightly": {
        "processes": {
          "reflect": { "limit": 10 },
          "memoryInference": { "enabled": false }
        }
      }
    }
  }
}
```

The built-in strategies are `default` and `consolidate`. `consolidate` is a
patch that is deep-merged onto `default`, and a user-defined strategy of the
same name is merged on top of that; so every strategy, built-in or user-defined,
inherits omitted fields from `default`. A name that is neither built-in nor
defined under `improve.strategies` is refused: `improve.strategy` when the config
loads, `--strategy` when the command runs. A block named `quick`, `thorough`,
`catchup`, `reflect-distill` or `proactive-maintenance` is an ordinary
user-defined strategy that inherits `default`, and `--strategy` naming one with
no such block fails with an error that names `default`. For a judged triage
drain, set `processes.triage` (`enabled`, `applyMode: "promote"`,
`judgment: true`) in your own strategy.

`processes.triage.judgment` controls the optional judgment tier: `true` enables
it, `false` disables it, and an object holds `enabled` (default `true`). The
judgment is a model call; it runs where `improve.processes.triage` says
(`connection` or `harness`, `model`, `llm`, `timeoutMs`), over `improve.connection`
and `improve.harness`, and over the defaults. Enabling it with no connection or
harness configured fails before the run starts, naming `akm setup`.

The `default` strategy runs triage in `promote` mode with judgment off and
`maxAcceptsPerRun: 200` (#1143), so the proposal backlog drains through the
deterministic gates without `experimental.improveAutonomy`. Turning judgment on
in a promote strategy is what that opt-in gates.

Judgment is off in every built-in strategy, and the judgment tier may accept
only a consolidate promotion. Retirements and reflect revisions it
would accept are left for a person. This is measured, not cautious by habit
(#1132, #1094): with `experimental.improveAutonomy` and judgment over every
proposal kind, the nightly eval solved 0.49 (gpt-5.6-terra) and 0.53
(qwen3.8-27b) of its items while harming 14 and 11, and changed 18 and 21 notes
outside the planted set; the judge accepted unsafe retirements and applied exact
fixes unreviewed. Judging promotions alone was reasonable: on qwen3.8-27b it
had precision 0.87 and recall 0.78 and accepted 4.8% of bad promotions; on
gpt-5.6-terra it was very cautious (precision 1.0, recall 0.17).

```jsonc
{
  "improve": {
    "processes": { "triage": { "harness": "claude" } },
    "strategies": {
      "nightly": {
        "processes": { "triage": { "enabled": true, "judgment": true } }
      }
    }
  }
}
```

`processes.reflect.qualityGate` and `processes.distill.qualityGate` control
each process's LLM-as-judge quality gate. Each is on unless it sets
`enabled: false`, and each follows only its own switch. A reflect revision the
judge passes is staged for the triage drain to accept; a distill lesson it
passes is deferred for a person (reason `distill-review`), which the drain and
its judgment tier leave alone. With the distill gate off nothing is judged, and
the drain decides. The judge is a model call that
runs where `improve.qualityGate` says (`connection` or `harness`, `model`, `llm`,
`timeoutMs`), for both gates, over `improve.connection` and `improve.harness`
and the defaults: with no `qualityGate`, the default connection answers with its
`balanced` model. The process's own entry in `improve.processes` is the writer's
and does not reach the judge. The judge may be a connection or a harness; one
that cannot be restricted to read-only runs unrestricted, with a notice. It runs
at temperature 0 with thinking off unless its connection turns thinking on.
Thinking is slow: on a 27B llama.cpp server, a thinking judgment took a median
of 30–67 s and up to about 3 minutes, against about 5 s without.
Behind a gateway that drops `chat_template_kwargs` (Bifrost), point a thinking
judge's connection at the server directly.

```jsonc
{
  "connections": {
    "judge": {
      "endpoint": "http://127.0.0.1:8080/v1",
      "models": { "balanced": "qwen3-27b" }
    }
  },
  "improve": {
    "qualityGate": { "connection": "judge", "llm": { "enableThinking": true } }
  }
}
```

`processes.reflect.defectFilter` sets the wording of the checks reflect runs
before the judge. With the quality gate on or off, reflect refuses a revision
that adds placeholder text, talks about its own edit, or copies frontmatter into
its body: no proposal, and no judge call. Each rule counts only what the
revision adds to its source, so wording the asset already had and kept is not
held against it. Each of the three lists is optional. A list you set replaces
that rule's default list, and `[]` turns the rule off.

| List | Rule | Default |
|---|---|---|
| `placeholders` | `placeholder_added` | `please confirm`, `please verify`, `to be confirmed`, `to be determined`, `to be verified` |
| `metaCommentary` | `meta_commentary_added` | `feedback signal`, `feedback signals`, `feedback indicate`, `feedback indicates`, `feedback suggest`, `feedback suggests`, `feedback ask`, `feedback asks`, `feedback says`, `feedback report`, `feedback reports`, `feedback request`, `feedback requests`, `this revision`, `the source asset`, `the source note`, `the source memory`, `the original asset`, `the original note`, `the original memory`, `the original version of this`, `quality gate rejected`, `proposal rejected` |
| `frontmatterKeys` | `frontmatter_copied_into_body` | `sources`, `updated`, `inferenceProcessed`, `captureMode`, `beliefState`, `xrefs`, `contradictedBy`, `outcomeData`, `orderedActions`, `generated`, `verified`, `description`, `when_to_use`, `tags`, `searchHints`, `quality`, `salience`, `salienceInputs`, `lint_skip`, `type` |

`placeholders` and `metaCommentary` entries are plain phrases, not patterns:
whole words, in any case, with any run of whitespace between words.
`frontmatterKeys` entries are exact key names: a line outside a code fence that
starts with `key:` counts. The rule also refuses a `sources`, `xrefs` or
`contradictedBy` value copied into the body; `frontmatterKeys: []` turns that
off too. Every entry must be a non-empty string, or the config does not load.

```jsonc
{
  "improve": {
    "strategies": {
      "nightly": {
        "processes": {
          "reflect": {
            "defectFilter": {
              "placeholders": ["please confirm", "to be confirmed", "[draft]"],
              "frontmatterKeys": []
            }
          }
        }
      }
    }
  }
}
```

No shipped strategy turns improve-stage session extraction on.
`proactiveMaintenance` is on in `default` and off in `consolidate`, the only
other shipped strategy. It plans stable assets that have had no feedback: at most
`maxPerRun` (default 15) per run, only assets not reflected or distilled for
`dueDays` (default 30), so each comes up at most once a month, and reflect's
`limit` (25) still bounds the run. A preset that omits either process
inherits the `default` value; set `processes.proactiveMaintenance.enabled: false` in the
selected strategy to turn the lane off. A proposal from this lane is never
accepted by `proposal drain`: it waits for a person (reason
`proactive-needs-review`, #1147). User strategy overrides
are applied last, so an explicit `enabled: true` still opts the selected
strategy in.

These improve-stage defaults do not gate explicit standalone extraction through
`akm proposal extract --type <harness>` or `akm proposal extract --auto`. The interactive
scheduled-task step also continues to offer the bundled `core/extract` template
as an unselected opt-in; it is not installed merely because the template is
bundled.

## Indexing

AKM-native Markdown contributes a normalized body projection to the
lowest-weight `content` search field. The projection is capped at 16,384
characters, removes frontmatter, comments, fenced code, and link destinations,
and is never produced for secret, env, session, or session-checkpoint assets.
Embedding input is separately capped at 8,192 characters with structured
metadata placed before body content.

## Semantic search

`semanticSearchMode` (top-level, `"off" | "auto"`, default `"off"`, or `"auto"` when `embedding` is set) gates
embedding-based search. `"auto"` lets AKM set up embeddings (which downloads
a local model unless you point `embedding` at a remote provider) and falls
back to keyword-only FTS if the embedding runtime is unavailable; `"off"`
disables semantic search outright and search is always keyword-only FTS.
If a backend marked ready cannot serve a query, search still returns the FTS
results but reports `searchMode: "fts-fallback"` and one sanitized warning.
This is distinct from `searchMode: "keyword"`, which is the normal result when
semantic search is disabled or has not been built. A read-only sandbox that
cannot record best-effort usage telemetry does not by itself mark search as
degraded.
The npm/Bun package declares `@huggingface/transformers` as a normal dependency.
AKM imports that external package directly; it does not carry a copied runtime
under `src/` or `dist/`. If the dependency is unavailable, reinstall `akm-cli`
or configure a remote `embedding.endpoint`. Setup does not mutate a global
installation to add runtime packages.
The default is `"off"` so a bare or headless install (`akm bundle create`, `--yes`,
`--config`) never silently downloads the local embedding model on first
index. A config that has an `embedding` block and sets no `semanticSearchMode`
reads as `"auto"`: writing the block says semantic search is wanted.
The interactive `akm setup` wizard pre-selects semantic search **on**
regardless of this default, and warns that choosing it downloads the model
unless a remote `embedding` config is provided.

```jsonc
{ "semanticSearchMode": "off" }
```

`embedding` configures the connection used for semantic search and
`akm improve`'s memory-inference/consolidate passes when they call an
embedding model: `provider`, `endpoint`, `model`, `apiKey` (a `$VAR` reference,
or the `embedding` service's entry in `credentials.json`; see
[Credentials](#credentials)), `dimension`, `localModel`,
`maxInputTokens`, `maxTokens`, `batchSize`, `contextLength`, `timeoutMs`,
`queryTimeoutMs`, `queryTemplate`, `documentTemplate`, `concurrency`, and
`ollamaOptions.num_ctx`. An `embedding` with a `model` and no `endpoint` names a
model the default connection serves, at its endpoint and with its key; with no
default connection there is nothing to serve it, and the built-in local embedder
runs, with a warning.

Retrieval models expect a prompt around queries and documents. akm picks it by
model name (`src/llm/embedders/profile.ts`): Qwen3-Embedding gets
`Instruct: Given a question or task, retrieve the knowledge asset that helps with it\nQuery:{text}`
on queries; nomic-embed `search_query: ` / `search_document: `; the BGE
English, mxbai and arctic models `Represent this sentence for searching
relevant passages: ` on queries; E5 `query: ` / `passage: `; any other model
none. `embedding.queryTemplate` and `embedding.documentTemplate` override the
preset (`{text}` marks where the text goes, a template without it is a prefix,
and `""` means none). The document template is part of the embedding
fingerprint, so changing it re-embeds the index; the query template applies
at search time only. `embedding.queryTimeoutMs` (default `3000`) bounds how
long a search waits for its query embedding before falling back to keyword
ranking with a warning.

The knobs that bound request/document size and rate, all optional (defaults
apply when unset), for a remote endpoint (`src/llm/embedders/remote.ts`):

| Key | Default | Bounds |
| --- | --- | --- |
| `embedding.maxInputTokens` | `512` | Per-DOCUMENT cap, applied before batching (#956). A document's embedded text is truncated to its head (unicode-safe) at this many estimated tokens instead of ever being skipped for size alone — a document is skipped only when its truncated head is empty. |
| `embedding.maxTokens` | `6000` (`DEFAULT_TOKEN_BUDGET`) | Per-REQUEST token budget: how many (already-capped) documents' estimated tokens fit in one HTTP request. With the 512-token default document cap, a request carries about 11 documents by default. Lowered from 8000 to 6000 (#954): the 4-chars-per-token estimator undercounts dense technical text by 7-55%, so 8000 regularly overshot an 8192-token endpoint's real context window. |
| `embedding.batchSize` | `100` | Per-REQUEST document-COUNT safety cap, independent of the token budget — guards against many tiny documents packing an oversized request. |
| `embedding.contextLength` | unset | Ollama's `num_ctx` ONLY, forwarded verbatim as `options.num_ctx` on the native `/api/embed` request. Does **not** feed the request token budget above (#956) — the two used to share this one field, so setting it for the server's context window silently changed request batching too. |
| `embedding.timeoutMs` | `120000` (120s) | Per-request wall timeout — see below. |
| `embedding.concurrency` | `1` loopback / `2` remote | In-flight request window — see below. |

**Which knob fixed the field's 8k-context overflow, worked examples.** A
0.9.15-beta field report described documents estimated under the request
budget that still tokenized to 8.5k-12.4k real tokens against an
8192-token endpoint, because the 4-chars-per-token estimator undercounts
dense technical text. Three knobs changed shape between beta and this
release; only one of them makes that overflow structurally unreachable:

- `embedding.maxInputTokens: 512` — per-DOCUMENT cap, applied before
  batching. Example: a 6,000-character API reference page is truncated to
  its first ~2,000 characters (512 estimated tokens) before it is ever
  counted toward a request. This is the fix for the original overflow: no
  single document can contribute more than 512 estimated tokens to a
  request, no matter how `maxTokens` or `contextLength` are set.
- `embedding.maxTokens: 6000` — per-REQUEST budget: how many already-capped
  documents' estimated tokens fit in one HTTP request. Example: with the
  default 512-token document cap, a request packs about 11 documents before
  this budget is reached and the request is sent; if the run's first
  request is still rejected for exceeding the endpoint's real context
  window, akm shrinks this budget to three quarters of its value (floored
  at twice `maxInputTokens`) for every later request in the same run. A
  request-level budget alone cannot stop one oversized document from
  overflowing a request — only the per-document cap above does that.
- `embedding.contextLength: 8192` — Ollama's `num_ctx` only, forwarded
  verbatim on a native `/api/embed` request. It has no effect on request or
  document sizing, and no effect at all against a non-Ollama endpoint — see
  below for why that used not to be true.

A field config of `contextLength: 8192` + `maxTokens: 8000` (the exact
0.9.15-beta values from the original report) produces no 400s on 0.9.15:
`maxInputTokens` (512, new this release) caps every document before it is
counted, so the original 8.5k-12.4k-token documents that overflowed the
8192-token endpoint can never reach the request budget in the first place —
independent of whatever `maxTokens` or `contextLength` are set to.

`embedding.timeoutMs` (positive integer, default `120000` — 120s) is the
budget for a request at the FULL token budget (`embedding.maxTokens`); a
local model server on a large, token-budget-bounded batch legitimately takes
longer than the prior fixed 30s cut off. A smaller request gets a
proportionally smaller timeout —
`clamp(timeoutMs × requestTokens / tokenBudget, 30000, timeoutMs)` — so a
dead endpoint is still detected in seconds on the common case of small
documents. Set `embedding.timeoutMs` lower to fail fast against a
known-fast endpoint, or higher for a slow local server on large batches.

`embedding.maxTokens` (or its default) is also a run-scoped adaptive
starting point, not a hard ceiling (#954): on the FIRST rejection of an
`akm index` run for exceeding the endpoint's context window, akm shrinks
the request budget to three quarters of its current value — floored at
twice `embedding.maxInputTokens` — for every request not yet sent, and
prints one line naming the new value. This never changes the rejected
request's own split-and-retry (below), never shrinks a second time in the
same run, and never grows the budget back up. Users who set
`embedding.maxTokens` explicitly are unaffected by the LOWERED DEFAULT
above but still benefit from this same-run recovery if their own value
turns out to be too high for the endpoint.

A request TIMEOUT (not a rejection for exceeding the context window) never
drops its batch immediately: field confirmation showed that once akm
abandons a timed-out request, the endpoint (e.g. llama-server) keeps
computing it anyway, so dropping it right away just grows the provider's
queue while every following batch dies the same way. Instead akm backs off
(5s, doubling, capped at 60s) and retries the same request once; a second
timeout splits it in half and retries each half the same way, down to
individual documents, and a single document that still times out is finally
skipped (logged at the default `warn` level). After 3 consecutive failures
at single-document size (timeout or network error), or 3 consecutive
network errors at any size, the embedding phase stops dispatching further
requests and reports failure — batches already committed are kept; rerun
`akm index` once the endpoint is healthy.

`akm index` keeps a small number of `/v1/embeddings` requests in flight at
once (a remote endpoint only; the local transformer path is unaffected):
`1` for a loopback endpoint (`localhost`, `127.0.0.0/8`, etc. — a local
model server serves one inference at a time, and parallel requests thrash
it) and `2` for a remote one, unless `embedding.concurrency` (positive
integer, 1-16) overrides it. This default holds for the overwhelming
majority of setups; set the override only for an endpoint that genuinely
serves parallel requests — a local server started with a multi-slot flag
(llama.cpp's `--parallel N`, vLLM) — not to "speed up" an ordinary
single-slot model server, which the default already protects from
reload-thrash. Request SIZE remains the first throughput lever regardless:
`embedding.batchSize` (a document-count cap, default 100) together with
`embedding.maxTokens` (an estimated token budget per request, default 6000
— NOT `embedding.contextLength`, see the table above) control how many
documents land in one request — with the default 512-token
`embedding.maxInputTokens` document cap, that is about 11 documents,
taking about the same wall time as a single one against a healthy endpoint.

## Search tuning

`search` sets which types search leaves out by default, and the optional curate reranker:

| Key | Purpose |
| --- | --- |
| `search.defaultExcludeTypes` | Asset types excluded from results by default |

### Curate rerank (#951)

An optional cross-encoder rerank pass over the top fused search candidates
`akm curate` fetches, via a standalone `/rerank`-style HTTP endpoint (not a
connection or a harness). Each candidate is sent as its
name, description and the start of its indexed content (2,000 characters in
all). Disabled by default; a misconfigured endpoint, network failure, timeout,
or malformed response keeps the fused order.

| Key | Purpose |
| --- | --- |
| `search.curateRerank.enabled` | Turn the rerank pass on (default `false`) |
| `search.curateRerank.endpoint` | Full URL of the reranker's rerank endpoint |
| `search.curateRerank.model` | Model name sent to the endpoint (optional) |
| `search.curateRerank.apiKey` | `$VAR` reference (optional); absent, the `curateRerank` service's entry in `credentials.json` |
| `search.curateRerank.timeoutMs` | Request timeout (default `10000`) |
| `search.curateRerank.topN` | How many of the top fused candidates to rerank (default `30`, max `50`) |

## Feedback

`feedback` configures `akm feedback`:

| Key | Purpose |
| --- | --- |
| `feedback.requireReason` | Whether `akm feedback --negative` without `--reason` is a hard error. **Defaults to `true`** when unset — set `false` to downgrade the check to a warning instead |

## Bundles and write target

`bundles` (replacing the retired `stashDir`/`sources[]`/`installed[]` trio)
and `defaultBundle` are the 0.9 source configuration shape — see
[Concepts](https://github.com/itlackey/akm/blob/main/docs/guides/concepts.md) and the [CLI reference](cli.md) for the
full bundle model (`path`, `git`, `website`, `npm`, `writable`, `registryId`,
`components`). `defaultBundle` must name a key in `bundles` when set. A
bundle's `components.<id>.adapter` key pins it to a specific format adapter
instead of relying on auto-detection — see [Bundle Types](bundle-types.md)
for the full adapter list and what each one reads/writes.

Each physical content root has one bundle id. Duplicate paths and symbolic-link
aliases are rejected because source ownership, scheduler authority, and default
selection must not depend on which spelling a caller used. If an older config
contains aliases, choose the id whose durable refs should survive and remove
the other entry before running ordinary commands.

### defaultWriteTarget

`defaultWriteTarget` names the bundle that write commands (`akm remember`,
`akm env`/`secret create`, `akm improve`, etc.) fall back to when no
explicit destination flag is given and the command isn't already scoped to a
specific source. It must name a configured bundle; setting it with no
`bundles` configured, or naming an unconfigured bundle, is rejected at
`config set` (or config load) time. The full write-target resolution order
is the command's destination flag (`--bundle`) -> `defaultWriteTarget` ->
working bundle (`defaultBundle`) -> `ConfigError`.

### Memory scope

`akm remember`'s scope flags (`--user`, `--agent`, `--run`, `--channel`)
write four canonical top-level frontmatter keys on the memory file:
`scope_user`, `scope_agent`, `scope_run`, `scope_channel` (one key per
non-empty scope value; string values). This is not a config-file setting —
it is documented here because it is the multi-tenant/multi-agent contract
that `akm search --filter` and `akm show --filter` read back:
`--filter user=<id>` / `--filter agent=<id>` / `--filter run=<id>` /
`--filter channel=<name>` (repeatable) narrow results/resolution to assets
whose frontmatter scope matches, without changing ranking. A memory with
only scope flags and no tags is valid — the tag-required check is
independent of scope. `--scope` was removed in 0.9.0 with no alias; use
`--filter`.

`archiveRetentionDays` (default `90` when unset) controls how long a pending
proposal is kept before `akm improve`'s maintenance pass archives it (status
`rejected`, reason `"expired: no action within retention window"`; counted
from the last `akm proposal reopen`, if there was one) — `akm proposal` itself
has no archive/expire verb, though `akm proposal reopen` puts an expired
proposal back. Setting it to `0` or less disables expiry entirely.

## Registries

`registries` (top-level array, distinct from `bundles`) lists remote package
registries `akm registry`/`akm bundle add` can search and install from.
Each entry is `{ url, name?, enabled?, provider?, options? }`; `provider`
defaults to `"static-index"`. See [Registries](https://github.com/itlackey/akm/blob/main/docs/reference/registry.md) for the full
field reference and provider list.

Registry `url` values must not contain username/password userinfo. The built-in
providers do not currently support authenticated registry requests; `options`
does not add an authentication mechanism. Use a credential-free HTTPS endpoint.

## Output defaults

`output.format` (one of `json`\|`yaml`\|`text`\|`jsonl`\|`md`\|`html`,
default `json`) and `output.detail` (`brief`\|`normal`\|`full`, default
`brief`) set the CLI's default `--format`/`--detail` when the flags are
omitted. Per-command flags always override these.

## Setup-derived recommendations

`setup` is reserved for configuration derived by `akm setup`. It currently
holds no keys — the `setup.taskSchedules` sub-key was removed in 0.9.0 after
nothing in the setup flow or the tasks subsystem was found to read or write
it. Scheduling lives in the tasks subsystem (`akm task`).

## Experimental opt-ins

`experimental` holds explicit opt-ins for behavior outside the 0.9
stability contract (see [STABILITY.md](../../STABILITY.md) for full
classification). Every key defaults to **off**; an absent `experimental`
section, an absent key, and an explicit `false` all read identically as off.

```jsonc
{
  "experimental": {
    "improveAutonomy": false
  }
}
```

- **`experimental.improveAutonomy`** — gates only the autonomous
  `memoryInference`, `triagePromote` (a promote with triage judgment on; a
  deterministic-only promote runs without it), and `memoryCleanup` lanes. `akm improve`
  itself always runs; this only gates mutations without a human in the loop.
  Consolidation is not gated: it remains advisory and emits reviewable
  proposals. `sync.push` is deliberately **not** gated by this key.

## Managing Config

```sh
akm config list
akm config get connections.default
akm config set connections.fast '{"endpoint":"http://localhost:11434/v1","models":{"fast":"qwen3-8b"}}'
akm config set connections.fast.apiKey '$LOCAL_LLM_API_KEY'
akm config unset connections.old
```

Object values passed to `config set` deep-merge with their current value.
Arrays replace, `null` is only valid for nullable fields, and `config unset` is
the only deletion operation. `configVersion` cannot be set or unset with the
generic walker.

`config get <key> --show-source` wraps the (redacted) value as
`{ value, source }`, where `source` is `"local"` when the local file's own
JSON sets the key, `"extends:<ref>"` for the nearest `extends` chain member
that sets it, or `"default"` when neither does. It is opt-in — plain
`config get` keeps its Stable, script-safe bare-value shape.

### Sharing configuration across installs

Five hosts running the same fleet often carry an identical `connections` map and
`improve.strategies` block, differing only in credential delivery, bundle paths,
and cron offsets. Hand-syncing that block across hosts drifts silently. `extends` fixes this: put the shared block in
one file, and have each host's local config extend it.

```jsonc
// bundles/fleet/config/shared.json — versioned with the bundle, shared by every host
{
  "configVersion": "0.9.0",
  "connections": {
    "fast": { "endpoint": "https://api.example.test/v1", "models": { "fast": "qwen3", "balanced": "qwen3" } }
  },
  "improve": { "connection": "fast", "strategies": { "nightly": { "processes": { "reflect": { "limit": 10 } } } } }
}
```

```jsonc
// ~/.config/akm/config.json — this host's local file, under 20 lines
{
  "configVersion": "0.9.0",
  "extends": "fleet//config/shared.json",
  "bundles": {
    "fleet": { "git": "https://github.com/example/fleet-bundle.git" },
    "stash": { "path": "~/akm-stash", "writable": true }
  },
  "defaultBundle": "stash",
  "connections": { "fast": { "apiKey": "$FAST_API_KEY" } }
}
```

`extends` accepts either form:

- A filesystem path — relative paths resolve against the directory of the
  config file that declares them; a leading `~` expands.
- A `bundle//<path>` ref — a plain file path *relative to that bundle's
  content root* (e.g. `config/shared.json`), resolved through the bundle's
  configured `path`, not the search index — so it never needs `akm index` to
  have run. This is not an asset ref: the path after `//` needs no asset type
  (`scripts/`, `knowledge/`, …) and the shared file is never indexed; it can
  live anywhere under the bundle. An empty, absolute, or content-root-escaping
  path is rejected. Only a filesystem bundle (`bundles.<id>.path`) can host an
  `extends` source; sync a `git`/`website` bundle with `akm bundle
  add`/`akm sync` first so the file is materialized locally, then point
  `extends` at it.

Shared layers carry portable policy, not host authority. `bundles`, source and
write defaults, registries, embedding connections, scheduler activation,
`experimental`, and setup state are ignored when inherited.
Connection and harness definitions may be shared, but credentials and
executable authority (`apiKey`, `bin`, `args`, and `workspace`) are ignored
when inherited and must be supplied by the local file; a key in the host's
`credentials.json` needs no entry at all. Improve publication (`strategies.*.sync`) and reranker network
configuration are local as well. Bundle-relative chains stay physically inside
the bundle root for every hop; lexical `..` paths and symlink escapes are both
rejected before a referenced file is read.

There is no `extends: <url>` form: config load is synchronous and runs on
every invocation, and akm deliberately does not fetch network resources at
load time (the same reason `registries` is never fetched until a
registry-touching command runs). A URL-backed shared config should be synced
as a `git`/`website` bundle and referenced as `extends: bundle//<path>`
once materialized, reusing the sync machinery akm already has instead of a
second one inside config load.

The base config runs through the exact same load pipeline as the local
file — its own version shim, its own legacy-shape shim — so it can carry an
older `configVersion` independently, and it may itself set `extends`
(chained). Cycle detection (`ConfigError`, "extends cycle detected") stops A
extends B extends A instead of recursing forever. Merge order is
`DEFAULT_CONFIG` (outermost) → the resolved `extends` chain → the local
file's own keys (local always wins) — the same `deepMergeConfig` "override
wins" semantics `config set` already uses. A referenced file/bundle that does
not already exist locally is a load-time `ConfigError` naming the ref — akm
never fetches or syncs one on your behalf.

`akm config diff <path|bundle//path>` compares this host's EFFECTIVE
config (its own `extends` already applied) against another config file or
bundle-relative file (loaded through the same loader, so ITS `extends` is
honoured too), printing sorted `{ path, local, other }` rows for every leaf
that differs. Both sides are redacted the same way `config get`/`list` are
before comparison, so a differing secret never round-trips into the diff
output. Cross-host comparison (`ssh host2 akm config diff ...` in a loop) is
left to the operator; akm has no concept of a networked fleet to compare
against directly.

```sh
akm config diff ~/other-host/config.json
akm config diff fleet//config/shared.json
```

## Environment

| Variable | Purpose |
| --- | --- |
| `AKM_CONFIG_DIR` | Override the user config directory (or set `XDG_CONFIG_HOME`) |
| `AKM_BUNDLE_DIR` | Override the bundle directory |
| `AKM_DATA_DIR` | Override the data directory — `index.db`, durable `state.db`, and `akm.lock` (or set `XDG_DATA_HOME`) |
| `AKM_CACHE_DIR` | Override the cache directory — regenerable caches (or set `XDG_CACHE_HOME`) |
| `AKM_STATE_DIR` | Override the state directory — task-scheduler invocation state, and (per stash) `akm improve`'s machine-local writers and whole-run lock (or set `XDG_STATE_HOME`) |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode: `WAL` (default), `DELETE`, or `TRUNCATE` |
| `AKM_VERBOSE` | Truthy value enables the same diagnostics as `--verbose` |
| `AKM_DEBUG` | `1` prints a stack trace on unexpected internal errors |

Use `AKM_SQLITE_JOURNAL_MODE=DELETE` or `TRUNCATE` when WAL is unavailable,
such as on some NFS/SMB mounts. With the default `WAL` setting, AKM detects a
network filesystem for the data directory and falls back to `DELETE`.

## Retired Configuration

A key akm no longer reads is named once, ignored, and dropped by `akm migrate
apply`. That covers `profiles`, `llm`, `agent`, `features`, `stashes`,
`defaults.llm`, `defaults.agent`, `defaults.improve`, the settings that sat
under `index.<pass>` (`endpoint`, `provider`, `apiKey`, `baseUrl`,
`temperature`, `maxTokens`, `capabilities`), `index.graph.*`, every strategy's
`processes.graphExtraction.*`, a strategy's `processes.feedbackDistillation`
(use `processes.distill.enabled`), `processes.consolidate.incrementalSince`
and `neighborsPerChanged`, and `embedding.chunkSize`. The strategy name
`graph-refresh` is always refused, even when `improve.strategies["graph-refresh"]`
holds an override; `akm migrate apply` drops the override.

### The `engines` form

A config that holds `engines` or `defaults` loads: akm reads it in memory as
`connections` and `harnesses`, with one warning that names `akm migrate apply`.
`akm migrate apply` makes the same conversion permanent, under a backup, and
prints a note for everything it cannot carry. Credentials, `models.json` and
asset keys move as the table says.

| In the file | What `akm migrate apply` does |
| --- | --- |
| `engines.<name>` with `kind: "llm"` | `connections.<name>`. `endpoint`, `contextLength`, `timeoutMs`, `concurrency` and an `apiKey` that is a `$VAR` are kept. `model` becomes `models`, with `fast`, `balanced` and `reasoning` all naming it. `temperature`, `maxTokens`, `enableThinking`, `reasoningEffort` and `extraParams` become request fields (`temperature`, `max_tokens`, `enable_thinking` with `chat_template_kwargs.enable_thinking`, `reasoning_effort`, and the extras as written). `kind`, `provider` and `supportsJsonSchema` are dropped, with a note. |
| `engines.<name>` with `kind: "agent"` and `platform: "opencode-sdk"` | Removed: akm's own runtime has no entry. Its `llmEngine` connection becomes `default`. |
| `engines.<name>` with `kind: "agent"`, any other platform | `harnesses.<name>`, keeping `platform`, `bin`, `args`, `workspace`, `agent` and `timeoutMs`. `model` becomes `models`, naming it for all three aliases. |
| `defaults.llmEngine`, else `defaults.engine` when it names an LLM engine | That connection is renamed `default`, and every reference to the old name follows. An entry already called `default` moves aside to `legacy-default`, or the first `legacy-default-<n>` nothing else has: the renaming is one name to one name, so no two entries share a name and none is lost. |
| `defaults.engine` naming an agent engine, when there are several | That harness is renamed `default`. |
| `defaults.improveStrategy` | `improve.strategy`. |
| `models.json` | Folded into the `models` of the connections and harnesses it names; what it cannot place is listed in the notes. The file moves to `config-backups/` in the cache directory. |
| `apiKeyFile`, a literal `apiKey`, a `${secrets/...}` `apiKey` | The key moves to `credentials.json` for the connection and its endpoint; a note names where it was, never its value. A key that cannot be read stays on the connection as it was (`apiKey`, or `apiKeyFile` for a key file), with a note that it is still to do; a later run moves it once it can be read. |
| `AKM_ENGINE_<NAME>_API_KEY` or `AKM_LLM_API_KEY` set in the environment | `apiKey: "$AKM_ENGINE_<NAME>_API_KEY"` (or `$AKM_LLM_API_KEY`) on that connection. |
| `improve.strategies.<name>.engine`, `model`, `llm`, `timeoutMs` | Dropped, with a note: a strategy says which processes run, not where. |
| `engine`, `model`, `llm`, `timeoutMs` on a strategy's process, its `qualityGate` or its `triage.judgment` | Moved to `improve.processes.<process>` or `improve.qualityGate`, with `engine` becoming `connection` or `harness` by what it named. When that place already says, the first one is kept, with a note. |
| `index.defaults.*`, `index.<pass>.engine` | `index.*`, and `connection`. An index pass cannot name a harness, so an engine that named one is dropped, with a note; a pass that names nothing runs where model work does: on the default connection, else the default harness. |
| `workflow.judgeEngine` | Dropped, with a note. |
| `engine:` in an asset's frontmatter, a workflow step or a task source | `connection:` or `harness:`, by what the configured target is; a name it cannot place becomes `harness:`, with a note. A bundle akm may not change is skipped. |

An `engine:` key on an asset that has not been migrated is read the same way,
with a one-time notice. While the config file is still in the `engines` form it
names the connection or harness that engine became, so `engine: lab` still means
the engine called `lab` after the conversion has renamed it `default`; once the
file is migrated it names a connection by that name, else a harness. The names
the engines had are kept in akm's data directory (`migrate/engine-targets.json`)
until no asset is left skipped, so an asset that was read-only, or a retried
`akm migrate apply`, is rewritten under the same names.


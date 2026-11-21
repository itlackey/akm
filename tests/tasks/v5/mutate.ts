// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Break each rule of the version 5 checker and runner in turn and confirm a test fails.
 *
 * Run by hand and before a beta, not in CI:  bun tests/tasks/v5/mutate.ts
 * Words after it pick the breakages whose name holds one of them:  bun tests/tasks/v5/mutate.ts timeout retries
 *
 * The code is copied once to a temporary folder; each breakage is one exact-text replacement in that copy, tested with
 * the checker's tests and then the runner's (`bun test`), and undone. A snippet that does not match exactly once stops the run: the code moved and
 * this table must follow it. A rule whose breakage no test notices prints NOT CAUGHT and the run exits 1.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SOURCE = "src/tasks/v5/source.ts";
const CHECK = "src/tasks/v5/check.ts";
const ROUTER = "src/tasks/source/parse-task-source.ts";
const OWNER_V4 = "src/tasks/source/task-source-v4.ts";
const OWNER_INPUTS = "src/execution/input-contract.ts";
const OWNER_TIMEOUT = "src/cli/parse-args.ts";
const RUN = "src/tasks/v5/run.ts";
const OWNER_REDACTION = "src/core/redaction.ts";
const OWNER_CLEAN_ENV = "src/commands/env/child-env.ts";
const OWNER_RETRY = "src/execution/retry.ts";
const OWNER_SUBPROCESS = "src/core/subprocess.ts";
const LOADER = "src/tasks/run/load-task.ts";
const LIFECYCLE = "src/tasks/run/attempt-lifecycle.ts";
const ENV_BINDING = "src/commands/env/env-binding.ts";
const REF_TOKEN = "src/core/ref-token.ts";

interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

const m = (name: string, file: string, from: string, to: string): Mutation => ({ name, file, from, to });
/** Drop the call this text is. */
const skip = (name: string, file: string, from: string): Mutation => m(name, file, from, "void 0;");

const START_FLAGS = ["env", "secret", "cwd", "timeout", "resume", "inherit"];
const FLAG_KEYS = ["env", "secret", "inherit", "timeout", "max-retries"];
const START_FLAGS_SOURCE = `const START_FLAG_NAMES = [${START_FLAGS.map((name) => `"${name}"`).join(", ")}];`;
const FLAG_KEYS_SOURCE = `[${FLAG_KEYS.map((name) => `"${name}"`).join(", ")}],`;

const MUTATIONS: readonly Mutation[] = [
  // A step is one akm command
  m(
    "run: takes a shell line",
    SOURCE,
    'if (!kind) fail([...base, "run"], "takes a ref; use exec: for anything else.");',
    'if (!kind) return "exec";',
  ),
  m(
    "a step may be two commands",
    SOURCE,
    'if (own(step, "exec")) fail(base, "is one command.");',
    'if (false) fail(base, "is one command.");',
  ),
  m(
    "exec: and prompt: may share a step",
    SOURCE,
    'if (own(step, "prompt")) fail(base, "is one command.");',
    'if (false) fail(base, "is one command.");',
  ),
  m("prompt: may sit beside any run:", SOURCE, 'if (own(step, "prompt") !== (kind === "agents")) {', "if (false) {"),
  m(
    "a step may be no command",
    SOURCE,
    'return fail(base, "is one command: run:, exec: or prompt:.");',
    'return "exec";',
  ),
  m(
    "a task may be a command and steps:",
    SOURCE,
    'if (!single && (own(root, "run") || own(root, "exec") || own(root, "prompt"))) {',
    "if (false) {",
  ),
  m(
    "args: is accepted on anything",
    SOURCE,
    'if (args !== undefined && kind !== "tasks" && kind !== "scripts")',
    "if (false)",
  ),
  m(
    "args: is refused on a script",
    SOURCE,
    'if (args !== undefined && kind !== "tasks" && kind !== "scripts")',
    'if (args !== undefined && kind !== "tasks")',
  ),
  m(
    "a list is taken where text belongs",
    SOURCE,
    'if (own(raw, key) && typeof raw[key] !== "string") fail([...base, key], "is text.");',
    'if (false) fail([...base, key], "is text.");',
  ),
  m(
    "something other than a list is taken for env:, secret: or inherit:",
    SOURCE,
    'if (!Array.isArray(value)) fail(at, "is a list.");',
    'if (false) fail(at, "is a list.");',
  ),
  m(
    "cwd:, harness:, connection: or model: may be a list",
    SOURCE,
    '} else if (key === "cwd" || key === "harness" || key === "connection" || key === "model") {',
    "} else if (false) {",
  ),
  m(
    "args: may be something other than a list",
    SOURCE,
    'if (args !== undefined && !Array.isArray(args)) fail([...base, "args"], "is a list.");',
    'if (false) fail([...base, "args"], "is a list.");',
  ),
  m(
    "an item of args: may be more than one argument",
    SOURCE,
    'if (value === null || typeof value === "object") fail(at, "is one argument.");',
    'if (false) fail(at, "is one argument.");',
  ),
  m(
    "the items of a script's args: are not checked",
    SOURCE,
    "of (args ?? []).entries())",
    'of (kind === "tasks" ? (args ?? []) : []).entries())',
  ),
  m(
    "a task's args: need not be --name value pairs",
    SOURCE,
    'if (name === undefined || i + 1 === args.length) fail(at, "of a task are --<name> <value> pairs.");',
    "if (name === undefined) continue;",
  ),
  m(
    "a task's args: may end with a flag that has no value",
    SOURCE,
    'if (name === undefined || i + 1 === args.length) fail(at, "of a task are --<name> <value> pairs.");',
    'if (name === undefined) fail(at, "of a task are --<name> <value> pairs.");',
  ),
  m("arguments: is accepted on anything", SOURCE, 'if (own(raw, "arguments") && kind !== "commands")', "if (false)"),
  m(
    "expect: is accepted on a command",
    SOURCE,
    'if (own(raw, "expect") && (kind === "exec" || kind === "scripts" || kind === "tasks")) {',
    "if (false) {",
  ),
  m(
    "a ref to an asset that does not exist is accepted",
    CHECK,
    "    throw inContext(where, cause);\n  }\n}\n\n/**\n * The inputs given",
    '    return { file: "", bundle };\n  }\n}\n\n/**\n * The inputs given',
  ),
  m(
    "a missing prompt asset is accepted",
    CHECK,
    "const asset = await locateTaskV5Asset(found.bundle, target, step.kind, at);",
    'const asset = step.kind === "commands" ? { file: "" } : await locateTaskV5Asset(found.bundle, target, step.kind, at);',
  ),
  m(
    "a missing agent is accepted",
    CHECK,
    "const asset = await locateTaskV5Asset(found.bundle, target, step.kind, at);",
    'const asset = step.kind === "agents" ? { file: "" } : await locateTaskV5Asset(found.bundle, target, step.kind, at);',
  ),
  m(
    "a missing script is accepted",
    CHECK,
    "const asset = await locateTaskV5Asset(found.bundle, target, step.kind, at);",
    'const asset = step.kind === "scripts" ? { file: "x.sh" } : await locateTaskV5Asset(found.bundle, target, step.kind, at);',
  ),
  m(
    "a missing task is accepted",
    CHECK,
    'const found = await locateTaskV5Asset(bundle, ref, "tasks", where);',
    'const found = await locateTaskV5Asset(bundle, ref, "tasks", where).catch(() => ({ file: "", bundle }));',
  ),
  m(
    "another bundle's ref is read from this bundle",
    CHECK,
    "const owner = parsed.bundle ?? bundle.name;",
    "const owner = bundle.name;",
  ),
  m(
    "a task's refs are read from the caller's bundle",
    CHECK,
    "await checkTask(found.bundle, target, given, known, visited, at);",
    "await checkTask(bundle, target, given, known, visited, at);",
  ),
  m(
    "a task's assets are read from the caller's bundle",
    CHECK,
    "const asset = await locateTaskV5Asset(found.bundle, target, step.kind, at);",
    "const asset = await locateTaskV5Asset(bundle, target, step.kind, at);",
  ),
  m(
    "tasks that run each other in a loop are not checked",
    CHECK,
    "if (trail.some((visited) => visited.file === found.file)) {",
    "if (false) {",
  ),
  m("a version 4 task may be run by a step", CHECK, "if (parsed.version === 4) {", "if (false) {"),
  // Inputs
  m(
    "an undeclared input is accepted",
    CHECK,
    "if (!declared.includes(name)) throw TASK_INPUT_DIAGNOSTICS.unknownFlag(name, [...declared].sort());",
    "void 0;",
  ),
  m(
    "a missing input is accepted",
    CHECK,
    "if (errors.length > 0) throw TASK_INPUT_DIAGNOSTICS.contractViolation(errors);",
    "void 0;",
  ),
  m(
    "an input given by a calling step does not count as given",
    CHECK,
    "const known = Object.fromEntries(Object.entries(contract).filter(([name]) => !later.has(name)));",
    "const known = contract;",
  ),
  m(
    "the values given are not converted at lint",
    CHECK,
    'else given.push({ name, value: typeof value === "boolean" ? value : String(value) });',
    "else void value;",
  ),
  m(
    "a literal in a calling step's args: is not checked at lint",
    CHECK,
    'if (typeof value === "string" && WHOLE_TOKEN.test(value)) known.add(name);',
    "known.add(name);",
  ),
  m(
    "a number is taken as text",
    OWNER_INPUTS,
    'if (raw.trim() !== "" && Number.isFinite(value)) return value;',
    "return raw;",
  ),
  m(
    "a boolean is taken as text",
    OWNER_INPUTS,
    'if (raw === "true") return true;\n        if (raw === "false") return false;',
    "return raw;",
  ),
  m(
    "an input may be something other than a map",
    OWNER_V4,
    "const declInput = asRecord(raw, ctx, declPath);",
    "const declInput = raw as ExecutionJsonObject;",
  ),
  m(
    "required: may be any value",
    OWNER_V4,
    'if (own(declInput, "required") && typeof declInput.required !== "boolean") {',
    "if (false) {",
  ),
  m(
    "an input may be named like a flag of akm run",
    OWNER_V4,
    "if (TASK_RUN_RESERVED_FLAG_NAMES.has(name)) {",
    "if (false) {",
  ),
  ...START_FLAGS.map((name) =>
    m(
      `an input may be named --${name}`,
      SOURCE,
      START_FLAGS_SOURCE,
      `const START_FLAG_NAMES = [${START_FLAGS.filter((flag) => flag !== name)
        .map((flag) => `"${flag}"`)
        .join(", ")}];`,
    ),
  ),
  m(
    "the flags an input may not be named like are not looked at",
    SOURCE,
    "if (START_FLAG_NAMES.includes(name)) {",
    "if (false) {",
  ),
  // Names, shapes and ${name}
  m("two steps may share a name", SOURCE, "if (seen.includes(name)) fail(", "if (false) fail("),
  m("a step may be named like an input", SOURCE, "if (declaredNames.includes(name)) fail(", "if (false) fail("),
  m(
    "a step may have no name",
    SOURCE,
    'if (!single && (typeof raw.name !== "string" || !STEP_NAME.test(raw.name))) {',
    "if (false) {",
  ),
  m(
    "a step name may have any characters",
    SOURCE,
    "const STEP_NAME = /^[A-Za-z0-9_-]+$/;",
    "const STEP_NAME = /^[A-Za-z0-9_ .-]+$/;",
  ),
  m(
    "lock: may be something other than a boolean",
    SOURCE,
    'if (own(root, "lock") && typeof root.lock !== "boolean") fail(["lock"], "is true or false.");',
    'if (false) fail(["lock"], "is true or false.");',
  ),
  m("steps: may be empty", SOURCE, "root.steps.length > 0 && ", ""),
  m("steps: may be something other than a list", SOURCE, "Array.isArray(root.steps) && ", ""),
  m("a step may be something other than a map", SOURCE, " && root.steps.every(isMap))) {", ")) {"),
  m(
    "expect: may be something other than a list",
    SOURCE,
    'if (own(raw, "expect") && !(Array.isArray(raw.expect) && raw.expect.every((key) => typeof key === "string"))) {',
    "if (false) {",
  ),
  skip(
    "a state entry may be named in an exec: command",
    SOURCE,
    "fail(at, `does not put \\${${body}} into a command; the command reads the state file.`);",
  ),
  skip(
    "a secret may be written in an exec: command",
    SOURCE,
    'if (isSecretRef(body as string)) fail(at, "holds a secret ref; a secret goes under secret:, not into a command.");',
  ),
  skip(
    "a secret may be written in a prompt",
    SOURCE,
    'if (isSecretRef(body as string)) fail(at, "holds a secret ref; a secret goes under secret:, never into a prompt.");',
  ),
  skip(
    "a secret may be passed in args:",
    SOURCE,
    'if (isSecretRef(body as string)) fail(at, "holds a secret ref; a secret goes under secret:, and is not an input.");',
  ),
  skip(
    "a secret may be written in an env: value",
    SOURCE,
    'fail([...at, name], "holds a secret ref; a secret goes under secret:, not here.");',
  ),
  skip(
    "a secret ref may be named under env:",
    SOURCE,
    "if (isSecretRef(entry)) fail(at, `names a secret; a secret goes under secret:, not env:.`);",
  ),
  skip(
    "an unknown ${name} in a prompt is accepted",
    SOURCE,
    "if (unknown !== undefined) fail(at, `\\${${unknown}} is not an input or an earlier step.`);",
  ),
  m("an unknown ${name} in args: is accepted", SOURCE, "if (!known(whole)) fail(", "if (false) fail("),
  m(
    "${name} in args: need not be the whole value",
    SOURCE,
    'if (whole === undefined) fail(at, "must be a whole item: ${name} is one argument.");',
    "if (false) void 0;",
  ),
  skip(
    "a state entry may go into env:",
    SOURCE,
    'fail([...at, name], "does not take a state entry; a state entry does not go into env:.");',
  ),
  skip(
    "cwd: takes a state entry",
    SOURCE,
    'fail(at, "does not take a state entry; a state entry does not go into cwd:.");',
  ),
  m(
    "env: may set a name that is not a variable name",
    SOURCE,
    "if (!WORKFLOW_ENV_VAR_NAME_PATTERN.test(name)) fail([...at, name], `${name} is not a variable name.`);",
    "void 0;",
  ),
  m(
    "an env value may be a list",
    SOURCE,
    'if (!["string", "number", "boolean"].includes(typeof value)) fail([...at, name], "is text.");',
    "void 0;",
  ),
  m(
    "an env entry may be something other than a map or a ref",
    SOURCE,
    'if (!isMap(entry)) fail(at, "is an env asset\'s ref or NAME: value.");',
    "void 0;",
  ),
  m(
    "inherit: takes any name",
    SOURCE,
    'if (typeof name !== "string" || !WORKFLOW_ENV_VAR_NAME_PATTERN.test(name))',
    "if (false)",
  ),
  m(
    "secret: takes anything",
    SOURCE,
    'if (typeof entry !== "string" || parseSecretSpec(entry) === undefined)',
    "if (false)",
  ),
  m(
    "a secret's variable name is not checked",
    REF_TOKEN,
    "if (colon <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) return undefined;",
    "if (colon <= 0) return undefined;",
  ),
  // Options
  skip("a timeout: that is no duration is accepted", SOURCE, "parseTimeoutValue(String(value), `${key}:`);"),
  m(
    "a timeout: of nothing is a duration",
    OWNER_TIMEOUT,
    "if (!Number.isSafeInteger(parsed) || parsed <= 0) {",
    "if (!Number.isSafeInteger(parsed) || parsed < 0) {",
  ),
  m(
    "a max-retries: that is no count is accepted",
    SOURCE,
    'if (typeof value !== "number" || !Number.isInteger(value) || value < 0)',
    "if (false)",
  ),
  m(
    "a max-retries: may be a fraction",
    SOURCE,
    'if (typeof value !== "number" || !Number.isInteger(value) || value < 0)',
    'if (typeof value !== "number" || value < 0)',
  ),
  m(
    "a max-retries: may be negative",
    SOURCE,
    'if (typeof value !== "number" || !Number.isInteger(value) || value < 0)',
    'if (typeof value !== "number" || !Number.isInteger(value))',
  ),
  m(
    "the task's own options are not checked",
    SOURCE,
    "const taskOptions = readTaskV5Options(root, OPTION_KEYS, [], stateNames, fail);",
    "const taskOptions = {} as TaskV5Options;",
  ),
  m(
    "a step's options are not checked",
    SOURCE,
    "const options = single ? {} : readTaskV5Options(raw, OPTION_KEYS, base, stateNames, fail);",
    "const options = {};",
  ),
  // Warnings
  m(
    "a key a task does not take is refused",
    SOURCE,
    "if (!allowed.includes(key)) warnOnce(",
    'if (!allowed.includes(key)) throw new Error("refused"); if (false) warnOnce(',
  ),
  m(
    "a key a task does not take is not warned about",
    SOURCE,
    "if (!allowed.includes(key)) warnOnce(",
    "if (false) warnOnce(",
  ),
  m(
    "a warning is given every time",
    SOURCE,
    "warnOnce(`${where}: ${key}`, `${where}: ${key}: is not a key taken here; ignored`);",
    "warnOnce(`${Math.random()}`, `${where}: ${key}: is not a key taken here; ignored`);",
  ),
  m("a step option at the top of a task is warned about", SOURCE, '"lock",\n  ...OPTION_KEYS,\n];', '"lock",\n];'),
  m(
    "a command's keys at the top of a task with steps are taken",
    SOURCE,
    "ignoreKeys(root, single ? [...TASK_KEYS, ...COMMAND_KEYS] : TASK_KEYS, label);",
    "ignoreKeys(root, [...TASK_KEYS, ...COMMAND_KEYS], label);",
  ),
  skip("the keys of a step are not looked at", SOURCE, "if (!single) ignoreKeys(raw, STEP_KEYS, where);"),
  m(
    "harness: on a command that is no agent's is not warned about",
    SOURCE,
    'if (given !== undefined && kind !== "agents" && kind !== "commands" && kind !== "prompt") {',
    "if (false) {",
  ),
  m(
    "harness: on a step an agent runs is warned about",
    SOURCE,
    'if (given !== undefined && kind !== "agents" && kind !== "commands" && kind !== "prompt") {',
    "if (given !== undefined) {",
  ),
  m(
    "harness: at the top of a task that is one command is not looked at",
    SOURCE,
    "const given = single ? taskOptions[key] : options[key];",
    "const given = options[key];",
  ),
  // Env assets, secrets and the flags of a start
  m(
    "an env asset that does not exist is accepted",
    CHECK,
    "resolveEnvBinding(entry, { locateOnly: true });",
    "void entry;",
  ),
  m(
    "an env asset may bind a secret that does not exist",
    ENV_BINDING,
    "  if (missing.length > 0) {\n    throw new NotFoundError(",
    "  if (false) {\n    throw new NotFoundError(",
  ),
  m(
    "a secret that does not exist is accepted",
    CHECK,
    "resolveSecretPath((parseSecretSpec(spec) as { ref: string }).ref);",
    "void spec;",
  ),
  m("the env: and secret: of the task are not checked", CHECK, "checkOptionRefs(document.options, ref);", "void 0;"),
  m("the env: and secret: of a step are not checked", CHECK, "checkOptionRefs(step.options, at);", "void 0;"),
  m("the --env and --secret of a start are not checked", CHECK, 'checkOptionRefs(options, "akm run");', "void 0;"),
  ...FLAG_KEYS.map((key) =>
    m(
      `--${key === "max-retries" ? "max-retries" : key} is not checked`,
      CHECK,
      FLAG_KEYS_SOURCE,
      `[${FLAG_KEYS.filter((flag) => flag !== key)
        .map((flag) => `"${flag}"`)
        .join(", ")}],`,
    ),
  ),
  // Schedule entries
  m(
    "a schedule entry takes no timeout:",
    SOURCE,
    'const SCHEDULE_ENTRY_KEYS = ["cron", "inputs", "env", "secret", "timeout"] as const;',
    'const SCHEDULE_ENTRY_KEYS = ["cron", "inputs", "env", "secret"] as const;',
  ),
  m(
    "a schedule entry's options are not checked",
    SOURCE,
    'readTaskV5Options(entry, ["env", "secret", "timeout"], ["schedule", index], new Set(), fail);',
    "{};",
  ),
  // Versions
  m("another beta than this build's is accepted", ROUTER, "if (declared !== TASK_SOURCE_V5_VERSION) {", "if (false) {"),
  // Running: the environment of a step
  m(
    "a step inherits the whole environment akm runs in",
    RUN,
    "buildChildEnv(context.host, { clean: true, inherit })",
    "buildChildEnv(context.host, { clean: false, inherit })",
  ),
  m("clean drops akm's location variables", OWNER_CLEAN_ENV, "Object.assign(base, locations);", "void locations;"),
  m(
    "clean keeps AKM_BUNDLE_DIR",
    OWNER_CLEAN_ENV,
    "const { AKM_BUNDLE_DIR: _bundleDir, ...locations } = akmLocations();",
    "const locations = akmLocations();",
  ),
  m(
    "inherit: lets nothing through",
    RUN,
    "const inherit = [...(flags.inherit ?? []), ...(document.options.inherit ?? []), ...(step.options.inherit ?? [])];",
    "const inherit: string[] = [];",
  ),
  m("inherit: on a step is ignored", RUN, ", ...(step.options.inherit ?? [])];", "];"),
  m("inherit: at the top of a task is ignored", RUN, ", ...(document.options.inherit ?? [])", ""),
  m("--inherit is ignored", RUN, "const inherit = [...(flags.inherit ?? []), ", "const inherit = ["),
  m(
    "a step has no AKM_EVENT_SOURCE",
    RUN,
    "env.AKM_EVENT_SOURCE = taskEventSource(context.host, context.provenance);",
    "void 0;",
  ),
  m(
    "the task's env: wins over the step's",
    RUN,
    "[document.options, step.options, flags] as const",
    "[step.options, document.options, flags] as const",
  ),
  m(
    "a step's env: wins over `akm run --env`",
    RUN,
    "[document.options, step.options, flags] as const",
    "[document.options, flags, step.options] as const",
  ),
  m(
    "an env asset's variables are not loaded",
    RUN,
    'if (typeof entry === "string") apply({ env: [entry] });',
    'if (typeof entry === "string") void 0;',
  ),
  m(
    "a variable set inline is not set",
    RUN,
    "else for (const [name, value] of Object.entries(entry)) env[name] = String(value);",
    "else void 0;",
  ),
  m("secret: gives the step nothing", RUN, "if (layer.secret?.length) apply(", "if (false) apply("),
  m(
    "`akm run --env` and `--secret` do not reach the tasks it runs",
    RUN,
    "record.flags,\n        stepInputs(child, step, record.state),",
    "{ ...record.flags, env: [], secret: [] },\n        stepInputs(child, step, record.state),",
  ),
  m(
    "the caller's env: passes to a task it runs",
    RUN,
    "record.flags,\n        stepInputs(child, step, record.state),",
    "{ ...record.flags, env: [...(document.options.env ?? []), ...(record.flags.env ?? [])] },\n        stepInputs(child, step, record.state),",
  ),
  m(
    "--max-retries does not reach the tasks it runs",
    RUN,
    "record.flags,\n        stepInputs(child, step, record.state),",
    "{ ...record.flags, maxRetries: undefined },\n        stepInputs(child, step, record.state),",
  ),
  m(
    "--inherit does not reach the tasks it runs",
    RUN,
    "record.flags,\n        stepInputs(child, step, record.state),",
    "{ ...record.flags, inherit: [] },\n        stepInputs(child, step, record.state),",
  ),
  m(
    "a value a calling step gives is not converted",
    RUN,
    "stepInputs(child, step, record.state),",
    "Object.fromEntries((step.taskInputs ?? []).map(({ name, value }) => [name, argument(value, record.state)])),",
  ),

  // Running: secrets are never state
  m(
    "secrets are not removed from results",
    RUN,
    "context.secrets.size === 0 ? value : redactSensitiveValue(value, collectSensitiveValues(context.secrets))",
    "value",
  ),
  m(
    "a secret given with secret: or bound in an env asset is not removed",
    RUN,
    "secretValues.push(...injected.secretValues);",
    "void 0;",
  ),
  m(
    "credential-named values are not removed",
    RUN,
    "secretValues.push(...collectInferredSecretValues(env));",
    "void 0;",
  ),
  m(
    "short credential values are removed too",
    OWNER_REDACTION,
    "if (value === undefined || value.length < MIN_INFERRED_SECRET_LENGTH) continue;",
    "if (value === undefined || value.length < 1) continue;",
  ),
  m("PAT is not a credential name", OWNER_REDACTION, "|PASS|PAT|CREDENTIALS?", "|PASS|CREDENTIALS?"),
  m("a credential word inside a longer word counts", OWNER_REDACTION, "|AUTH)(?:_|$)/i;", "|AUTH)/i;"),
  m(
    "the secrets of the tasks a run runs are not known when it starts",
    RUN,
    'if (step.kind === "tasks") await collectSecrets(context, step.run as string, found.bundle, flags, seen);',
    'if (step.kind === "tasks") void 0;',
  ),
  m(
    "the secrets of a run are known only as its steps set them",
    RUN,
    "await collectSecrets(context, task.ref, task.bundle, flags, new Set());",
    "void 0;",
  ),
  m(
    "a secret on standard error is left in the log",
    RUN,
    "const stderr = scrub(context, result.stderr) as string;",
    "const stderr = result.stderr;",
  ),

  // Running: the state
  m(
    "the state file is empty",
    RUN,
    "fs.writeFileSync(statePath, JSON.stringify(record.state, null, 2));",
    'fs.writeFileSync(statePath, "{}");',
  ),
  m(
    "the state copy is left behind after the step",
    RUN,
    "fs.rmSync(stateDir, { recursive: true, force: true });",
    "void 0;",
  ),
  m(
    "standard error is part of the result",
    RUN,
    "return { ok: true, value: stdout };",
    "return { ok: true, value: stdout + stderr };",
  ),
  m(
    "a prompt's ${name} is not filled in",
    RUN,
    "prompt: `${fill(step.prompt as string, record.state)}${extra}`,",
    "prompt: `${step.prompt as string}${extra}`,",
  ),
  m(
    "filled text is scanned again",
    RUN,
    "(body in state ? asText(state[body]) : token)",
    "(body in state ? fill(asText(state[body]), state) : token)",
  ),
  m(
    "a JSON value goes into a prompt as plain text",
    RUN,
    'const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));',
    "const asText = (value: unknown): string => String(value);",
  ),
  m(
    "a ${name} item of args: is not that state entry",
    RUN,
    "return body === undefined ? item : state[body];",
    "return item;",
  ),
  m(
    "the items of a script's args: are not passed",
    RUN,
    "(step.args ?? []).map((item) => asText(argument(item, record.state))),",
    "[],",
  ),
  m(
    "an exec: command is not run by a shell",
    RUN,
    'shellCommand({ command: step.exec as string, shell: process.platform === "win32" ? "cmd" : "sh" })',
    "[step.exec as string]",
  ),
  m("expect: does not check the reply", RUN, "if (!step.expect) {", "if (true) {"),
  m(
    "a prompt asset is given no arguments",
    RUN,
    'action: { ref: step.run, ...(text === "" ? {} : { arguments: text }) },',
    "action: { ref: step.run },",
  ),
  m(
    "an input's default is ignored",
    RUN,
    "const defaulted = applyInputDefaults(contract, given);",
    "const defaulted = given;",
  ),
  m(
    "an optional input that is not given is null",
    RUN,
    'state[name] = name in defaulted ? defaulted[name] : "";',
    "state[name] = name in defaulted ? defaulted[name] : null;",
  ),
  m(
    "a value is not converted to its input's type when a run starts",
    RUN,
    "const given = { ...materializeInputFlags(contract, flags, TASK_INPUT_DIAGNOSTICS), ...literals };",
    "const given = { ...Object.fromEntries(flags.map((flag) => [flag.name, flag.value])), ...literals };",
  ),
  m(
    "a task that a step runs shares the caller's state",
    RUN,
    "stepInputs(child, step, record.state),",
    "record.state,",
  ),
  m(
    "runs of a task share one state",
    RUN,
    "        prepared.inputs ?? {},\n        prepared.flagged,",
    "        ((globalThis as Record<string, any>).__shared ??= { ...prepared.inputs }),\n        prepared.flagged,",
  ),
  m(
    "a task's result is its first step's",
    RUN,
    'result = outcome.value ?? "";',
    'result = result ?? outcome.value ?? "";',
  ),
  m(
    "a step that runs a task has no result",
    RUN,
    "return { ok: true, value: result.result, startedAt: result.startedAt };",
    'return { ok: true, value: "", startedAt: result.startedAt };',
  ),

  // Running: the working folder
  m(
    "a run works in the bundle root by default",
    RUN,
    "const dir = named === undefined ? path.join(runsFolder(taskId), runId) : ensureWorkingFolder(named);",
    'const dir = named === undefined ? path.join(bundle.dir, "work") : ensureWorkingFolder(named);',
  ),
  m("the task's cwd: is ignored", RUN, ": path.resolve(bundle.dir, document.options.cwd);", ": undefined;"),
  m(
    "the task's cwd: wins over `akm run --cwd`",
    RUN,
    "parent === undefined && flags.cwd !== undefined",
    "parent === undefined && flags.cwd !== undefined && document.options.cwd === undefined",
  ),
  m(
    "--cwd reaches the tasks a run runs",
    RUN,
    "parent === undefined && flags.cwd !== undefined",
    "flags.cwd !== undefined",
  ),
  m(
    "a step's cwd: is ignored",
    RUN,
    ": ensureWorkingFolder(path.resolve(record.bundle.dir, step.options.cwd));",
    ": record.dir;",
  ),
  m(
    "a folder a step names is not made",
    RUN,
    "ensureWorkingFolder(path.resolve(record.bundle.dir, step.options.cwd))",
    "path.resolve(record.bundle.dir, step.options.cwd)",
  ),
  m("a folder the task or --cwd names is not made", RUN, ": ensureWorkingFolder(named);", ": path.resolve(named);"),
  m(
    "a folder a command works in is not the run's",
    RUN,
    "      cwd: run.cwd,\n      timeoutMs: run.timeoutMs,",
    "      cwd: os.tmpdir(),\n      timeoutMs: run.timeoutMs,",
  ),
  m(
    "an agent works somewhere else than the run's commands",
    RUN,
    "              cwd: run.cwd,\n",
    "              cwd: os.tmpdir(),\n",
  ),
  m(
    "the working folder is left behind when the run succeeds",
    RUN,
    "if (record.madeDir) fs.rmSync(record.dir, { recursive: true, force: true });",
    "void 0;",
  ),
  m("a folder cwd: names is removed with the run", RUN, "madeDir: named === undefined,", "madeDir: true,"),
  m(
    "the state is kept after a run succeeds",
    RUN,
    "fs.rmSync(recordPath(record.taskId, record.runId), { force: true });",
    "void 0;",
  ),
  m(
    "the folders of earlier failed runs are kept when a run succeeds",
    RUN,
    "for (const earlier of resumableRuns(record.taskId)) if (earlier.runId !== record.runId) discard(earlier);",
    "void 0;",
  ),
  m("a failed run's state is dropped", RUN, "if (!failure) discard(record);", "discard(record);"),

  // Running: resume
  m("resume runs finished steps again", RUN, 'if (kept.status === "completed") {', "if (false) {"),
  m(
    "resume starts a task over instead of continuing inside it",
    RUN,
    "let run = kept === undefined ? undefined : readRecord(kept.task, kept.run);",
    "let run: RunRecord | undefined;",
  ),
  m("a run that a step started can be resumed on its own", RUN, "if (!row.run || row.run.parent ||", "if (!row.run ||"),
  m(
    "resume takes the oldest failed run",
    RUN,
    "const [resume] = resumableRuns(task.taskId);",
    "const resume = resumableRuns(task.taskId).at(-1);",
  ),
  m(
    "resume forgets the flags of the first start",
    RUN,
    "const flags = prepared.resume?.flags ?? start.flags;",
    "const flags = start.flags;",
  ),

  // Running: the lock
  m("lock: true is ignored", RUN, "    document.lock === true\n      ?", "    false\n      ?"),
  m("a task without lock: is held back too", RUN, "    document.lock === true\n      ?", "    true\n      ?"),
  m(
    "one task's lock holds back another task",
    RUN,
    "tryAcquireRunLock(taskRunLockPath(taskId),",
    'tryAcquireRunLock(taskRunLockPath("one"),',
  ),
  m(
    "a finished run keeps the lock",
    RUN,
    "    if (runLock) releaseLock(runLock);\n    if (lock) releaseLock(lock.ownership);",
    "    if (runLock) releaseLock(runLock);",
  ),
  m(
    "a step ignores the lock of the task it runs",
    RUN,
    'const lock = child.lock === true ? tryAcquireRunLock(taskRunLockPath(taskId), { label: "task" }) : undefined;',
    "const lock = undefined;",
  ),
  m(
    "a step that finds the lock taken goes on",
    RUN,
    'if (lock?.state === "held") throw new Error(',
    "if (false) throw new Error(",
  ),
  m(
    "resume ignores the lock",
    RUN,
    "    document.lock === true\n      ?",
    "    document.lock === true && prepared.resume === undefined\n      ?",
  ),
  m("a run can be resumed twice at once", RUN, "      runLock = lockRun(prepared.resume);", "      void lockRun;"),
  m(
    "a scheduled start that finds the lock taken has failed",
    LIFECYCLE,
    'if (!options.skip) throw new TransientError(message, "RUN_LEASE_HELD");',
    'throw new TransientError(message, "RUN_LEASE_HELD");',
  ),
  m(
    "--skip-if-locked does nothing",
    RUN,
    "skip: provenance.scheduled || start.skipIfLocked",
    "skip: provenance.scheduled",
  ),
  m(
    "a scheduled start is treated as a typed one",
    RUN,
    "skip: provenance.scheduled || start.skipIfLocked",
    "skip: start.skipIfLocked",
  ),

  // Running: timeout and max-retries
  m(
    "timeout: on a step is ignored",
    RUN,
    'const timeout = option(document, step, "timeout") ?? DEFAULT_STEP_TIMEOUT;',
    "const timeout = document.options.timeout ?? DEFAULT_STEP_TIMEOUT;",
  ),
  m(
    "a task's timeout: is not its steps' default",
    RUN,
    'const timeout = option(document, step, "timeout") ?? DEFAULT_STEP_TIMEOUT;',
    "const timeout = step.options.timeout ?? DEFAULT_STEP_TIMEOUT;",
  ),
  m(
    "the task's timeout: wins over a step's own",
    RUN,
    'const timeout = option(document, step, "timeout") ?? DEFAULT_STEP_TIMEOUT;',
    "const timeout = document.options.timeout ?? step.options.timeout ?? DEFAULT_STEP_TIMEOUT;",
  ),
  m(
    "the limit of a step with no timeout: is not 30 minutes",
    RUN,
    'const DEFAULT_STEP_TIMEOUT = "30m";',
    'const DEFAULT_STEP_TIMEOUT = "100d";',
  ),
  m(
    "a step's own timeout: lifts the run's limit",
    RUN,
    "return Math.min(until, Date.now() + parseTimeoutValue(String(timeout)));",
    "return Date.now() + parseTimeoutValue(String(timeout));",
  ),
  m(
    "--timeout is ignored",
    RUN,
    "flags.timeout === undefined ? Number.POSITIVE_INFINITY : Date.now() + parseTimeoutValue(String(flags.timeout))",
    "Number.POSITIVE_INFINITY",
  ),
  m(
    "a task's timeout: limits the whole run",
    RUN,
    "flags.timeout === undefined ? Number.POSITIVE_INFINITY : Date.now() + parseTimeoutValue(String(flags.timeout))",
    "(flags.timeout ?? document.options.timeout) === undefined ? Number.POSITIVE_INFINITY : Date.now() + parseTimeoutValue(String(flags.timeout ?? document.options.timeout))",
  ),
  m(
    "a step's timeout: does not limit the task it runs",
    RUN,
    "const limit = limitOf(until, document, step);",
    "const limit = until;",
  ),
  m(
    "the run's limit does not hold in a task it runs",
    RUN,
    "const limit = limitOf(until, document, step);",
    "const limit = limitOf(Number.POSITIVE_INFINITY, document, step);",
  ),
  m(
    "a command is left running at its limit",
    RUN,
    "      timeoutMs: run.timeoutMs,\n      capture: true,",
    "      capture: true,",
  ),
  m(
    "what a command started is left running at its limit",
    OWNER_SUBPROCESS,
    "process.kill(-proc.pid, signal);",
    "process.kill(proc.pid, signal);",
  ),
  m(
    "an agent step has no limit",
    RUN,
    "              timeoutMs: run.timeoutMs,\n              signal: context.abort.signal,",
    "              signal: context.abort.signal,",
  ),
  m(
    "max-retries: is ignored",
    RUN,
    'const retries = option(document, step, "max-retries") ?? record.flags.maxRetries ?? 0;',
    "const retries = 0;",
  ),
  m("a step is run again once more than max-retries: says", OWNER_RETRY, "retry < maxRetries", "retry <= maxRetries"),
  m(
    "a step is run again without max-retries:",
    RUN,
    'const retries = option(document, step, "max-retries") ?? record.flags.maxRetries ?? 0;',
    'const retries = option(document, step, "max-retries") ?? record.flags.maxRetries ?? 1;',
  ),
  m(
    "a task's max-retries: is not its steps' default",
    RUN,
    'const retries = option(document, step, "max-retries") ?? record.flags.maxRetries ?? 0;',
    'const retries = step.options["max-retries"] ?? record.flags.maxRetries ?? 0;',
  ),
  m(
    "the task's max-retries: wins over the step's",
    RUN,
    'const retries = option(document, step, "max-retries") ?? record.flags.maxRetries ?? 0;',
    'const retries = document.options["max-retries"] ?? step.options["max-retries"] ?? record.flags.maxRetries ?? 0;',
  ),
  m(
    "--max-retries wins over the task's and the step's",
    RUN,
    'const retries = option(document, step, "max-retries") ?? record.flags.maxRetries ?? 0;',
    'const retries = record.flags.maxRetries ?? option(document, step, "max-retries") ?? 0;',
  ),
  m(
    "--max-retries is ignored",
    RUN,
    'const retries = option(document, step, "max-retries") ?? record.flags.maxRetries ?? 0;',
    'const retries = option(document, step, "max-retries") ?? 0;',
  ),
  m("a version 5 task reaches the version 4 runner", LOADER, "if (parsed.version !== 4) {", "if (false) {"),

  m(
    "a 5-beta version is read as version 4",
    ROUTER,
    'if (typeof declared === "string" && TASK_SOURCE_V5_VERSION_PATTERN.test(declared)) {',
    "if (false) {",
  ),
];

const words = process.argv.slice(2);
const chosen =
  words.length > 0 ? MUTATIONS.filter((mutation) => words.some((word) => mutation.name.includes(word))) : MUTATIONS;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "akm-v5-mutate-"));
for (const entry of ["src", "tests", "scripts", "package.json", "bunfig.toml", "tsconfig.json"]) {
  fs.cpSync(path.join(ROOT, entry), path.join(work, entry), { recursive: true });
}
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(work, "node_modules"));

// A broken guard can make the code loop or recurse without end, so each run gets a memory ceiling (its own systemd
// scope, no swap) and a hard time limit; a run killed by either counts as caught.
const MEMORY_MAX = "1G";
const TIME_LIMIT_S = 90;
// The checker's tests are quick and catch most breakages; the runner's tests run only when they pass.
const TEST_FILES = ["tests/tasks/v5/model.test.ts", "tests/tasks/v5/run.test.ts"];
const test = () => {
  let last = { status: 0 as number | string | null, failed: 0 };
  for (const file of TEST_FILES) {
    const run = spawnSync(
      "systemd-run",
      [
        "--user",
        "--scope",
        "--quiet",
        "-p",
        `MemoryMax=${MEMORY_MAX}`,
        "-p",
        "MemorySwapMax=0",
        "timeout",
        "--kill-after=5",
        String(TIME_LIMIT_S),
        "bun",
        "test",
        "--timeout=20000",
        "--bail",
        file,
      ],
      { cwd: work, encoding: "utf8" },
    );
    const text = `${run.stdout}${run.stderr}`;
    const status = run.status === 124 || run.status === 137 ? "never finishes" : run.status;
    last = { status, failed: (text.match(/^\(fail\)/gm) ?? []).length };
    if (last.status !== 0 || last.failed > 0) return last;
  }
  return last;
};

let missed = 0;
try {
  const baseline = test();
  if (baseline.status !== 0) throw new Error("the tests fail before anything is broken; fix them first");
  for (const mutation of chosen) {
    const file = path.join(work, mutation.file);
    const original = fs.readFileSync(file, "utf8");
    const matches = original.split(mutation.from).length - 1;
    if (matches !== 1)
      throw new Error(
        `mutation ${JSON.stringify(mutation.name)}: expected one match in ${mutation.file}, found ${matches}`,
      );
    fs.writeFileSync(
      file,
      original.replace(mutation.from, () => mutation.to),
    );
    let verdict: string;
    try {
      const result = test();
      verdict =
        result.failed > 0
          ? `caught (${result.failed} test(s) fail)`
          : result.status === 0
            ? "NOT CAUGHT"
            : result.status === "never finishes"
              ? "caught (killed: time or memory limit)"
              : "caught (does not run)";
    } finally {
      fs.writeFileSync(file, original);
    }
    if (verdict === "NOT CAUGHT") missed++;
    console.log(`${mutation.name.padEnd(72)} ${verdict}`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`\n${chosen.length - missed} of ${chosen.length} broken rules caught`);
process.exit(missed === 0 ? 0 : 1);

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const ENV_OPTIONS_WITH_OPERAND = new Set(["--argv0", "--chdir", "--unset"]);
const ENV_OPTIONS_WITH_OPTIONAL_VALUE = new Set(["--block-signal", "--default-signal", "--ignore-signal"]);
const ENV_OPTIONS_WITHOUT_OPERAND = new Set(["--debug", "--ignore-environment", "--list-signal-handling"]);

/** Locate a command whose executable position clearly names AKM, including an explicit path. */
export function findAkmExecutableIndex(command: readonly string[]): number | undefined {
  if (command.length === 0) return undefined;
  const executableIndex = isEnvExecutable(command[0]) ? findEnvCommandIndex(command) : 0;
  if (executableIndex === undefined || !isAkmExecutable(command[executableIndex])) return undefined;
  return executableIndex;
}

/** Locate only PATH-selected AKM, which is safe to redirect to the current installation. */
export function findBareAkmExecutableIndex(command: readonly string[]): number | undefined {
  const executableIndex = findAkmExecutableIndex(command);
  if (executableIndex === undefined || !isBareAkm(command[executableIndex])) return undefined;
  return executableIndex;
}

function findEnvCommandIndex(command: readonly string[]): number | undefined {
  let index = 1;

  while (index < command.length) {
    const part = command[index]!;
    if (part === "--") {
      index += 1;
      break;
    }
    if (isEnvironmentAssignment(part)) break;
    if (!part.startsWith("-")) break;

    const operandCount = envOptionOperandCount(part);
    if (operandCount === undefined || index + operandCount >= command.length) return undefined;
    index += operandCount + 1;
  }

  while (index < command.length && isEnvironmentAssignment(command[index]!)) index += 1;
  return index < command.length ? index : undefined;
}

function envOptionOperandCount(option: string): 0 | 1 | undefined {
  if (option === "-") return 0;
  if (ENV_OPTIONS_WITHOUT_OPERAND.has(option) || ENV_OPTIONS_WITH_OPTIONAL_VALUE.has(option)) return 0;
  if ([...ENV_OPTIONS_WITH_OPTIONAL_VALUE].some((prefix) => option.startsWith(`${prefix}=`))) return 0;
  if (ENV_OPTIONS_WITH_OPERAND.has(option)) return 1;
  if (["--argv0=", "--chdir=", "--unset="].some((prefix) => option.startsWith(prefix))) return 0;

  if (!option.startsWith("-") || option.startsWith("--")) return undefined;
  const shortOptions = option.slice(1);
  for (let index = 0; index < shortOptions.length; index += 1) {
    const flag = shortOptions[index];
    if (flag === "i" || flag === "v") continue;
    if (flag === "S") return undefined;
    if (flag === "u" || flag === "C" || flag === "P" || flag === "a") {
      return index === shortOptions.length - 1 ? 1 : 0;
    }
    return undefined;
  }
  return shortOptions.length > 0 ? 0 : undefined;
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function isEnvExecutable(value: string | undefined): boolean {
  if (!value) return false;
  if (value === "env") return true;
  if (!isAbsolutePath(value)) return false;
  return /^env(?:\.exe)?$/i.test(value.split(/[\\/]/).at(-1) ?? "");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

function isBareAkm(value: string | undefined): boolean {
  return value !== undefined && /^akm(?:\.exe)?$/i.test(value);
}

function isAkmExecutable(value: string | undefined): boolean {
  if (!value) return false;
  return /^akm(?:\.exe)?$/i.test(value.split(/[\\/]/).at(-1) ?? "");
}

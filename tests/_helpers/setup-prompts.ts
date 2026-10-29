// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A scripted terminal for the setup prompts (the `src/cli/clack` seam). A test
 * queues the answers it expects, in prompt order; every prompt shown is
 * recorded with the options it offered, so a test can assert what the user
 * would have seen, and a queue that runs dry fails with the whole transcript.
 */
import { _setClackForTests } from "../../src/cli/clack";
import { overrideSeam } from "./seams";

export type PromptKind = "confirm" | "select" | "multiselect" | "text" | "password";

export interface PromptRecord {
  readonly kind: PromptKind;
  readonly message: string;
  readonly options: readonly { value: unknown; label?: string; hint?: string }[];
  readonly initialValue?: unknown;
  readonly initialValues?: unknown;
  readonly answer: unknown;
}

export interface ScriptedPrompts {
  /** Queue answers per kind, in the order the prompts will be shown. */
  readonly answers: Record<PromptKind, unknown[]>;
  /** Every prompt shown so far. */
  readonly asked: PromptRecord[];
  /** Everything logged, noted, or said by a spinner. */
  readonly output: string[];
  /** The prompts shown for this kind, in order. */
  of(kind: PromptKind): PromptRecord[];
  /** Everything the terminal showed, prompts and output together. */
  transcript(): string;
}

/** Install the scripted terminal for the current test. */
export function scriptPrompts(): ScriptedPrompts {
  const answers: Record<PromptKind, unknown[]> = { confirm: [], select: [], multiselect: [], text: [], password: [] };
  const asked: PromptRecord[] = [];
  const output: string[] = [];
  const transcript = () =>
    [
      ...asked.map(
        (record) =>
          `[${record.kind}] ${record.message}${record.options.length ? ` options=${JSON.stringify(record.options.map((o) => o.value))}` : ""} -> ${record.kind === "password" ? "(hidden)" : JSON.stringify(record.answer)}`,
      ),
      ...output,
    ].join("\n");

  const take = (kind: PromptKind, config: unknown): unknown => {
    const c = config as {
      message?: string;
      options?: { value: unknown; label?: string; hint?: string }[];
      initialValue?: unknown;
      initialValues?: unknown;
    };
    const queue = answers[kind];
    if (queue.length === 0) {
      throw new Error(`no ${kind} answer queued for "${c.message}"\nTranscript so far:\n${transcript()}`);
    }
    const answer = queue.shift();
    asked.push({
      kind,
      message: String(c.message ?? ""),
      options: c.options ?? [],
      ...(c.initialValue !== undefined ? { initialValue: c.initialValue } : {}),
      ...(c.initialValues !== undefined ? { initialValues: c.initialValues } : {}),
      answer,
    });
    return answer;
  };
  const say = (message: string, title?: string) => {
    output.push(title ? `${title}\n${message}` : message);
  };

  overrideSeam(_setClackForTests, {
    isCancel: () => false,
    cancel: say,
    confirm: async (config: unknown) => take("confirm", config),
    select: async (config: unknown) => take("select", config),
    multiselect: async (config: unknown) => take("multiselect", config),
    text: async (config: unknown) => take("text", config),
    password: async (config: unknown) => take("password", config),
    spinner: () => ({ start: say, stop: say }),
    log: { info: say, success: say, warn: say, step: say },
    intro: say,
    outro: say,
    note: say,
  });

  return { answers, asked, output, of: (kind) => asked.filter((record) => record.kind === kind), transcript };
}

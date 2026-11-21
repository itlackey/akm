import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../../src/core/errors";
import { scriptProgram } from "../../../src/tasks/frozen-script";
import {
  bunArguments,
  captureScriptTarget,
  scriptCommand,
  scriptFirstLine,
} from "../../../src/tasks/prepare/script-capture";
import { makeSandboxDir } from "../../_helpers/sandbox";

function withoutBun<T>(fn: () => T): T {
  const versions = process.versions as Record<string, string | undefined>;
  const original = versions.bun;
  delete versions.bun;
  try {
    return fn();
  } finally {
    if (original !== undefined) versions.bun = original;
  }
}

function withNodeTypeScriptSupport<T>(supported: boolean, fn: () => T): T {
  const proc = process as unknown as { features?: Record<string, unknown> };
  const originalFeatures = proc.features;
  proc.features = { ...originalFeatures, typescript: supported };
  try {
    return fn();
  } finally {
    proc.features = originalFeatures;
  }
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("a script's first line, as akm reads it", () => {
  test("the program is the first word and the rest of the line is one argument", () => {
    expect(scriptFirstLine(bytesOf("#!/bin/sh\necho hi\n"))).toEqual({ program: "/bin/sh" });
    expect(scriptFirstLine(bytesOf("#!/bin/bash -e\n"))).toEqual({ program: "/bin/bash", argument: "-e" });
    expect(scriptFirstLine(bytesOf("#!/usr/bin/env python3\n"))).toEqual({
      program: "/usr/bin/env",
      argument: "python3",
    });
    expect(scriptFirstLine(bytesOf("#! /usr/bin/env -S bash -eu  \n"))).toEqual({
      program: "/usr/bin/env",
      argument: "-S bash -eu",
    });
  });

  test("a carriage return that ends the line is not part of it, and a file with no such line has none", () => {
    expect(scriptFirstLine(bytesOf("#!/usr/bin/env bash\r\necho hi\r\n"))).toEqual({
      program: "/usr/bin/env",
      argument: "bash",
    });
    expect(scriptFirstLine(bytesOf("echo hi\n"))).toBeUndefined();
    expect(scriptFirstLine(bytesOf("#!\n"))).toBeUndefined();
    expect(scriptFirstLine(undefined)).toBeUndefined();
  });
});

const command = (
  extension: string,
  text: string | undefined,
  platform: NodeJS.Platform = "linux",
  args: string[] = [],
) =>
  scriptCommand(
    { ref: "scripts/x", bytes: text === undefined ? new Uint8Array() : bytesOf(text), extension },
    "/tmp/x",
    args,
    platform,
  );

describe("scriptCommand: the first line decides, then the extension", () => {
  test("a first line that names a program runs it with that line's one argument, the file, then the arguments", () => {
    expect(command(".sh", "#!/bin/bash -e\n", "linux", ["x y"])).toEqual(["/bin/bash", "-e", "/tmp/x", "x y"]);
    expect(command(".sh", "#!/usr/bin/env -S bash -eu\n")).toEqual(["/usr/bin/env", "-S bash -eu", "/tmp/x"]);
    expect(command(".py", "#!/usr/bin/env python3\n")).toEqual(["/usr/bin/env", "python3", "/tmp/x"]);
    expect(command(".js", "#!/usr/bin/env node\n")).toEqual(["/usr/bin/env", "node", "/tmp/x"]);
    expect(command(".awk", "#!/usr/bin/awk -f\n")).toEqual(["/usr/bin/awk", "-f", "/tmp/x"]);
  });

  test("a first line that names bun runs on akm's own runtime whatever the extension, with the words after bun", () => {
    expect(command(".sh", "#!/usr/bin/env bun\n")).toEqual([process.execPath, "/tmp/x"]);
    expect(command(".ts", "#!/usr/bin/env -S bun --smol\n")).toEqual([process.execPath, "--smol", "/tmp/x"]);
    expect(command(".py", "#!/usr/local/bin/bun\n", "linux", ["a"])).toEqual([process.execPath, "/tmp/x", "a"]);
    expect(bunArguments(scriptFirstLine(bytesOf("#!/usr/bin/env bash\n")))).toBeUndefined();
  });

  test("with no first line the extension selects the program", () => {
    expect(command(".sh", "echo hi\n")).toEqual(["sh", "/tmp/x"]);
    expect(command(".py", "print(1)\n")).toEqual(["python3", "/tmp/x"]);
    expect(command(".r", "1\n")).toEqual(["Rscript", "/tmp/x"]);
    expect(command(".ts", "console.log(1)\n")).toEqual([process.execPath, "/tmp/x"]);
    expect(command(".kts", "1\n")).toEqual(["kotlinc", "-script", "/tmp/x"]);
  });

  test("Windows has no first lines: the extension decides there", () => {
    expect(command(".sh", "#!/usr/bin/env bash\n", "win32")).toEqual(["sh", "/tmp/x"]);
    expect(command(".py", "#!/usr/bin/env python3\n", "win32")).toEqual(["python", "/tmp/x"]);
  });

  test("a script with neither a first line nor a known extension is refused, naming the script and what to add", () => {
    for (const text of ["plain text\n", undefined]) {
      const refusal = (() => {
        try {
          command(".xyz", text);
        } catch (error) {
          return error as UsageError;
        }
      })();
      expect(refusal).toBeInstanceOf(UsageError);
      expect(refusal?.code).toBe("TASK_TARGET_UNSUPPORTED");
      expect(refusal?.message).toContain("scripts/x");
      expect(refusal?.hint()).toContain("`#!` first line");
    }
  });
});

describe("scriptCommand: a runtime without Bun", () => {
  test(".js and .mjs run on node", () => {
    withoutBun(() => {
      expect(command(".js", "1\n")).toEqual(["node", "/tmp/x"]);
      expect(command(".mjs", "1\n")).toEqual(["node", "/tmp/x"]);
    });
  });

  test(".ts runs on node only when this Node build strips types natively", () => {
    withoutBun(() => {
      withNodeTypeScriptSupport(true, () => expect(command(".ts", "1\n")).toEqual(["node", "/tmp/x"]));
      withNodeTypeScriptSupport(false, () => expect(() => command(".ts", "1\n")).toThrow(UsageError));
    });
  });

  test("a first line that names bun is run as written, not turned into node", () => {
    withoutBun(() => {
      expect(command(".ts", "#!/usr/bin/env bun\n")).toEqual(["/usr/bin/env", "bun", "/tmp/x"]);
      expect(command(".sh", "#!/usr/bin/env -S bun --smol\n")).toEqual(["/usr/bin/env", "-S bun --smol", "/tmp/x"]);
    });
  });

  test("a script that is not for Bun is untouched", () => {
    withoutBun(() => expect(command(".py", "print(1)\n")).toEqual(["python3", "/tmp/x"]));
  });
});

describe("scriptProgram: the command for a script asset", () => {
  test("reads the file's own first line, and says which script and first line it came from", () => {
    const sandbox = makeSandboxDir("script-program");
    try {
      const file = path.join(sandbox.dir, "a.sh");
      fs.writeFileSync(file, "#!/bin/bash -e\nfalse\n", { mode: 0o644 });
      const { argv, script } = scriptProgram("scripts/a.sh", file, ["x"]);
      expect(argv).toEqual(["/bin/bash", "-e", file, "x"]);
      expect(script).toEqual({ ref: "scripts/a.sh", firstLine: "#!/bin/bash -e" });
      fs.writeFileSync(file, "echo hi\n");
      expect(scriptProgram("scripts/a.sh", file, []).script.firstLine).toBeUndefined();
    } finally {
      sandbox.cleanup();
    }
  });
});

describe("captureScriptTarget refuses a script scriptCommand cannot start", () => {
  test("an extension with no program and no first line is refused at capture", () => {
    const sandbox = makeSandboxDir("script-capture");
    try {
      const file = path.join(sandbox.dir, "data.xyz");
      fs.writeFileSync(file, "data\n");
      expect(() => captureScriptTarget("scripts/data.xyz", file, sandbox.dir, (f) => fs.readFileSync(f))).toThrow(
        UsageError,
      );
      fs.writeFileSync(file, "#!/bin/sh\necho\n");
      expect(captureScriptTarget("scripts/data.xyz", file, sandbox.dir, (f) => fs.readFileSync(f)).extension).toBe(
        ".xyz",
      );
    } finally {
      sandbox.cleanup();
    }
  });
});

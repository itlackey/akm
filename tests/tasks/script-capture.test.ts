import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { scriptProgram } from "../../src/tasks/frozen-script";
import {
  bunArguments,
  captureScriptTarget,
  scriptFirstLine,
  scriptInterpreter,
} from "../../src/tasks/prepare/script-capture";
import { makeSandboxDir } from "../_helpers/sandbox";

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

describe("scriptInterpreter — Bun absent", () => {
  test(".js falls back to node when Bun is unavailable", () => {
    withoutBun(() => {
      expect(scriptInterpreter(".js", "scripts/x")).toBe("node");
    });
  });

  test(".mjs falls back to node when Bun is unavailable", () => {
    withoutBun(() => {
      expect(scriptInterpreter(".mjs", "scripts/x")).toBe("node");
    });
  });

  test(".ts falls back to node only when this Node build strips types natively", () => {
    withoutBun(() => {
      withNodeTypeScriptSupport(true, () => {
        expect(scriptInterpreter(".ts", "scripts/x")).toBe("node");
      });
      withNodeTypeScriptSupport(false, () => {
        expect(() => scriptInterpreter(".ts", "scripts/x")).toThrow(UsageError);
      });
    });
  });

  test("a non-JS interpreter (.py) is untouched by the Bun-absent fallback", () => {
    withoutBun(() => {
      expect(scriptInterpreter(".py", "scripts/x")).toBe("python");
    });
  });
});

describe("scriptInterpreter — Bun present", () => {
  test(".js still resolves to bun, not node, when Bun is available", () => {
    expect(scriptInterpreter(".js", "scripts/x")).toBe("bun");
  });

  test(".mjs resolves to bun, like .js", () => {
    expect(scriptInterpreter(".mjs", "scripts/x")).toBe("bun");
  });
});

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("a script's first line, read as the kernel reads it", () => {
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

describe("scriptInterpreter: the first line decides, then the extension", () => {
  test("a first line that names a program is run as written, whatever the extension", () => {
    for (const [extension, first] of [
      [".sh", "#!/usr/bin/env bash"],
      [".sh", "#!/bin/bash -e"],
      [".py", "#!/usr/bin/env python3"],
      [".js", "#!/usr/bin/env node"],
      ["", "#!/usr/bin/env bash"],
      [".awk", "#!/usr/bin/awk -f"],
    ] as const) {
      expect(scriptInterpreter(extension, "scripts/x", bytesOf(`${first}\n`), "linux")).toBe("shebang");
    }
  });

  test("a first line that names bun runs on akm's own runtime, with or without an extension", () => {
    for (const first of ["#!/usr/bin/env bun", "#!/usr/local/bin/bun", "#!/usr/bin/env -S bun --smol"]) {
      expect(scriptInterpreter(".ts", "scripts/x.ts", bytesOf(`${first}\n`), "linux")).toBe("bun");
      expect(scriptInterpreter("", "scripts/x", bytesOf(`${first}\n`), "linux")).toBe("bun");
    }
    expect(bunArguments(scriptFirstLine(bytesOf("#!/usr/bin/env -S bun --smol\n")))).toEqual(["--smol"]);
    expect(bunArguments(scriptFirstLine(bytesOf("#!/usr/bin/env bash\n")))).toBeUndefined();
  });

  test("with no first line the extension selects the interpreter", () => {
    expect(scriptInterpreter(".sh", "scripts/x.sh", bytesOf("echo hi\n"), "linux")).toBe("sh");
    expect(scriptInterpreter(".py", "scripts/x.py", bytesOf("print('hi')\n"), "linux")).toBe("python");
    expect(scriptInterpreter(".ts", "scripts/x.ts", bytesOf("console.log(1)\n"), "linux")).toBe("bun");
  });

  test("Windows has no first lines: the extension decides there", () => {
    expect(scriptInterpreter(".sh", "scripts/x.sh", bytesOf("#!/usr/bin/env bash\n"), "win32")).toBe("sh");
    expect(scriptInterpreter(".py", "scripts/x.py", bytesOf("#!/usr/bin/env python3\n"), "win32")).toBe("python");
  });

  test("a script with neither a first line nor a known extension is refused, naming both", () => {
    for (const bytes of [bytesOf("plain text\n"), undefined]) {
      expect(() => scriptInterpreter("", "scripts/x", bytes, "linux")).toThrow(/no `#!` first line/);
    }
    expect(() => scriptInterpreter(".xyz", "scripts/x.xyz", bytesOf("data\n"), "linux")).toThrow(/extension ".xyz"/);
  });
});

describe("scriptProgram: the command a script is started with", () => {
  const withScript = (name: string, text: string, check: (file: string) => void) => {
    const sandbox = makeSandboxDir("script-program");
    try {
      const file = path.join(sandbox.dir, name);
      // Mode 644: a script asset need not be executable, since its program is given the file.
      fs.writeFileSync(file, text, { mode: 0o644 });
      check(file);
    } finally {
      sandbox.cleanup();
    }
  };

  test.skipIf(process.platform === "win32")(
    "is the first line's program, its one argument, the file, then the arguments",
    () => {
      withScript("a.sh", "#!/bin/bash -e\nfalse\n", (file) => {
        expect(scriptProgram("scripts/a.sh", file, ["x y", "--flag"])).toEqual([
          "/bin/bash",
          "-e",
          file,
          "x y",
          "--flag",
        ]);
      });
      withScript("b.sh", "#!/usr/bin/env -S bash -eu\n", (file) => {
        expect(scriptProgram("scripts/b.sh", file, [])).toEqual(["/usr/bin/env", "-S bash -eu", file]);
      });
      withScript("c.py", "#!/usr/bin/env python3\nprint(1)\n", (file) => {
        expect(scriptProgram("scripts/c.py", file, [])).toEqual(["/usr/bin/env", "python3", file]);
      });
    },
  );

  test.skipIf(process.platform === "win32")("a script for bun runs on this runtime with the words after bun", () => {
    withScript("d.ts", "#!/usr/bin/env bun\nconsole.log(1)\n", (file) => {
      expect(scriptProgram("scripts/d.ts", file, ["a"])).toEqual([process.execPath, file, "a"]);
    });
    withScript("e.ts", "#!/usr/bin/env -S bun --smol\nconsole.log(1)\n", (file) => {
      expect(scriptProgram("scripts/e.ts", file, [])).toEqual([process.execPath, "--smol", file]);
    });
  });

  test.skipIf(process.platform === "win32")("a Python script with no first line runs under python3", () => {
    withScript("f.py", "print(1)\n", (file) => {
      expect(scriptProgram("scripts/f.py", file, [])).toEqual(["python3", file]);
    });
  });

  test.skipIf(process.platform === "win32")("running that command does what running the file directly does", () => {
    const run = (file: string, args: string[] = []) => {
      const [program, ...rest] = scriptProgram(`scripts/${path.basename(file)}`, file, args);
      return spawnSync(program as string, rest, { encoding: "utf8" });
    };
    // `-e` on the first line stops the script at the failing command.
    withScript("stop.sh", "#!/bin/bash -e\nfalse\necho still-running\n", (file) => {
      const result = run(file);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    });
    // A bash-only construct runs, because bash was named.
    withScript("array.sh", '#!/usr/bin/env bash\ndeclare -a list=(a b)\necho "${#list[@]} $1"\n', (file) => {
      expect(run(file, ["x y"]).stdout).toBe("2 x y\n");
    });
    // `env -S` splits its one argument into the program and its flags.
    withScript("unset.sh", '#!/usr/bin/env -S bash -eu\necho "$NOT_SET"\necho reached\n', (file) => {
      const result = run(file);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    });
  });
});

describe("captureScriptTarget reads the script's bytes for its first line", () => {
  test("an extensionless script with a first line is captured as one run by that line", () => {
    const sandbox = makeSandboxDir("script-capture");
    try {
      const file = path.join(sandbox.dir, "run-me");
      fs.writeFileSync(file, "#!/usr/bin/env bash\necho hi\n");
      const captured = captureScriptTarget("scripts/run-me", file, sandbox.dir, (f) => fs.readFileSync(f));
      expect(captured.interpreter).toBe(process.platform === "win32" ? "sh" : "shebang");
      expect(captured.extension).toBe("");
    } finally {
      sandbox.cleanup();
    }
  });
});

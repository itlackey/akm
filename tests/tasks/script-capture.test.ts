import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { captureScriptTarget, scriptInterpreter } from "../../src/tasks/prepare/script-capture";
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

describe("scriptInterpreter: a .sh script runs under the shell its first line names", () => {
  const of = (content: string) => scriptInterpreter(".sh", "scripts/x.sh", new TextEncoder().encode(content));

  test("bash, zsh, ksh and dash are run as named, so a script that needs bash is not handed to sh", () => {
    expect(of("#!/usr/bin/env bash\ndeclare -a list=()\n")).toBe("bash");
    expect(of("#!/bin/bash\necho hi\n")).toBe("bash");
    expect(of("#!/usr/bin/env zsh\necho hi\n")).toBe("zsh");
    expect(of("#!/bin/ksh\necho hi\n")).toBe("ksh");
    expect(of("#!/bin/dash\necho hi\n")).toBe("dash");
  });

  test("sh, no first line, or a first line that names no shell runs under sh", () => {
    expect(of("#!/bin/sh\necho hi\n")).toBe("sh");
    expect(of("echo hi\n")).toBe("sh");
    expect(of("#!/usr/bin/env python3\nprint('hi')\n")).toBe("sh");
    expect(scriptInterpreter(".sh", "scripts/x.sh")).toBe("sh");
  });
});

describe("scriptInterpreter — extensionless scripts honour a #! shebang", () => {
  test("recognizes #!/usr/bin/env NAME and #!/path/to/NAME forms", () => {
    const cases: Array<[string, string]> = [
      ["#!/usr/bin/env bash\necho hi\n", "bash"],
      ["#!/bin/zsh\necho hi\n", "zsh"],
      ["#!/bin/sh\necho hi\n", "sh"],
      ["#!/usr/bin/env python3\nprint('hi')\n", "python"],
      ["#!/usr/bin/env ruby\nputs 'hi'\n", "ruby"],
      ["#!/usr/bin/perl\nprint 'hi';\n", "perl"],
    ];
    for (const [content, expected] of cases) {
      expect(scriptInterpreter("", "scripts/x", new TextEncoder().encode(content))).toBe(
        expected as ReturnType<typeof scriptInterpreter>,
      );
    }
  });

  test("an unrecognized shebang still rejects with the closed-interpreter message", () => {
    expect(() =>
      scriptInterpreter("", "scripts/x", new TextEncoder().encode("#!/usr/bin/env made-up-language\n")),
    ).toThrow(/no closed runtime interpreter/);
  });

  test("no shebang at all still rejects", () => {
    expect(() => scriptInterpreter("", "scripts/x", new TextEncoder().encode("plain text, no shebang\n"))).toThrow(
      /no closed runtime interpreter/,
    );
    expect(() => scriptInterpreter("", "scripts/x")).toThrow(/no closed runtime interpreter/);
  });
});

describe("captureScriptTarget threads bytes through for shebang detection", () => {
  test("an extensionless script with a recognized shebang captures successfully", () => {
    const sandbox = makeSandboxDir("script-capture");
    try {
      const file = path.join(sandbox.dir, "run-me");
      fs.writeFileSync(file, "#!/usr/bin/env bash\necho hi\n");
      const captured = captureScriptTarget("scripts/run-me", file, sandbox.dir, (f) => fs.readFileSync(f));
      expect(captured.interpreter).toBe("bash");
      expect(captured.extension).toBe("");
    } finally {
      sandbox.cleanup();
    }
  });
});

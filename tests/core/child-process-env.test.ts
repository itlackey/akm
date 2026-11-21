import { expect, test } from "bun:test";
import { childProcessEnv } from "../../src/core/paths";
import { withEnvSync } from "../_helpers/sandbox";

test("the environment of a process akm starts omits the launcher's own AKM_LAUNCHER_* variables and keeps the rest", () => {
  withEnvSync({ AKM_LAUNCHER_NODE: "/n", AKM_LAUNCHER_PATH: "/l", AKM_LAUNCHER_PID: "42", USER_VAR: "kept" }, () => {
    const env = childProcessEnv();
    expect(Object.keys(env).filter((name) => name.startsWith("AKM_LAUNCHER_"))).toEqual([]);
    expect(env.USER_VAR).toBe("kept");
  });
});

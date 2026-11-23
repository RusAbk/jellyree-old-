import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../scripts/build.mjs";

test("native build targets are explicit, architecture-specific and never publish", () => {
  for (const [host, target] of [
    ["linux", "linux"],
    ["win32", "win"],
    ["darwin", "mac"],
  ]) {
    for (const arch of ["x64", "arm64"]) {
      const plan = buildPlan([], { platform: host, arch });
      assert.deepEqual(plan.commands.at(-1).args, [
        `--${target}`,
        `--${arch}`,
        "--publish",
        "never",
      ]);
    }
  }
  assert.deepEqual(
    buildPlan(["mac", "--arch", "universal"], {
      platform: "darwin",
      arch: "arm64",
    }).commands.at(-1).args,
    ["--mac", "--universal", "--publish", "never"],
  );
});

test("dry-run can plan all CI platforms on Linux without executing foreign builds", () => {
  for (const target of ["linux", "windows", "macos"]) {
    const plan = buildPlan([target, "--arch=x64", "--dir", "--dry-run"], {
      platform: "linux",
      arch: "arm64",
    });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.arch, "x64");
    assert.equal(plan.commands.at(-1).args.includes("--dir"), true);
  }
  assert.throws(
    () => buildPlan(["mac"], { platform: "linux", arch: "x64" }),
    /macOS/,
  );
});

test("invalid build arguments fail before packaging or publishing can begin", () => {
  for (const args of [
    ["linux", "--arch", "universal"],
    ["--arch"],
    ["--arch=ia32"],
    ["all"],
    ["win", "mac"],
    ["--publish", "always"],
  ]) {
    assert.throws(() => buildPlan(args, { platform: "linux", arch: "x64" }));
  }
});

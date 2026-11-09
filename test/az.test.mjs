// azRun against the fake CLI: a spawn that fails before the child starts rejects with an Error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

process.env.AZ_PATH = fileURLToPath(new URL("./fixtures/fake-az.mjs", import.meta.url));
const { azRun } = await import("../dist/az.js");

test("azRun rejects with an Error when the process cannot be spawned", async () => {
  await assert.rejects(azRun(["group", "list\0"]), (error) => error instanceof Error && error.code === "ERR_INVALID_ARG_VALUE");
});

test("azRun runs the fake CLI and returns its output", async () => {
  const run = await azRun(["group", "list"]);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(JSON.parse(run.stdout).argv, ["group", "list"]);
});

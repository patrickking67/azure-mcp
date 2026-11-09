// Unit tests for the JSON helpers in the built client module. No network, no Azure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { textOf } from "../dist/client.js";

test("textOf keeps scalars and drops objects, arrays and null", () => {
  assert.equal(textOf("PowerState/running"), "PowerState/running");
  assert.equal(textOf(20260101), "20260101");
  assert.equal(textOf(false), "false");
  assert.equal(textOf(""), "");
  assert.equal(textOf(null), "");
  assert.equal(textOf(undefined), "");
  assert.equal(textOf({ code: "x" }), "");
  assert.equal(textOf(["a", "b"]), "");
});

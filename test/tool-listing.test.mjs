// Pins the full tools/list answer: every tool's name, title, description, input schema, annotations and
// _meta, in registration order. A dependency or SDK upgrade must not change what clients are shown.
//
//   UPDATE_TOOL_LISTING=1 node --test test/tool-listing.test.mjs   rewrite the snapshot on purpose
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const snapshotPath = fileURLToPath(new URL("./fixtures/tool-listing.json", import.meta.url));

async function listTools() {
  // No Azure or identity settings: the listing must not depend on configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AZURE_|^AZ_PATH$|^IDENTITY_|^MSI_/.test(k)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  await client.close();
  return tools;
}

test("tool listing matches the committed snapshot", async () => {
  const tools = await listTools();
  if (process.env.UPDATE_TOOL_LISTING === "1") {
    writeFileSync(snapshotPath, `${JSON.stringify(tools, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.deepEqual(tools.map((t) => t.name), expected.map((t) => t.name), "tool names and order");
  for (const [i, tool] of tools.entries()) {
    assert.equal(tool.description, expected[i].description, `${tool.name} description`);
    assert.deepEqual(tool.inputSchema, expected[i].inputSchema, `${tool.name} input schema`);
    assert.deepEqual(tool, expected[i], `${tool.name} listing entry`);
  }
});

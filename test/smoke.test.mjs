// Drives the built stdio server with a fake Azure CLI: tool surface, gates and CLI policy, no Azure calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fakeAz = fileURLToPath(new URL("./fixtures/fake-az.mjs", import.meta.url));

async function connect(env = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AZURE_|^AZ_PATH$|^IDENTITY_|^MSI_/.test(k)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env: { ...base, AZ_PATH: fakeAz, ...env }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}
const text = (r) => r.content?.[0]?.text ?? "";
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });

test("tool surface: titles, tiers, confirm on every write, views carry ui meta", async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  assert.ok(tools.length >= 100, `expected 100+ tools, got ${tools.length}`);
  for (const t of tools) {
    assert.ok(t.title && !t.title.includes("_"), `${t.name} title`);
    const write = t.annotations?.readOnlyHint !== true;
    assert.equal(Boolean(t.inputSchema.properties?.confirm), write, `${t.name} confirm`);
    if (write) assert.equal(t._meta?.["anthropic/requiresUserInteraction"], true, `${t.name} interaction meta`);
  }
  const views = tools.filter((t) => t.name.startsWith("View_"));
  assert.equal(views.length, 6);
  for (const v of views) assert.match(v._meta.ui.resourceUri, /^ui:\/\/azure\//);
  const html = await c.readResource({ uri: "ui://azure/estate.html" });
  assert.equal(html.contents[0].mimeType, "text/html;profile=mcp-app");
  await c.close();
});

test("read mode refuses writes and destructive calls", async () => {
  const c = await connect();
  const start = await call(c, "Start_VM", { resource_group: "rg", vm_name: "vm", confirm: true });
  assert.equal(start.isError, true);
  assert.match(text(start), /AZURE_MODE=write/);
  const run = await call(c, "Az_CLI_Run", { args: ["group", "create", "-n", "rg", "-l", "eastus"], confirm: true });
  assert.equal(run.isError, true);
  assert.match(text(run), /read mode/);
  const missingConfirm = await call(c, "Start_VM", { resource_group: "rg", vm_name: "vm" });
  assert.equal(missingConfirm.isError, true);
  await c.close();
});

test("write mode opens writes but not the destructive tier", async () => {
  const c = await connect({ AZURE_MODE: "write" });
  const create = await call(c, "Az_CLI_Run", { args: ["group", "create", "-n", "rg", "-l", "eastus"], confirm: true });
  assert.equal(create.isError, undefined, text(create));
  const created = JSON.parse(text(create)).output;
  assert.deepEqual(created.argv, ["group", "create", "-n", "rg", "-l", "eastus", "--output", "json"]);
  // The CLI runs in an empty sandbox directory, not the server's working directory.
  assert.match(created.cwd, /azure-mcp-cwd-/);
  const del = await call(c, "Az_CLI_Run", { command: "az group delete -n rg --yes", confirm: true });
  assert.equal(del.isError, true);
  assert.match(text(del), /AZURE_ALLOW_DESTRUCTIVE=true/);
  await c.close();
});

test("both gates open the destructive tier", async () => {
  const c = await connect({ AZURE_MODE: "write", AZURE_ALLOW_DESTRUCTIVE: "true" });
  const del = await call(c, "Az_CLI_Run", { command: "group delete -n rg --yes", confirm: true, subscription_id: "00000000-0000-0000-0000-000000000000" });
  assert.equal(del.isError, undefined, text(del));
  const argv = JSON.parse(text(del)).output.argv;
  assert.deepEqual(argv.slice(-4), ["--subscription", "00000000-0000-0000-0000-000000000000", "--output", "json"]);
  await c.close();
});

test("Az_CLI runs reads, refuses writes, credentials and blocked commands", async () => {
  const c = await connect({ AZURE_MODE: "write", AZURE_ALLOW_DESTRUCTIVE: "true" });
  const ok = await call(c, "Az_CLI", { args: ["vm", "list", "-o", "table"] });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(JSON.parse(text(ok)).output.argv, ["vm", "list", "-o", "table"]);
  for (const args of [["group", "delete", "-n", "x"], ["storage", "account", "keys", "list", "-n", "x"], ["account", "get-access-token"], ["rest", "--url", "/x", "--body", "@/etc/passwd"]]) {
    const r = await call(c, "Az_CLI", { args });
    assert.equal(r.isError, true, args.join(" "));
    assert.match(text(r), /Nothing was run/);
  }
  const token = await call(c, "Az_CLI_Run", { args: ["account", "get-access-token"], confirm: true });
  assert.equal(token.isError, true);
  const failed = await call(c, "Az_CLI", { args: ["fail", "list"] });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /boom/);
  await c.close();
});

test("Az_CLI_Help and Status tools answer without Azure", async () => {
  const c = await connect();
  assert.match(text(await call(c, "Az_CLI_Help", { command: ["vm", "start"] })), /fake help/);
  const status = JSON.parse(text(await call(c, "Status_Server")));
  assert.equal(status.auth_mode, "azure_cli");
  assert.equal(status.gate.mode, "read");
  await c.close();
});

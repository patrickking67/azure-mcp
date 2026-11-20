// Drives the built stdio server with a fake Azure CLI: tool surface, gates and CLI policy, no Azure calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import catalog from "../src/upstream/generated/catalog.json" with { type: "json" };

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
  const { tools: all } = await c.listTools();
  const upstream = all.filter((t) => /Microsoft Azure MCP Server/.test(t.description ?? ""));
  // Microsoft's tools are proxied with their own schemas (no confirm); src/upstream/register.ts gates them.
  assert.equal(upstream.length, catalog.namespace.length, `expected ${catalog.namespace.length} Microsoft namespace tools, got ${upstream.length}`);
  for (const t of upstream) {
    assert.ok(t.title && !t.title.includes("_"), `${t.name} title`);
    assert.ok(t.inputSchema.properties?.profile, `${t.name} profile`);
  }
  const tools = all.filter((t) => !upstream.includes(t));
  assert.ok(tools.length >= 100, `expected 100+ tools, got ${tools.length}`);
  for (const t of tools) {
    assert.ok(t.title && !t.title.includes("_"), `${t.name} title`);
    assert.ok(t.inputSchema.properties?.profile, `${t.name} profile`);
    const write = t.annotations?.readOnlyHint !== true;
    assert.equal(Boolean(t.inputSchema.properties?.confirm), write, `${t.name} confirm`);
    if (write) assert.equal(t._meta?.["anthropic/requiresUserInteraction"], true, `${t.name} interaction meta`);
  }
  const views = tools.filter((t) => t.name.startsWith("View_"));
  assert.equal(views.length, 8);
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

test("both gates open still refuse a write without confirm: true", async () => {
  const c = await connect({ AZURE_MODE: "write", AZURE_ALLOW_DESTRUCTIVE: "true" });
  for (const confirm of [undefined, false, "true", 1]) {
    const start = await call(c, "Start_VM", { resource_group: "rg", vm_name: "vm", confirm });
    assert.equal(start.isError, true, `Start_VM confirm=${String(confirm)}`);
    const run = await call(c, "Az_CLI_Run", { args: ["group", "create", "-n", "rg", "-l", "eastus"], confirm });
    assert.equal(run.isError, true, `Az_CLI_Run confirm=${String(confirm)}`);
    assert.doesNotMatch(text(run), /"argv"/, "the CLI must not run");
  }
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

test("subscription_id cannot smuggle a local file or a flag into the CLI", async () => {
  const c = await connect({ AZURE_MODE: "write", AZURE_ALLOW_DESTRUCTIVE: "true" });
  try {
    for (const subscription_id of ["@/etc/hosts", "--debug", "~/.azure/azureProfile.json"]) {
      for (const tool of ["Az_CLI", "Az_CLI_Run"]) {
        const r = await call(c, tool, { args: ["group", "list"], subscription_id, confirm: tool === "Az_CLI_Run" ? true : undefined });
        assert.equal(r.isError, true, `${tool} ${subscription_id}`);
        assert.doesNotMatch(text(r), /"argv"/, `${tool} ${subscription_id} must not reach the CLI`);
      }
    }
    const ok = await call(c, "Az_CLI", { args: ["group", "list"], subscription_id: "00000000-0000-0000-0000-000000000000" });
    assert.equal(ok.isError, undefined, text(ok));
  } finally {
    await c.close();
  }
});

test("Microsoft tools are gated per routed command", async () => {
  const c = await connect();
  const destructive = await call(c, "storage", { intent: "t", command: "storage_account_create", parameters: {} });
  assert.equal(destructive.isError, true);
  assert.match(text(destructive), /AZURE_ALLOW_DESTRUCTIVE=true/);
  const secret = await call(c, "keyvault", { intent: "t", command: "keyvault_secret_get", parameters: {} });
  assert.equal(secret.isError, true);
  assert.match(text(secret), /AZURE_MODE=write/);
  const unknown = await call(c, "storage", { intent: "t", command: "storage_not_a_real_command" });
  assert.equal(unknown.isError, true, "unknown commands are treated as writes");
  // Microsoft marks these read-only; they return secrets or bearer URLs, so they are gated as writes.
  for (const [tool, command] of [
    ["appservice", "appservice_webapp_settings_get-appsettings"],
    ["appconfig", "appconfig_kv_get"],
    ["resiliency", "resiliency_drill_run_get-report-download-url"],
    ["keyvault", "KEYVAULT_SECRET_GET"],
    ["keyvault", " keyvault_secret_get "],
  ]) {
    const r = await call(c, tool, { intent: "t", command, parameters: {} });
    assert.equal(r.isError, true, `${command} is refused in read mode`);
    assert.match(text(r), /AZURE_MODE=write/, command);
  }
  // learn: true does not make a routed command a read.
  const learned = await call(c, "keyvault", { intent: "t", learn: true, command: "keyvault_secret_get", parameters: {} });
  assert.equal(learned.isError, true, "learn alongside a command is still gated by the command");
  const nonString = await call(c, "keyvault", { intent: "t", command: ["keyvault_secret_get"], parameters: {} });
  assert.equal(nonString.isError, true, "a non-string command is treated as a write");
  // The services view serves a command's schema from the catalog, offline.
  const schema = await call(c, "View_Azure_Services", { command: "storage_account_get" });
  assert.notEqual(schema.isError, true);
  assert.equal(schema.structuredContent.command.tier, "read");
  assert.ok(schema.structuredContent.command.inputSchema.properties);
  assert.deepEqual(schema.structuredContent.command.own, ["List_Storage_Accounts"]);
  const missing = await call(c, "View_Azure_Services", { command: "not_a_command" });
  assert.equal(missing.isError, true);
  await c.close();
});

test("tenant profiles parse from settings slots, never show a secret, and route by name or tenant id", async () => {
  const secretValue = "s3cret-value-that-must-not-leak";
  const c = await connect({
    AZURE_PROFILE_NAME: "first",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-00000000000a",
    AZURE_CLIENT_ID: "aaaaaaaa-0000-0000-0000-000000000000",
    AZURE_CLIENT_SECRET: secretValue,
    AZURE_PROFILE_1_NAME: "Second Tenant",
    AZURE_PROFILE_1_TENANT_ID: "00000000-0000-0000-0000-00000000000b",
    AZURE_PROFILE_1_CLIENT_ID: "bbbbbbbb-0000-0000-0000-000000000000",
    AZURE_PROFILE_1_CLIENT_SECRET: secretValue,
    AZURE_PROFILE_2_TENANT_ID: "incomplete",
    AZURE_DEFAULT_PROFILE: "Second-Tenant",
  });
  const listed = await call(c, "List_Tenant_Profiles");
  const body = JSON.parse(text(listed));
  assert.deepEqual(body.profiles.map((p) => p.name), ["first", "Second-Tenant", "cli"]);
  assert.equal(body.default_profile, "Second-Tenant");
  assert.equal(body.problems.length, 1);
  assert.ok(!text(listed).includes(secretValue));
  const status = await call(c, "Status_Server");
  assert.ok(!text(status).includes(secretValue));
  const missing = await call(c, "Status_Gate", { profile: "nope" });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /first, Second-Tenant, cli/);
  const byTenant = await call(c, "Status_Gate", { profile: "00000000-0000-0000-0000-00000000000b" });
  assert.notEqual(byTenant.isError, true);
  await c.close();
});

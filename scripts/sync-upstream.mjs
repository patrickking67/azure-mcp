#!/usr/bin/env node
// Snapshot Microsoft's Azure MCP Server tool catalog into src/upstream/generated/catalog.json.
//
// The server proxies every tool of the bundled @azure/mcp one-to-one. Listing them at runtime would mean
// starting the .NET server before the first tools/list, so the listing is taken here, from the pinned
// version in node_modules, in both of its modes:
//
//   namespace  Microsoft's default: one router tool per service (aks, storage, keyvault, ...)
//   all        every command as its own tool (aks_cluster_get, storage_account_get, ...)
//
// The "all" listing also carries each command's annotations, which is how a namespace-mode call
// (command: "keyvault_secret_get") is gated as read, write or destructive.
//
//   node scripts/sync-upstream.mjs           rewrite the catalog
//   node scripts/sync-upstream.mjs --check   exit 1 if it would change
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "upstream", "generated", "catalog.json");
const check = process.argv.includes("--check");
const require = createRequire(join(ROOT, "package.json"));

const version = JSON.parse(readFileSync(require.resolve("@azure/mcp/package.json"), "utf8")).version;
const platformPackage = `@azure/mcp-${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;
const binary = join(dirname(require.resolve(`${platformPackage}/package.json`)), "dist", process.platform === "win32" ? "azmcp.exe" : "azmcp");
if (!existsSync(binary)) throw new Error(`sync-upstream: ${binary} is missing; run npm ci`);

// Raw JSON-RPC, not @modelcontextprotocol/client: azmcp advertises some non-object output schemas, which the
// SDK client rejects for the whole listing. The catalog drops outputSchema anyway.
async function list(mode) {
  const child = spawn(binary, ["server", "start", "--mode", mode], { env: { ...process.env, AZURE_MCP_COLLECT_TELEMETRY: "false" }, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sync-upstream", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listOnce = async () => {
    const tools = [];
    let cursor;
    do {
      const page = await request("tools/list", cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  };
  // azmcp adds tools it proxies from Microsoft's remote MCP servers (Foundry, ARM, docs) as they connect,
  // so in "all" mode the listing grows for a while. Poll until it holds still for three reads, at most ~90s.
  let tools = await listOnce();
  for (let stable = 0, tries = 0; mode === "all" && stable < 3 && tries < 30; tries += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    const next = await listOnce();
    stable = next.length === tools.length ? stable + 1 : 0;
    tools = next;
  }
  child.kill("SIGTERM");
  if (mode === "all") tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools.map((t) => ({
    name: t.name,
    title: t.title ?? t.annotations?.title ?? null,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
    annotations: t.annotations ?? {},
  }));
}

const namespace = await list("namespace");
const currentText = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
if (check) {
  // The "all" listing depends on Microsoft's remote servers answering, so the offline check compares the
  // version and the namespace listing, which are fixed by the pinned package.
  const current = currentText ? JSON.parse(currentText) : null;
  if (!current || current.version !== version || JSON.stringify(current.namespace) !== JSON.stringify(namespace)) {
    console.error(`sync-upstream: src/upstream/generated/catalog.json is out of date for @azure/mcp ${version}; run npm run upstream:sync`);
    process.exit(1);
  }
  console.error(`sync-upstream: catalog for @azure/mcp ${version} is current (${namespace.length} namespace tools, ${current.all.length} commands)`);
  process.exit(0);
}
// Microsoft's remote servers (arm, foundry, dashboards, ...) join the "all" listing as they connect, and a
// slow one can be missing from a read. Writing that would silently drop its commands, so a command prefix
// that the current snapshot has and this read lacks means: read again, and refuse after three tries.
const prefix = (name) => name.split("_")[0];
const previous = new Set(currentText ? JSON.parse(currentText).all.map((t) => prefix(t.name)) : []);
const missing = (all) => {
  const now = new Set(all.map((t) => prefix(t.name)));
  return [...previous].filter((p) => !now.has(p));
};
let all = await list("all");
for (let tries = 1; missing(all).length && tries < 3; tries += 1) {
  console.error(`sync-upstream: no commands yet for ${missing(all).join(", ")}; listing again`);
  all = await list("all");
}
if (missing(all).length && !process.argv.includes("--allow-removed")) {
  console.error(`sync-upstream: ${missing(all).join(", ")} had commands in the current catalog and have none now. If Microsoft removed them, rerun with --allow-removed.`);
  process.exit(1);
}
const catalog = { package: "@azure/mcp", version, namespace, all };
const text = `${JSON.stringify(catalog, null, 1)}\n`;
const current = currentText;
if (current === text) {
  console.error(`sync-upstream: catalog for @azure/mcp ${version} is current (${catalog.namespace.length} namespace tools, ${catalog.all.length} commands)`);
} else if (check) {
  console.error(`sync-upstream: src/upstream/generated/catalog.json is out of date for @azure/mcp ${version}; run npm run upstream:sync`);
  process.exit(1);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.error(`sync-upstream: wrote catalog for @azure/mcp ${version} (${catalog.namespace.length} namespace tools, ${catalog.all.length} commands)`);
}

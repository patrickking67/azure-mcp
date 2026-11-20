// Microsoft's Azure MCP Server catalog against this server: the overlap map, service ownership of every
// command, and the sensitive-read rule. Runs against dist/ and the pinned catalog, no azmcp process.
import { test } from "node:test";
import assert from "node:assert/strict";
import catalog from "../src/upstream/generated/catalog.json" with { type: "json" };
import listing from "./fixtures/tool-listing.json" with { type: "json" };
import { OWN_TO_UPSTREAM } from "../dist/upstream/overlap.js";
import { isSensitiveCommand, serviceOf, upstreamServices } from "../dist/upstream/register.js";

const commands = new Set(catalog.all.map((t) => t.name));
const ownTools = new Set(listing.map((t) => t.name));

test("every overlap entry names a real own tool and a real Microsoft command", () => {
  for (const [own, upstream] of Object.entries(OWN_TO_UPSTREAM)) {
    assert.ok(ownTools.has(own), `${own} is not one of this server's tools`);
    for (const name of upstream) assert.ok(commands.has(name), `${name} (for ${own}) is not in @azure/mcp ${catalog.version}; fix src/upstream/overlap.ts`);
  }
});

test("every Microsoft command belongs to a service in the explorer", () => {
  const orphans = catalog.all.map((t) => t.name).filter((name) => !serviceOf(name));
  assert.deepEqual(orphans, [], "add these to REMOTE_PREFIXES in src/upstream/register.ts");
  const listed = upstreamServices().reduce((n, s) => n + s.commands.length, 0);
  assert.equal(listed, catalog.all.length);
});

test("reads that return secrets, settings or bearer URLs are sensitive", () => {
  for (const name of [
    "keyvault_secret_get",
    "keyvault_key_get",
    "appservice_webapp_settings_get-appsettings",
    "appconfig_kv_get",
    "resiliency_drill_run_get-report-download-url",
    "foundry_session_file_download",
    "foundry_evaluation_dataset_sas_url_get",
    "storage_account_connectionstring_get",
    "Some_Future_Secret_Show",
    "aks_cluster_kubeconfig_get",
  ]) assert.equal(isSensitiveCommand(name), true, name);
  for (const name of ["storage_account_get", "group_list", "compute_vm_get", "keyvault_certificate_get", "monitor_metrics_query", "appconfig_account_list"]) {
    assert.equal(isSensitiveCommand(name), false, name);
  }
});

test("no read command in the catalog that names a secret is advertised read-only", () => {
  const services = upstreamServices();
  const tiers = new Map(services.flatMap((s) => s.commands.map((c) => [c.name, c.tier])));
  for (const t of catalog.all) {
    if (isSensitiveCommand(t.name)) assert.notEqual(tiers.get(t.name), "read", t.name);
  }
});

// List tools scoped to a resource group or a parent resource.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { armCollect, armRequest, dig, formatResult, isJsonObject, propsOf, resolveSubscription, skuNameOf, type JsonObject, type JsonValue } from "../client.js";
import { defineTool } from "./define.js";
import { resourceGroupParam, segment, subscriptionSchema } from "./shared.js";

const rgPath = (sub: string, rg: string) => `/subscriptions/${sub}/resourceGroups/${segment(rg, "resource_group")}`;

export function registerScopedTools(server: McpServer): void {
  defineTool(server, {
    name: "List_SQL_Databases",
    title: "List SQL Databases",
    description: "List databases on an Azure SQL server.",
    tier: "read",
    cli: "az sql db list -g <rg> -s <server>",
    ref: { method: "GET", path: "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Sql/servers/{server}/databases", apiVersion: "2025-01-01" },
    inputSchema: { ...subscriptionSchema, resource_group: resourceGroupParam("SQL server"), server_name: z.string().describe("Azure SQL logical server name.") },
    handler: async ({ subscription_id, resource_group, server_name }) => {
      const sub = await resolveSubscription(subscription_id);
      const { items, truncated } = await armCollect(`${rgPath(sub, resource_group)}/providers/Microsoft.Sql/servers/${segment(server_name, "server_name")}/databases`, { apiVersion: "2025-01-01" });
      const databases = items.map((d) => {
        const props = propsOf(d);
        return { id: d.id ?? null, name: d.name ?? null, location: d.location ?? null, status: props.status ?? null, sku: skuNameOf(d), tier: dig(d, "sku", "tier"), max_size_bytes: props.maxSizeBytes ?? null, collation: props.collation ?? null };
      });
      return formatResult({ subscription_id: sub, resource_group, server_name, count: databases.length, truncated, databases });
    },
  });

  defineTool(server, {
    name: "List_Subnets",
    title: "List Subnets",
    description: "List subnets in a virtual network.",
    tier: "read",
    cli: "az network vnet subnet list -g <rg> --vnet-name <vnet>",
    ref: { method: "GET", path: "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{vnet}/subnets", apiVersion: "2023-09-01" },
    inputSchema: { ...subscriptionSchema, resource_group: resourceGroupParam("virtual network"), vnet_name: z.string().describe("Virtual network name.") },
    handler: async ({ subscription_id, resource_group, vnet_name }) => {
      const sub = await resolveSubscription(subscription_id);
      const { items, truncated } = await armCollect(`${rgPath(sub, resource_group)}/providers/Microsoft.Network/virtualNetworks/${segment(vnet_name, "vnet_name")}/subnets`, { apiVersion: "2023-09-01" });
      const subnets = items.map((s) => {
        const props = propsOf(s);
        return {
          name: s.name ?? null,
          address_prefix: props.addressPrefix ?? props.addressPrefixes ?? null,
          network_security_group: dig(props, "networkSecurityGroup", "id"),
          route_table: dig(props, "routeTable", "id"),
          ip_configuration_count: Array.isArray(props.ipConfigurations) ? (props.ipConfigurations as JsonValue[]).length : 0,
        };
      });
      return formatResult({ subscription_id: sub, resource_group, vnet_name, count: subnets.length, truncated, subnets });
    },
  });

  defineTool(server, {
    name: "List_NSG_Rules",
    title: "List NSG Rules",
    description: "List the security rules (custom and default) of a network security group.",
    tier: "read",
    cli: "az network nsg rule list -g <rg> --nsg-name <nsg> [--include-default]",
    ref: { method: "GET", path: "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/networkSecurityGroups/{nsg}", apiVersion: "2023-09-01" },
    inputSchema: {
      ...subscriptionSchema,
      resource_group: resourceGroupParam("NSG"),
      nsg_name: z.string().describe("Network security group name."),
      include_default_rules: z.boolean().optional().describe("Also include Azure default rules."),
    },
    handler: async ({ subscription_id, resource_group, nsg_name, include_default_rules }) => {
      const sub = await resolveSubscription(subscription_id);
      const { body } = await armRequest(`${rgPath(sub, resource_group)}/providers/Microsoft.Network/networkSecurityGroups/${segment(nsg_name, "nsg_name")}`, { apiVersion: "2023-09-01" });
      const props = isJsonObject(body) ? propsOf(body) : {};
      const mapRule = (r: JsonObject): JsonObject => {
        const p = propsOf(r);
        return {
          name: r.name ?? null,
          priority: p.priority ?? null,
          direction: p.direction ?? null,
          access: p.access ?? null,
          protocol: p.protocol ?? null,
          source: p.sourceAddressPrefix ?? p.sourceAddressPrefixes ?? null,
          source_port: p.sourcePortRange ?? p.sourcePortRanges ?? null,
          destination: p.destinationAddressPrefix ?? p.destinationAddressPrefixes ?? null,
          destination_port: p.destinationPortRange ?? p.destinationPortRanges ?? null,
        };
      };
      const rules = (Array.isArray(props.securityRules) ? (props.securityRules as JsonValue[]).filter(isJsonObject) : []).map(mapRule);
      const defaults = include_default_rules && Array.isArray(props.defaultSecurityRules) ? (props.defaultSecurityRules as JsonValue[]).filter(isJsonObject).map(mapRule) : [];
      return formatResult({ subscription_id: sub, resource_group, nsg_name, rule_count: rules.length, rules, default_rules: include_default_rules ? defaults : null });
    },
  });

  defineTool(server, {
    name: "List_DNS_Records",
    title: "List DNS Records",
    description: "List all record sets in a DNS zone.",
    tier: "read",
    cli: "az network dns record-set list -g <rg> -z <zone>",
    ref: { method: "GET", path: "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/dnszones/{zone}/recordsets", apiVersion: "2018-05-01" },
    inputSchema: { ...subscriptionSchema, resource_group: resourceGroupParam("DNS zone"), zone_name: z.string().describe("DNS zone name, e.g. example.com.") },
    handler: async ({ subscription_id, resource_group, zone_name }) => {
      const sub = await resolveSubscription(subscription_id);
      const { items, truncated } = await armCollect(`${rgPath(sub, resource_group)}/providers/Microsoft.Network/dnszones/${segment(zone_name, "zone_name")}/recordsets`, { apiVersion: "2018-05-01" });
      const records = items.map((r) => {
        const props = propsOf(r);
        const { metadata: _metadata, ...data } = props;
        return { name: r.name ?? null, type: r.type ?? null, ttl: props.TTL ?? null, fqdn: props.fqdn ?? null, data };
      });
      return formatResult({ subscription_id: sub, resource_group, zone_name, count: records.length, truncated, records });
    },
  });

  const storageList = (
    name: string,
    title: string,
    description: string,
    service: "blobServices" | "fileServices" | "queueServices" | "tableServices",
    collection: string,
    resultKey: string,
    cli: string,
    map: (item: JsonObject) => JsonObject,
  ) =>
    defineTool(server, {
      name,
      title,
      description,
      tier: "read",
      cli,
      ref: { method: "GET", path: `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}/${service}/default/${collection}`, apiVersion: "2023-01-01" },
      inputSchema: { ...subscriptionSchema, resource_group: resourceGroupParam("storage account"), account_name: z.string().describe("Storage account name.") },
      handler: async ({ subscription_id, resource_group, account_name }) => {
        const sub = await resolveSubscription(subscription_id);
        const { items, truncated } = await armCollect(
          `${rgPath(sub, resource_group)}/providers/Microsoft.Storage/storageAccounts/${segment(account_name, "account_name")}/${service}/default/${collection}`,
          { apiVersion: "2023-01-01" },
        );
        const mapped = items.map(map);
        return formatResult({ subscription_id: sub, resource_group, account_name, count: mapped.length, truncated, [resultKey]: mapped });
      },
    });

  storageList("List_Storage_Containers", "List Storage Containers", "List blob containers in a storage account (via ARM, no data-plane access needed).", "blobServices", "containers", "containers", "az storage container-rm list --storage-account <account>", (c) => {
    const props = propsOf(c);
    return { name: c.name ?? null, public_access: props.publicAccess ?? null, last_modified: props.lastModifiedTime ?? null, lease_state: props.leaseState ?? null, deleted: props.deleted ?? null };
  });
  storageList("List_File_Shares", "List File Shares", "List file shares in a storage account (via ARM).", "fileServices", "shares", "file_shares", "az storage share-rm list --storage-account <account>", (s) => {
    const props = propsOf(s);
    return { name: s.name ?? null, quota_gb: props.shareQuota ?? null, access_tier: props.accessTier ?? null, last_modified: props.lastModifiedTime ?? null };
  });
  storageList("List_Storage_Queues", "List Storage Queues", "List queues in a storage account (via ARM).", "queueServices", "queues", "queues", "az storage queue list --account-name <account> --auth-mode login", (q) => ({
    name: q.name ?? null,
    metadata: dig(propsOf(q), "metadata"),
  }));
  storageList("List_Storage_Tables", "List Storage Tables", "List tables in a storage account (via ARM).", "tableServices", "tables", "tables", "az storage table list --account-name <account> --auth-mode login", (t) => ({
    name: dig(propsOf(t), "tableName") ?? t.name ?? null,
  }));
}

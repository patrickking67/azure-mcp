// Key Vault data plane: secret names and metadata, one secret's value, and setting a secret.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectPaged, dig, formatResult, httpJson, isJsonObject, KEY_VAULT_API_VERSION, KEY_VAULT_RESOURCE, type JsonObject } from "../client.js";
import { defineTool } from "./define.js";
import { KEY_VAULT_NAME, KEY_VAULT_SECRET_NAME } from "./shared.js";

function checkNames(vault: string, secret?: string): void {
  if (!KEY_VAULT_NAME.test(vault)) throw new Error("Invalid key vault name.");
  if (secret !== undefined && !KEY_VAULT_SECRET_NAME.test(secret)) throw new Error("Invalid secret name.");
}

export function registerKeyVaultTools(server: McpServer): void {
  defineTool(server, {
    name: "List_Key_Vault_Secrets",
    title: "List Key Vault Secrets",
    description: "List secret names and metadata in a key vault (never returns secret values). Requires data-plane access (RBAC or access policy).",
    tier: "read",
    cli: "az keyvault secret list --vault-name <vault>",
    ref: { method: "GET", path: "https://{vault}.vault.azure.net/secrets", apiVersion: KEY_VAULT_API_VERSION },
    inputSchema: { vault_name: z.string().describe("Key vault name (the {name} in {name}.vault.azure.net).") },
    handler: async ({ vault_name }) => {
      checkNames(vault_name);
      const { items, truncated } = await collectPaged(`https://${vault_name}.vault.azure.net/secrets?api-version=${KEY_VAULT_API_VERSION}&maxresults=25`, KEY_VAULT_RESOURCE);
      const secrets = items.map((s) => {
        const attributes = isJsonObject(s.attributes) ? s.attributes : {};
        const id = typeof s.id === "string" ? s.id : "";
        return { name: id.split("/").pop() ?? null, id: s.id ?? null, enabled: attributes.enabled ?? null, created: attributes.created ?? null, updated: attributes.updated ?? null, expires: attributes.exp ?? null, content_type: s.contentType ?? null };
      });
      return formatResult({ vault_name, count: secrets.length, truncated, secrets });
    },
  });

  defineTool(server, {
    name: "Get_Key_Vault_Secret",
    title: "Get Key Vault Secret",
    description:
      "Get a secret's current value from a key vault. Returns the secret value - use only when the value itself is needed. A credential read, so it is gated like a write (write mode and confirm), the same as `az keyvault secret show`.",
    tier: "write",
    cli: "az keyvault secret show --vault-name <vault> -n <secret>",
    ref: { method: "GET", path: "https://{vault}.vault.azure.net/secrets/{name}", apiVersion: KEY_VAULT_API_VERSION },
    inputSchema: { vault_name: z.string().describe("Key vault name."), secret_name: z.string().describe("Secret name.") },
    handler: async ({ vault_name, secret_name }) => {
      checkNames(vault_name, secret_name);
      const result = await httpJson(new URL(`https://${vault_name}.vault.azure.net/secrets/${secret_name}?api-version=${KEY_VAULT_API_VERSION}`), KEY_VAULT_RESOURCE, "GET");
      if (!result.ok) throw new Error(`Get secret failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
      const secret = isJsonObject(result.body) ? result.body : {};
      const attributes = isJsonObject(secret.attributes) ? secret.attributes : {};
      return formatResult({ vault_name, secret_name, value: secret.value ?? null, content_type: secret.contentType ?? null, enabled: attributes.enabled ?? null, updated: attributes.updated ?? null });
    },
  });

  defineTool(server, {
    name: "Set_Key_Vault_Secret",
    title: "Set Key Vault Secret",
    description: "Create or update a secret in a key vault (a new version; earlier versions are kept). Requires data-plane write access.",
    tier: "write",
    cli: "az keyvault secret set --vault-name <vault> -n <secret> --value <value>",
    ref: { method: "PUT", path: "https://{vault}.vault.azure.net/secrets/{name}", apiVersion: KEY_VAULT_API_VERSION },
    inputSchema: {
      vault_name: z.string().describe("Key vault name."),
      secret_name: z.string().describe("Secret name."),
      value: z.string().describe("Secret value to store."),
      content_type: z.string().optional().describe("Optional content type label."),
    },
    handler: async ({ vault_name, secret_name, value, content_type }) => {
      checkNames(vault_name, secret_name);
      const requestBody: JsonObject = { value };
      if (content_type) requestBody.contentType = content_type;
      const result = await httpJson(new URL(`https://${vault_name}.vault.azure.net/secrets/${secret_name}?api-version=${KEY_VAULT_API_VERSION}`), KEY_VAULT_RESOURCE, "PUT", requestBody);
      if (!result.ok) throw new Error(`Set secret failed: ${result.status} ${result.statusText}: ${JSON.stringify(result.body)}`);
      return formatResult({ ok: true, vault_name, secret_name, updated: dig(result.body, "attributes", "updated") });
    },
  });
}

// Microsoft's Azure MCP Server, one-to-one.
//
// Every tool of the pinned @azure/mcp is registered here under its own name, schema and description, so
// this server is a superset of `azmcp server start`. Calls are forwarded to a per-profile azmcp process
// (src/upstream/runner.ts). Two things are added on the way through, and nothing else is changed:
//
//   profile   an optional argument on every tool: which tenant profile the call runs as
//   the gate  each call is classified from Microsoft's own per-command annotations (the "all" listing in the
//             catalog) and must pass this server's gate: read freely; write needs AZURE_MODE=write;
//             destructiveHint needs AZURE_ALLOW_DESTRUCTIVE=true too. Credential reads (Key Vault secrets,
//             keys, connection strings) count as writes, as they do for this server's own tools.
//
// AZURE_MCP_TOOL_MODE picks Microsoft's tool layout: "namespace" (its default, one router tool per
// service, the tool takes { intent, command, parameters, learn }) or "all" (every command as a tool).

import type { McpServer, StandardSchemaWithJSON, ToolCallback } from "@modelcontextprotocol/server";
import { requireTier, type Tier } from "../gate.js";
import { PROFILE_PARAM_DESCRIPTION, resolveProfile } from "../profiles.js";
import catalog from "./generated/catalog.json" with { type: "json" };
import { upstreamToOwn } from "./overlap.js";
import { callUpstream, setUpstreamHooks, upstreamEnabled, upstreamMode, UPSTREAM_VERSION } from "./runner.js";

type CatalogTool = { name: string; title: string | null; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> };

const ALL = catalog.all as CatalogTool[];
const NAMESPACE = catalog.namespace as CatalogTool[];

/**
 * Commands whose read returns a credential or data that usually holds one. Microsoft marks these read-only;
 * this server gates them as writes, the same way src/cli-policy.ts treats their `az` equivalents. The name is
 * split on _ and - and every word is checked, so a new command with one of these words is caught too.
 */
const SENSITIVE_WORDS = new Set([
  "secret", "secrets", "key", "keys", "credential", "credentials", "password", "passwords", "token", "tokens", "sas",
  "connectionstring", "connectionstrings", "appsettings", "kubeconfig", "publishprofile",
]);
/** Whole command names (or prefixes) that read secrets without a telling word. */
const SENSITIVE_COMMANDS = [
  /^appconfig_kv_get$/, // App Configuration key-values hold connection strings and Key Vault references
  /download-url$/, // short-lived bearer URLs; Microsoft's own description says to treat them as secrets
  /_file_download$/, // raw file content from hosted agent sessions
  /connection[-_]?strings?/,
];

export function isSensitiveCommand(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_COMMANDS.some((re) => re.test(lower))) return true;
  return lower.split(/[_-]/).some((word) => SENSITIVE_WORDS.has(word));
}

function tierOf(annotations: Record<string, unknown> | undefined, name: string): Tier {
  if (!annotations) return "write";
  if (annotations.destructiveHint === true) return "destructive";
  if (annotations.readOnlyHint === true) return isSensitiveCommand(name) ? "write" : "read";
  return "write";
}

const COMMAND_TIERS = new Map<string, Tier>(ALL.map((t) => [t.name, tierOf(t.annotations, t.name)]));

/** The catalog for the services view: each Microsoft service with its commands and their tiers. */
/**
 * Services backed by one of Microsoft's remote MCP servers name their commands after that server, not the
 * service: dashboards (Azure Monitor dashboards with Grafana) answers with amgmcp_*, documentation with
 * microsoft_*. test/upstream.test.mjs fails when a catalog sync brings a command no service owns.
 */
const REMOTE_PREFIXES: Record<string, string[]> = {
  dashboards: ["amgmcp_"],
  documentation: ["microsoft_docs_", "microsoft_code_sample_"],
  azd: ["error_troubleshooting", "provision_common_error", "validate_azure_yaml"],
};

/** Which namespace router owns a command: the longest namespace prefix (foundryextensions before foundry), else a remote alias. */
export function serviceOf(command: string, names = NAMESPACE.map((t) => t.name).sort((a, b) => b.length - a.length)): string | undefined {
  return (
    names.find((n) => command === n || command.startsWith(`${n}_`)) ??
    Object.entries(REMOTE_PREFIXES).find(([service, prefixes]) => names.includes(service) && prefixes.some((p) => command.startsWith(p)))?.[0]
  );
}

export type ServiceCommand = { name: string; title: string; tier: Tier; own: string[] };

export function upstreamServices(): { name: string; title: string; summary: string; commands: ServiceCommand[] }[] {
  const names = NAMESPACE.map((t) => t.name).sort((a, b) => b.length - a.length);
  const own = upstreamToOwn();
  const byService = new Map<string, ServiceCommand[]>();
  for (const command of ALL) {
    const owner = serviceOf(command.name, names);
    if (!owner) continue;
    const list = byService.get(owner) ?? [];
    list.push({ name: command.name, title: command.title ?? command.name, tier: tierOf(command.annotations, command.name), own: own.get(command.name) ?? [] });
    byService.set(owner, list);
  }
  return NAMESPACE.map((t) => ({
    name: t.name,
    title: t.title ?? t.name,
    summary: (/^(.*?[.!?])(\s|$)/s.exec(t.description.trim())?.[1] ?? t.description).replace(/\s+/g, " ").slice(0, 240),
    commands: byService.get(t.name) ?? [],
  }));
}

/** One command from the pinned catalog: what the services view needs to draw its form. */
export function upstreamCommand(name: string): { name: string; title: string; description: string; tier: Tier; own: string[]; inputSchema: Record<string, unknown> } | undefined {
  const tool = ALL.find((t) => t.name === name.trim().toLowerCase());
  if (!tool) return undefined;
  return {
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description,
    tier: tierOf(tool.annotations, tool.name),
    own: upstreamToOwn().get(tool.name) ?? [],
    inputSchema: tool.inputSchema,
  };
}

/** Every Microsoft command name in the pinned catalog, for checks. */
export function upstreamCommandNames(): Set<string> {
  return new Set(ALL.map((t) => t.name));
}

/** A command's tier as this server gates it, or undefined when it is not in the catalog. */
export function upstreamCommandTier(name: string): Tier | undefined {
  return COMMAND_TIERS.get(name);
}

export function upstreamTools(): CatalogTool[] {
  return upstreamMode() === "all" ? ALL : NAMESPACE;
}

/** How a call is gated: the tool's own annotations in "all" mode, the routed command's in "namespace" mode. */
export function classifyUpstreamCall(tool: CatalogTool, args: Record<string, unknown>): Tier {
  if (upstreamMode() === "all") return tierOf(tool.annotations, tool.name);
  // learn lists the commands and runs nothing; a command passed alongside learn is classified anyway.
  if (args.command === undefined || args.command === null || args.command === "") return "read";
  if (typeof args.command !== "string") return "write";
  const command = args.command.trim().toLowerCase();
  // Unknown commands (a proxied remote tool that was not in the catalog snapshot) are treated as writes,
  // and a sensitive word wins even then.
  const tier = COMMAND_TIERS.get(command) ?? COMMAND_TIERS.get(`${tool.name}_${command}`) ?? "write";
  return tier === "read" && isSensitiveCommand(command) ? "write" : tier;
}

/** A JSON Schema the SDK can advertise as-is; azmcp validates the arguments itself. */
function passthroughSchema(schema: Record<string, unknown>): StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>> {
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}), profile: { type: "string", maxLength: 100, description: PROFILE_PARAM_DESCRIPTION } };
  const advertised = { ...schema, type: "object", properties };
  return {
    "~standard": {
      version: 1,
      vendor: "azure-mcp-upstream",
      validate: (value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? { value: value as Record<string, unknown> }
          : { issues: [{ message: "Arguments must be an object." }] },
      jsonSchema: { input: () => advertised, output: () => advertised },
    },
  };
}

function uniqueTitle(tool: CatalogTool, taken: Set<string>): string {
  const base = (tool.title ?? tool.name.replace(/_/g, " ")).trim();
  const titled = base.charAt(0).toUpperCase() + base.slice(1);
  let title = taken.has(titled) ? `${titled} (Microsoft ${tool.name.replace(/_/g, " ")})` : titled;
  for (let n = 2; taken.has(title); n += 1) title = `${titled} ${n}`;
  taken.add(title);
  return title;
}

const TIMEOUT_MS = 10 * 60_000;

export function registerUpstreamTools(server: McpServer, ownTitles: Set<string>): number {
  if (!upstreamEnabled()) return 0;

  // azmcp asks before high-risk commands (revealing a secret). Pass its question to the user when the host
  // supports elicitation; otherwise azmcp is told the client cannot ask and follows its own policy.
  setUpstreamHooks({
    capabilities: () => (server.server.getClientCapabilities()?.elicitation ? { elicitation: {} } : {}),
    onRequest: (method, params) => {
      if (method === "elicitation/create" && server.server.getClientCapabilities()?.elicitation) {
        return server.server.elicitInput(params as Parameters<typeof server.server.elicitInput>[0]);
      }
      return Promise.reject(new Error(`${method} is not supported by this client`));
    },
  });

  const taken = new Set(ownTitles);
  const tools = upstreamTools();
  for (const tool of tools) {
    const title = uniqueTitle(tool, taken);
    const inputSchema = passthroughSchema(tool.inputSchema);
    const callback = (async (args: Record<string, unknown>) => {
      const { profile: profileRef, ...rest } = args;
      requireTier(tool.name, classifyUpstreamCall(tool, rest), "Microsoft marks this command destructive");
      const profile = resolveProfile(typeof profileRef === "string" ? profileRef : undefined);
      const result = await callUpstream(profile, tool.name, rest, TIMEOUT_MS);
      return {
        ...result,
        content: Array.isArray(result.content) ? result.content : [{ type: "text", text: JSON.stringify(result) }],
      };
    }) as unknown as ToolCallback<typeof inputSchema>;
    const upstreamAnnotations = tool.annotations ?? {};
    server.registerTool(
      tool.name,
      {
        title,
        description: `${tool.description}\n\n(Microsoft Azure MCP Server ${UPSTREAM_VERSION}, proxied. Optional \`profile\` picks the tenant.)`,
        inputSchema,
        annotations: {
          title,
          readOnlyHint: upstreamAnnotations.readOnlyHint === true && !isSensitiveCommand(tool.name),
          destructiveHint: upstreamAnnotations.destructiveHint === true,
          idempotentHint: upstreamAnnotations.idempotentHint === true,
          openWorldHint: true,
        },
      },
      callback,
    );
  }
  return tools.length;
}

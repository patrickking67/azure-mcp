// Builds the Azure MCP server: every tool, view and resource. Shared by the stdio entry point
// (index.ts, for the .mcpb and CLI clients) and the remote one (remote.ts, one server per request),
// so the two surfaces cannot drift. Nothing here reads credentials, so building never fails.

import { McpServer } from "@modelcontextprotocol/server";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppViews } from "./apps/index.js";
import { authMode } from "./auth.js";
import { ARM_BASE, textOf } from "./client.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { registerCliTools } from "./tools/cli.js";
import { registerComputeTools } from "./tools/compute.js";
import { registerCoreTools } from "./tools/core.js";
import { apiReference } from "./tools/define.js";
import { registerGovernanceTools } from "./tools/governance.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerKeyVaultTools } from "./tools/keyvault.js";
import { registerListTools } from "./tools/lists.js";
import { registerMonitorTools } from "./tools/monitor.js";
import { registerScopedTools } from "./tools/scoped.js";
import { OWN_TO_UPSTREAM } from "./upstream/overlap.js";
import { registerUpstreamTools, upstreamCommandTier } from "./upstream/register.js";
import { UPSTREAM_VERSION } from "./upstream/runner.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const LOGO_FILE = "azure-512.png";
const LOGO_MIME_TYPE = "image/png";
const LOGO_URI = "azure://assets/logo.png";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const logoPath = join(moduleDir, "..", "assets", LOGO_FILE);
const logoBase64 = existsSync(logoPath) ? readFileSync(logoPath).toString("base64") : undefined;

export type ServerOptions = {
  /** Proxy Microsoft's Azure MCP Server tools (stdio only: they run as the local tenant profiles). */
  upstream?: boolean;
};

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_NAME,
      version: SERVER_VERSION,
      icons: logoBase64 ? [{ src: `data:${LOGO_MIME_TYPE};base64,${logoBase64}`, mimeType: LOGO_MIME_TYPE, sizes: ["512x512"] }] : [],
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerCoreTools(server);
  registerListTools(server);
  registerComputeTools(server);
  registerGovernanceTools(server);
  registerScopedTools(server);
  registerKeyVaultTools(server);
  registerGraphTools(server);
  registerMonitorTools(server);
  registerCliTools(server);
  registerAppViews(server);
  if (options.upstream) {
    const own = new Set<string>();
    // The SDK keeps registered tools in a private map; titles are only needed for de-duplication.
    for (const tool of Object.values((server as unknown as { _registeredTools: Record<string, { title?: string }> })._registeredTools ?? {})) if (tool.title) own.add(tool.title);
    registerUpstreamTools(server, own);
  }

  if (logoBase64) {
    server.registerResource(
      "azure_logo",
      LOGO_URI,
      { title: "Azure Logo", description: "Microsoft Azure logo packaged with the MCP server.", mimeType: LOGO_MIME_TYPE },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: LOGO_MIME_TYPE, blob: logoBase64 }] }),
    );
  }

  server.registerResource(
    "api_reference",
    "azure://reference/api",
    { title: "Azure API Reference", description: "Every tool with its tier, HTTP method, path template, api-version and Azure CLI equivalent.", mimeType: "application/json" },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              server: SERVER_NAME,
              version: SERVER_VERSION,
              auth_mode: authMode(),
              arm_base: ARM_BASE,
              microsoft_azure_mcp: UPSTREAM_VERSION,
              // Each own tool with the Microsoft command that does the same job and the tier it is gated at here.
              tools: apiReference().map((entry) => {
                const commands = OWN_TO_UPSTREAM[textOf(entry.tool)] ?? [];
                return commands.length ? { ...entry, microsoft: commands.map((name) => ({ command: name, tier: upstreamCommandTier(name) ?? null })) } : entry;
              }),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

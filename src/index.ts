#!/usr/bin/env node
// stdio entry point: the .mcpb bundle, Claude Code, Codex and any local MCP client.

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { AZ_LABEL } from "./az.js";
import { BASE_AUTH_MODE } from "./auth.js";
import { ArmApiError } from "./client.js";
import { isDestructiveAllowed, isWriteMode } from "./gate.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  const auth = BASE_AUTH_MODE === "azure_cli" ? `azure cli via ${AZ_LABEL}` : BASE_AUTH_MODE.replace("_", " ");
  const gate = isWriteMode() ? (isDestructiveAllowed() ? "write+destructive" : "write") : "read";
  // stdout belongs to the protocol; diagnostics go to stderr.
  console.error(`Azure MCP server running on stdio (auth: ${auth}, mode: ${gate})`);
}

main().catch((error: unknown) => {
  const details =
    error instanceof ArmApiError
      ? { message: error.message, status: error.status, statusText: error.statusText, details: error.details }
      : { message: error instanceof Error ? error.message : String(error) };
  console.error(JSON.stringify(details, null, 2));
  process.exit(1);
});

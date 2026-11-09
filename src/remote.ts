#!/usr/bin/env node
// Remote entry point: Streamable HTTP on Node (an Azure Container App), protected by Microsoft Entra ID.
// The auth design lives in ./entra.ts; how Azure tokens are obtained per caller lives in ./auth.ts.
//
//   - Stateless: a fresh McpServer and transport per request, so any replica serves any call.
//   - Every tool call runs inside withCaller(), so on-behalf-of tokens are the caller's own and the
//     write gate can ask for the caller's Entra role.
//   - Logs carry the caller's object id and the tool name, never arguments or tokens.
//
// Env: ENTRA_TENANT_ID, ENTRA_CLIENT_ID, PUBLIC_URL (https://host, no path), PORT (8080), MCP_PATH (/mcp),
//      AZURE_REMOTE_IDENTITY (on_behalf_of | managed_identity), MANAGED_IDENTITY_CLIENT_ID,
//      ENTRA_CLIENT_SECRET (optional; otherwise the managed identity is the app's federated credential),
//      AZURE_MODE, AZURE_ALLOW_DESTRUCTIVE.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BASE_AUTH_MODE, currentCaller, oboEnabled, withCaller } from "./auth.js";
import { auditLines, authenticate, callerReadRefusal, callerTierRefusal, challengeHeader, entraConfig, forbiddenHeader, protectedResourceMetadata } from "./entra.js";
import { envValue } from "./env.js";
import { isDestructiveAllowed, isWriteMode, setCallerTierCheck } from "./gate.js";
import { createServer } from "./server.js";
import { SERVER_VERSION } from "./version.js";

const entra = entraConfig(envValue);
const port = Number(envValue("PORT") ?? 8080);

setCallerTierCheck((tier) => callerTierRefusal(currentCaller(), tier));

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && path === "/healthz") {
      return send(res, 200, { ok: true, version: SERVER_VERSION, identity: oboEnabled() ? "on_behalf_of" : BASE_AUTH_MODE, mode: isWriteMode() ? (isDestructiveAllowed() ? "write+destructive" : "write") : "read" });
    }
    if (req.method === "GET" && path === "/") {
      return send(res, 200, { name: "Azure MCP", version: SERVER_VERSION, mcp: entra.resource, metadata: entra.metadataUrl });
    }
    if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${entra.mcpPath}`)) {
      return send(res, 200, protectedResourceMetadata(entra), { "access-control-allow-origin": "*" });
    }
    if (path !== entra.mcpPath) return send(res, 404, { error: "not_found" });

    const caller = await authenticate(entra, req.headers.authorization);
    if (typeof caller === "string") {
      return send(res, 401, { error: "invalid_token", error_description: caller }, { "www-authenticate": challengeHeader(entra) });
    }
    const noRole = callerReadRefusal(caller);
    if (noRole) return send(res, 403, { error: "insufficient_scope", error_description: noRole }, { "www-authenticate": forbiddenHeader(noRole) });
    // Stateless JSON mode has no server-initiated stream to GET and no session to DELETE.
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (error) {
      const tooBig = error instanceof Error && /too large/i.test(error.message);
      return send(res, tooBig ? 413 : 400, { error: tooBig ? "request_too_large" : "invalid_json" });
    }
    for (const line of auditLines(caller, body)) console.error(line);
    await withCaller(caller, async () => {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });
  } catch (error) {
    console.error("request failed:", error instanceof Error ? error.message : error);
    if (!res.headersSent) send(res, 500, { error: "internal_error" });
  }
}

// node:http ignores the handler's return value, so a rejection that escapes the handler's own catch
// is logged and the socket closed here instead of becoming an unhandled rejection.
const http = createHttpServer((req, res) => {
  handleRequest(req, res).catch((error: unknown) => {
    console.error("request failed:", error instanceof Error ? error.message : error);
    res.destroy();
  });
});

http.listen(port, () => {
  const address = http.address();
  console.error(
    `Azure MCP (remote) listening on :${typeof address === "object" && address ? address.port : port} ` +
      `(identity: ${oboEnabled() ? "on behalf of each caller" : BASE_AUTH_MODE}, mode: ${isWriteMode() ? "write" : "read"})`,
  );
});

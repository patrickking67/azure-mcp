// Runs Microsoft's Azure MCP Server (azmcp, from the bundled @azure/mcp package), one process per tenant
// profile, started on the first call that needs it.
//
// azmcp authenticates with Azure.Identity, which reads its identity from the environment. Each child gets
// only its own profile's identity:
//
//   service principal  AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET, AZURE_TOKEN_CREDENTIALS=EnvironmentCredential
//   cli                AZURE_TOKEN_CREDENTIALS=AzureCliCredential (the user's own az login), az's folder on PATH
//
// Every other profile's settings are removed from the child's environment, telemetry is off, and in read
// mode azmcp runs with its own --read-only flag as a second lock behind this server's gate.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { AZ } from "../az.js";
import { envValue } from "../env.js";
import { isWriteMode } from "../gate.js";
import type { Profile } from "../profiles.js";
import { SERVER_VERSION } from "../version.js";
import { StdioRpcClient } from "./rpc.js";
import catalog from "./generated/catalog.json" with { type: "json" };

export const UPSTREAM_VERSION: string = catalog.version;

export type UpstreamMode = "namespace" | "all";

export function upstreamMode(): UpstreamMode {
  return (envValue("AZURE_MCP_TOOL_MODE") ?? "namespace").toLowerCase() === "all" ? "all" : "namespace";
}

export function upstreamEnabled(): boolean {
  return (envValue("AZURE_MCP_UPSTREAM") ?? "true").toLowerCase() !== "false";
}

type Launch = { command: string; args: string[]; source: string };

function resolveLaunch(): Launch {
  const configured = envValue("AZMCP_PATH");
  if (configured && existsSync(configured)) return { command: configured, args: [], source: "AZMCP_PATH" };
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const exe = process.platform === "win32" ? "azmcp.exe" : "azmcp";
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`@azure/mcp-${platform}-${process.arch}/package.json`);
    const binary = join(dirname(pkg), "dist", exe);
    if (existsSync(binary)) return { command: binary, args: [], source: "bundled" };
  } catch {
    // Not installed next to this server (the single-file plugin bundle): fall through to npx.
  }
  return { command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["-y", `@azure/mcp@${UPSTREAM_VERSION}`], source: "npx" };
}

const LAUNCH = resolveLaunch();

/** Our own settings that must never reach a child: other profiles' secrets and the slot variables. */
function isOwnSetting(name: string): boolean {
  return /^AZURE_(PROFILE_|TENANT_PROFILES$|CLIENT_SECRET$|CLIENT_ID$|TENANT_ID$|CLI_TENANT_ID$|DEFAULT_PROFILE$|PROFILE_NAME$)/.test(name);
}

function childEnv(profile: Profile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!isOwnSetting(name) && value !== undefined && !value.includes("${")) env[name] = value;
  env.AZURE_MCP_COLLECT_TELEMETRY = "false";
  // Desktop apps launch with a short PATH; azmcp's AzureCliCredential needs to find az.
  const azDir = AZ.command.includes("/") || AZ.command.includes("\\") ? dirname(AZ.command) : undefined;
  const extra = [azDir, "/opt/homebrew/bin", "/usr/local/bin"].filter((d): d is string => Boolean(d && existsSync(d)));
  env.PATH = [...extra, env.PATH ?? ""].filter(Boolean).join(delimiter);
  if (profile.kind === "service_principal") {
    env.AZURE_TENANT_ID = profile.tenantId;
    env.AZURE_CLIENT_ID = profile.clientId;
    env.AZURE_CLIENT_SECRET = profile.clientSecret;
    env.AZURE_TOKEN_CREDENTIALS = "EnvironmentCredential";
  } else {
    if (profile.tenantId) env.AZURE_TENANT_ID = profile.tenantId;
    env.AZURE_TOKEN_CREDENTIALS = "AzureCliCredential";
  }
  if (profile.subscriptionId) env.AZURE_SUBSCRIPTION_ID = profile.subscriptionId;
  else delete env.AZURE_SUBSCRIPTION_ID;
  return env;
}

function launchArgs(): string[] {
  const args = [...LAUNCH.args, "server", "start", "--mode", upstreamMode()];
  if (!isWriteMode()) args.push("--read-only");
  const cloud = envValue("AZURE_CLOUD");
  if (cloud) args.push("--cloud", cloud);
  return args;
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
type Hooks = { onRequest?: RequestHandler; capabilities?: () => Record<string, unknown> };
let hooks: Hooks = {};

/** The proxy installs how azmcp's own requests (elicitation) reach the user, and what to advertise. */
export function setUpstreamHooks(next: Hooks): void {
  hooks = next;
}

const children = new Map<string, Promise<StdioRpcClient>>();
const started = new Map<string, string>();

function child(profile: Profile): Promise<StdioRpcClient> {
  const existing = children.get(profile.name);
  if (existing) return existing;
  const starting = (async () => {
    const client = new StdioRpcClient(LAUNCH.command, launchArgs(), childEnv(profile));
    client.onRequest = (method, params) => (hooks.onRequest ? hooks.onRequest(method, params) : Promise.reject(new Error(`${method} is not supported`)));
    try {
      await client.initialize("Azure (proxy)", SERVER_VERSION, hooks.capabilities?.() ?? {});
    } catch (error) {
      client.close();
      throw error;
    }
    started.set(profile.name, new Date().toISOString());
    return client;
  })();
  children.set(profile.name, starting);
  starting.catch(() => children.delete(profile.name));
  return starting;
}

export type UpstreamResult = { content?: unknown[]; structuredContent?: unknown; isError?: boolean; [key: string]: unknown };

/** Call one of Microsoft's tools as `profile`. A dead child is restarted once. */
export async function callUpstream(profile: Profile, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<UpstreamResult> {
  for (let attempt = 0; ; attempt += 1) {
    const client = await child(profile);
    if (client.exited) {
      children.delete(profile.name);
      if (attempt === 0) continue;
    }
    try {
      return await client.request<UpstreamResult>("tools/call", { name, arguments: args }, timeoutMs);
    } catch (error) {
      if (client.exited && attempt === 0) {
        children.delete(profile.name);
        continue;
      }
      throw error;
    }
  }
}

export function upstreamStatus(): Record<string, unknown> {
  return {
    enabled: upstreamEnabled(),
    package: `@azure/mcp@${UPSTREAM_VERSION}`,
    launch: LAUNCH.source,
    command: LAUNCH.command,
    tool_mode: upstreamMode(),
    read_only_flag: !isWriteMode(),
    running_profiles: Object.fromEntries(started),
  };
}

function shutdown(): void {
  for (const pending of children.values()) void pending.then((c) => c.close(), () => undefined);
  children.clear();
}
process.once("exit", shutdown);
process.once("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.once("SIGINT", () => {
  shutdown();
  process.exit(0);
});

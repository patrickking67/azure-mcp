// The Azure CLI, one-to-one. Every `az` command group and verb is reachable, classified by
// src/cli-policy.ts before it runs:
//
//   Az_CLI       reads only (list, show, get-*, ...). No gate, so it is safe to call freely.
//   Az_CLI_Run   any allowed command. Writes need AZURE_MODE=write; deletes, stops, restarts and
//                other disruptive verbs also need AZURE_ALLOW_DESTRUCTIVE=true; both need confirm.
//   Az_CLI_Help  `az <group> [<command>] --help`, to discover arguments before running anything.
//
// The CLI runs under the same identity as every other tool: the user's `az login` locally, or an
// isolated CLI profile signed in as the configured service principal or managed identity. It cannot
// act as an on-behalf-of remote caller, so in that mode these tools refuse rather than run as the
// server.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AZ_LABEL, azRun, useIsolatedCliConfig } from "../az.js";
import { authMode, BASE_AUTH_MODE, CLIENT_ID, MANAGED_IDENTITY_CLIENT_ID, servicePrincipalSecret, TENANT_ID } from "../auth.js";
import { classify, hasFlag, splitCommand, type Classification } from "../cli-policy.js";
import { formatResult, type JsonValue } from "../client.js";
import { envValue } from "../env.js";
import { defineTool } from "./define.js";

const MAX_TEXT = 200_000;

let session: Promise<void> | undefined;

/** Sign the CLI in as the server's own identity, once, in a profile that is not the user's ~/.azure. */
function ensureCliSession(): Promise<void> {
  if (authMode() === "on_behalf_of") {
    return Promise.reject(
      new Error(
        "The Azure CLI tools cannot act as a remote on-behalf-of caller: the CLI only signs in as one identity. Use the dedicated tools or ARM_GET/ARM_Request, " +
          "which run with your own permissions, or deploy with AZURE_REMOTE_IDENTITY=managed_identity to run the CLI as the server's identity.",
      ),
    );
  }
  if (BASE_AUTH_MODE === "azure_cli") return Promise.resolve();
  session ??= (async () => {
    useIsolatedCliConfig();
    const args =
      BASE_AUTH_MODE === "managed_identity"
        ? ["login", "--identity", ...(MANAGED_IDENTITY_CLIENT_ID ? ["--client-id", MANAGED_IDENTITY_CLIENT_ID] : []), "--allow-no-subscriptions", "--output", "none"]
        : ["login", "--service-principal", "--username", CLIENT_ID ?? "", `--password=${servicePrincipalSecret() ?? ""}`, "--tenant", TENANT_ID ?? "", "--allow-no-subscriptions", "--output", "none"];
    const login = await azRun(args, { timeoutMs: 90_000 });
    if (login.exitCode !== 0) {
      session = undefined;
      throw new Error(`Signing the Azure CLI in as the ${BASE_AUTH_MODE.replace("_", " ")} failed: ${login.stderr.trim() || `exit ${login.exitCode}`}`);
    }
    const sub = envValue("AZURE_SUBSCRIPTION_ID");
    if (sub) await azRun(["account", "set", "--subscription", sub]);
  })();
  return session;
}

const commandInput = {
  args: z
    .array(z.string())
    .optional()
    .describe('The words after "az", one per element, e.g. ["vm", "list", "-g", "my-rg"]. Preferred over command: no quoting needed.'),
  command: z
    .string()
    .optional()
    .describe('The same as one string, e.g. "vm list -g my-rg --query \\"[].name\\"". A leading "az" is ignored. Quotes group words; nothing is expanded.'),
  subscription_id: z.string().optional().describe("Adds --subscription <id> when the command does not already carry one. Leave unset for commands without that argument (az ad ...)."),
  timeout_seconds: z.number().int().min(5).max(900).optional().describe("Kill the command after this many seconds. Default 120. Prefer --no-wait for long-running operations."),
};

type CommandArgs = { args?: string[]; command?: string; subscription_id?: string; timeout_seconds?: number };

function argvOf(input: CommandArgs): string[] {
  if (input.args && input.args.length > 0) return input.args[0] === "az" ? input.args.slice(1) : [...input.args];
  if (input.command) return splitCommand(input.command);
  throw new Error('Pass args (["vm", "list"]) or command ("vm list").');
}

async function execute(tool: string, input: CommandArgs, check: (c: Classification) => void) {
  const argv = argvOf(input);
  const classification = classify(argv);
  if (classification.blocked) throw new Error(`${tool} refused: ${classification.blocked}. Nothing was run.`);
  check(classification);
  await ensureCliSession();
  const full = [...argv];
  if (input.subscription_id && !hasFlag(full, ["--subscription"])) full.push("--subscription", input.subscription_id);
  if (!hasFlag(full, ["--output", "-o"])) full.push("--output", "json");
  const run = await azRun(full, { timeoutMs: (input.timeout_seconds ?? 120) * 1000 });
  let output: JsonValue = run.stdout;
  const trimmed = run.stdout.trim();
  if (trimmed && /^[[{"]|^(true|false|null|-?\d)/.test(trimmed)) {
    try {
      output = JSON.parse(trimmed) as JsonValue;
    } catch {
      output = trimmed;
    }
  }
  if (typeof output === "string" && output.length > MAX_TEXT) output = `${output.slice(0, MAX_TEXT)}\n… (truncated)`;
  const stderr = run.stderr.trim();
  const body = {
    command: `az ${argv.join(" ")}`,
    tier: classification.tier,
    sensitive: classification.sensitive,
    exit_code: run.exitCode,
    timed_out: run.timedOut,
    output_truncated: run.truncated,
    output,
    stderr: stderr ? stderr.slice(-4000) : null,
  };
  const result = formatResult(body as JsonValue);
  if (run.exitCode !== 0 || run.timedOut) return { ...result, isError: true };
  return result;
}

export function registerCliTools(server: McpServer): void {
  defineTool(server, {
    name: "Az_CLI",
    title: "Azure CLI (Read)",
    description:
      "Run any read-only Azure CLI command: every `az ... list`, `show`, `get-*`, `check-*`, and `az rest --method get` against an Azure endpoint. " +
      "This is the whole CLI surface for reads, one-to-one with `az`; use it for anything the dedicated tools do not cover. Output is JSON unless you pass -o. " +
      "Commands that change something, or that return keys, connection strings or secrets, are refused here and run through Az_CLI_Run instead. Use Az_CLI_Help to look up arguments.",
    tier: "read",
    cli: "az <group> <command> [args]",
    inputSchema: commandInput,
    handler: async (input) =>
      execute("Az_CLI", input, (c) => {
        if (c.tier !== "read") {
          throw new Error(
            `Az_CLI only runs reads, and 'az ${c.path.join(" ")}' is ${c.sensitive ? "a read that returns credentials" : `a ${c.tier} command`}. Use Az_CLI_Run with confirm: true. Nothing was run.`,
          );
        }
      }),
  });

  defineTool(server, {
    name: "Az_CLI_Run",
    title: "Azure CLI (Run)",
    description:
      "Run any Azure CLI command, including creates, updates, deletes and commands that return credentials: one-to-one with `az`. " +
      "Each command is classified before it runs: writes need write mode; disruptive verbs (delete, purge, stop, deallocate, restart, regenerate, revoke, ...) also need the destructive gate. " +
      "Prompts cannot be answered, so pass --yes where the CLI asks for confirmation, and --no-wait for long operations. Arguments starting with '@' (local files) are refused.",
    tier: "destructive",
    // The annotation says destructive because it can be; the gate applied is the command's own tier.
    runtimeTier: (input) => {
      const c = classify(argvOf(input));
      if (c.blocked) throw new Error(`Az_CLI_Run refused: ${c.blocked}. Nothing was run.`);
      return c.tier;
    },
    impact: "the command deletes, stops, restarts or revokes something",
    cli: "az <group> <command> [args]",
    inputSchema: commandInput,
    handler: async (input) => execute("Az_CLI_Run", input, () => undefined),
  });

  defineTool(server, {
    name: "Az_CLI_Help",
    title: "Azure CLI Help",
    description: "Show `az <group> [<command>] --help`: the subgroups, commands, arguments and examples, straight from the installed CLI. Use it before Az_CLI or Az_CLI_Run when unsure of a command's arguments.",
    tier: "read",
    cli: "az <group> [<command>] --help",
    inputSchema: {
      command: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).max(6).describe('Command path, e.g. ["vm"] or ["network", "nsg", "rule", "create"]. Empty for the top-level groups.'),
    },
    handler: async ({ command }) => {
      await ensureCliSession().catch(() => undefined);
      const run = await azRun([...command, "--help"], { timeoutMs: 60_000 });
      const text = (run.stdout || run.stderr).trim();
      const body = { command: `az ${[...command, "--help"].join(" ")}`, cli: AZ_LABEL, help: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (truncated)` : text };
      return run.exitCode === 0 ? formatResult(body) : { ...formatResult(body), isError: true };
    },
  });
}

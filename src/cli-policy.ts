// What an `az` command is allowed to do, decided from its argv before anything runs.
//
// The Azure CLI tools expose the whole CLI surface one-to-one, so the gate cannot be a list of
// tools: it is a classification of the command. Each command lands in one tier:
//
//   read         list / show / get-* / check-* and friends. Runs through Az_CLI with no gate.
//   write        anything that creates or changes a resource, or writes a local file. Gate 1.
//   destructive  delete, stop, deallocate, restart, purge, regenerate, revoke, ... Gates 1 and 2.
//
// and two flags on top:
//
//   sensitive    a read that returns credentials (account keys, connection strings, publishing
//                profiles, kubeconfig, secret values). Treated as a write, so it never runs from the
//                ungated read tool and a key does not land in a transcript by accident.
//   blocked      never runs: commands that change the CLI itself or the user's sign-in (login,
//                account set, config, extension add, upgrade), print access tokens, open an
//                interactive session, or stream forever. They would act outside this server's
//                boundary, or hang it.
//
// Independent of tier, local files are out of reach: an argument starting with '@' (the CLI reads
// '@path' as "the contents of this file"), a '~' path, and flags that take a local path (--file,
// --template-file, --output-file, ...) are refused, so a prompt-injected command can neither upload a
// local file nor overwrite one. az rest is parsed strictly and may only reach Azure's own hosts.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Tier } from "./gate.js";

export type Classification = {
  path: string[];
  verb: string;
  tier: Tier;
  sensitive: boolean;
  blocked?: string;
};

const BLOCKED_PREFIXES: [string, string][] = [
  ["login", "changes the CLI sign-in"],
  ["logout", "changes the CLI sign-in"],
  ["account set", "changes the CLI default subscription for every later command; pass subscription_id instead"],
  ["account clear", "changes the CLI sign-in"],
  ["account get-access-token", "prints a bearer token"],
  ["config", "changes CLI configuration"],
  ["configure", "changes CLI configuration"],
  ["extension add", "installs code into the CLI"],
  ["extension remove", "changes the CLI installation"],
  ["extension update", "installs code into the CLI"],
  ["upgrade", "upgrades the CLI itself"],
  ["self-test", "is a CLI diagnostic"],
  ["interactive", "opens an interactive shell"],
  ["feedback", "opens a browser"],
  ["cache", "changes the CLI cache"],
  ["init", "is an interactive setup"],
  ["cloud set", "changes which cloud the CLI talks to"],
  ["cloud register", "changes which cloud the CLI talks to"],
  ["cloud unregister", "changes which cloud the CLI talks to"],
  ["cloud update", "changes which cloud the CLI talks to"],
  ["bicep install", "downloads a binary"],
  ["bicep upgrade", "downloads a binary"],
  ["bicep uninstall", "changes the CLI installation"],
  ["aks install-cli", "downloads binaries"],
  ["aks browse", "opens a browser"],
  ["acr login", "writes Docker credentials to this machine"],
  ["ssh", "opens an interactive session"],
  ["vm serial-console", "opens an interactive session"],
  ["webapp ssh", "opens an interactive session"],
  ["webapp create-remote-connection", "opens a tunnel"],
  ["webapp log tail", "streams forever"],
  ["functionapp log tail", "streams forever"],
  ["container exec", "opens an interactive session"],
  ["container attach", "opens an interactive session"],
  ["containerapp exec", "opens an interactive session"],
  ["network bastion ssh", "opens an interactive session"],
  ["network bastion rdp", "opens an interactive session"],
  ["network bastion tunnel", "opens a tunnel"],
];

const READ_VERBS = new Set(["list", "show", "exists", "query", "version", "wait", "list-locations", "show-details"]);
const READ_PREFIXES = ["list-", "show-", "get-", "check-"];

const DESTRUCTIVE_VERBS = new Set([
  "delete", "purge", "remove", "stop", "deallocate", "restart", "reboot", "reset", "revoke", "regenerate", "regenerate-key",
  "rotate", "reimage", "redeploy", "power-off", "failover", "detach", "cancel", "abort", "clear", "flush", "rollback", "swap",
  "uninstall", "kill", "terminate", "retire", "disconnect", "disable", "unlink", "wipe", "upgrade", "evict", "drain", "suspend",
  // Restart or reshape what runs: resize and update-instances restart VMs, generalize makes a VM unusable, scale can go to zero,
  // invoke runs arbitrary code on a machine or cluster.
  "resize", "generalize", "update-instances", "scale", "invoke",
]);
const DESTRUCTIVE_PREFIXES = ["delete-", "remove-", "stop-", "purge-", "deallocate-", "restart-", "reset-", "rotate-", "regenerate-", "revoke-", "force-", "manual-failover"];
// Command groups whose every command runs code on a machine.
const DESTRUCTIVE_GROUPS = new Set(["run-command"]);

// A read whose output is a credential when any path token matches this: account keys, shared keys, admin keys,
// secrets, credentials, connection strings, SAS tokens, passwords, app settings (which usually hold secrets).
const SENSITIVE_TOKEN = /(^|-)(keys?|secrets?|credentials?|connection-strings?|tokens?|sas|passwords?|appsettings|kubeconfig|publish(ing)?-profiles?)($|-)/;
const SENSITIVE_FLAGS = ["--show-values", "--show-secrets", "--show-keys"];
// Key Vault listings return names and metadata, never values, so they stay plain reads.
const NOT_SENSITIVE = /^keyvault (secret|key|certificate) (list|list-versions|list-deleted)$/;
// Credential reads whose names do not say so.
const SENSITIVE_PATHS = [/^iot (hub|dps) policy (list|show)/, /^spring app test-endpoint/, /^iot hub (device-identity|module-identity) connection-string/];

// Flags whose value is a path on this machine: a source the CLI reads and may upload, or a destination it writes.
// Refused outright so a prompt-injected command cannot ship ~/.azure or ~/.ssh to a storage account it names,
// or overwrite a local file. Content goes inline instead.
const LOCAL_PATH_FLAGS = [
  "--file", "-f", "--file-path", "--template-file", "--output-file", "--dest", "--destination", "--local-path", "--src",
  "--src-path", "--custom-data", "--download-path", "--target-path", "--key-file", "--cert-file", "--pem-file",
];

// Commands that upload the working directory without naming it.
const LOCAL_UPLOAD_COMMANDS: [string, string][] = [
  ["webapp up", "uploads the current directory"],
  ["containerapp up", "uploads the current directory"],
  ["staticwebapp deploy", "uploads a local directory"],
];

const ARM_ID = /^\/(subscriptions|providers|tenants)([/?]|$)/i;
const URL_FLAGS = ["--url", "--uri", "-u"];

/**
 * The first argument that names a local path: anything starting with '/', './', '../' or '~' other than
 * an ARM id or the root scope '/', '.' and '..' themselves, file: URLs, and any value containing '.' or '/'
 * that exists on disk. Other URLs are not paths. Relative paths the check cannot see still resolve inside
 * the empty sandbox directory the CLI runs in (az.ts cliSandboxDir), so they reach nothing.
 */
export function localPathArgument(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    // --flag=value, and a short flag with its value attached (-s/Users/x, argparse reads both).
    const value = raw.startsWith("--") ? (raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw) : raw.startsWith("-") && raw.length > 2 ? raw.slice(2).replace(/^=/, "") : raw;
    if (raw.startsWith("-") && value === raw) continue;
    if (raw.startsWith("-") && raw.length === 2) continue;
    if (/^file:/i.test(value)) return value;
    // az rest URIs are relative ARM paths, checked by the rest parser instead.
    if (URL_FLAGS.includes(args[i - 1] ?? "") || URL_FLAGS.some((f) => raw.startsWith(`${f}=`))) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
    if (value === "/" || ARM_ID.test(value)) continue;
    if (value === "." || value === ".." || /^(\/|\.\.?\/|~|\.\.?\\)/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return value;
    if (/[./\\]/.test(value) && value.length < 1024) {
      try {
        if (existsSync(resolve(value))) return value;
      } catch {
        // An unreadable path is not reachable either.
      }
    }
  }
  return undefined;
}

// az rest: the only flags accepted, each at most once, so what is classified is exactly what argparse will run.
const REST_FLAGS = new Map<string, string>([
  ["--method", "method"], ["-m", "method"], ["--url", "url"], ["--uri", "url"], ["-u", "url"], ["--body", "body"], ["-b", "body"],
  ["--headers", "headers"], ["--url-parameters", "url-parameters"], ["--query", "query"], ["--output", "output"], ["-o", "output"],
]);
// Exact hosts only. A suffix such as .azure.com would include DNS labels customers control (cloudapp.azure.com).
const REST_HOSTS = [/^management\.azure\.com$/, /^graph\.microsoft\.com$/, /^api\.loganalytics\.io$/, /^[a-z0-9-]{3,24}\.vault\.azure\.net$/];

export function commandPath(args: string[]): string[] {
  const path: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    path.push(arg);
  }
  return path;
}

export function hasFlag(args: string[], names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function verbTier(verb: string): Tier {
  if (READ_VERBS.has(verb) || READ_PREFIXES.some((p) => verb.startsWith(p))) return "read";
  if (DESTRUCTIVE_VERBS.has(verb) || DESTRUCTIVE_PREFIXES.some((p) => verb.startsWith(p))) return "destructive";
  return "write";
}

/** Parse `az rest` strictly: known flags, each once, values separate or after '='. Returns a refusal string on anything else. */
function parseRest(args: string[]): Record<string, string> | string {
  const seen: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("-")) return `unexpected argument '${arg}'; pass every value right after its flag`;
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const key = REST_FLAGS.get(name);
    if (!key) return `az rest flag '${name}' is not allowed here (use --method, --url, --body, --headers, --url-parameters, --query, --output)`;
    if (key in seen) return `az rest flag ${name} is given twice`;
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined) return `az rest flag ${name} needs a value`;
    seen[key] = value;
  }
  return seen;
}

export function classify(args: string[]): Classification {
  const path = commandPath(args);
  const verb = path.at(-1) ?? "";
  const joined = path.join(" ");
  const flags = args.slice(path.length);
  const result = (tier: Tier, sensitive = false, blocked?: string): Classification => ({ path, verb, tier, sensitive, ...(blocked ? { blocked } : {}) });

  if (path.length === 0) return result("read", false, "no command given; pass the words after 'az', e.g. [\"vm\", \"list\"]");
  for (const [prefix, reason] of BLOCKED_PREFIXES) {
    if (joined === prefix || joined.startsWith(`${prefix} `)) return result("write", false, `'az ${prefix}' ${reason}`);
  }
  for (const arg of args) {
    if (arg.startsWith("@") || /=@/.test(arg)) return result("write", false, `argument '${arg}' would make the CLI read a local file; pass the content inline instead`);
    if (arg.startsWith("~")) return result("write", false, `argument '${arg}' is a path in the home directory; local files are not reachable from these tools`);
  }
  if (hasFlag(flags, ["--debug"])) return result("write", false, "--debug can print request details; use --verbose");
  const local = localPathArgument(args);
  if (local) return result("write", false, `argument '${local}' is a path on this machine; local files are not reachable from these tools (pass content inline, or use a URL)`);
  for (const [prefix, reason] of LOCAL_UPLOAD_COMMANDS) {
    if (joined === prefix || joined.startsWith(`${prefix} `)) return result("write", false, `'az ${prefix}' ${reason}`);
  }
  // argparse also accepts a short flag with its value attached (-fmain.bicep).
  const pathFlag = LOCAL_PATH_FLAGS.find((name) => hasFlag(flags, [name]) || (!name.startsWith("--") && flags.some((a) => a.startsWith(name) && !a.startsWith("--"))));
  if (pathFlag) return result("write", false, `${pathFlag} reads or writes a file on this machine; pass content inline, or use a URL or template spec instead`);

  if (path[0] === "rest" && path.length === 1) {
    const rest = parseRest(args);
    if (typeof rest === "string") return result("read", false, rest);
    const url = rest.url;
    if (!url) return result("read", false, "az rest needs --url");
    if (!url.startsWith("/") || url.startsWith("//")) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return result("read", false, `az rest --url '${url}' is not a URL`);
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !REST_HOSTS.some((re) => re.test(parsed.hostname))) {
        return result("read", false, `az rest may only call management.azure.com, graph.microsoft.com, api.loganalytics.io or a vault.azure.net vault over https, not ${parsed.host || url}`);
      }
    }
    const method = (rest.method ?? "get").toLowerCase();
    if (!["get", "head", "options", "post", "put", "patch", "delete"].includes(method)) return result("read", false, `az rest method '${method}' is not recognised`);
    let restTier: Tier = ["get", "head", "options"].includes(method) ? "read" : method === "delete" ? "destructive" : "write";
    // Anything read from a vault may be a secret value, so it is gated like Get_Key_Vault_Secret.
    const vault = !url.startsWith("/") && new URL(url).hostname.endsWith(".vault.azure.net");
    if (vault && restTier === "read") restTier = "write";
    return result(restTier, vault);
  }

  let tier = verbTier(verb);
  if (tier !== "read" && path.slice(0, -1).some((token) => DESTRUCTIVE_GROUPS.has(token))) tier = "destructive";
  // Deployment stacks delete what leaves the stack when told to.
  const unmanage = args.findIndex((a) => a === "--action-on-unmanage" || a.startsWith("--action-on-unmanage=") || a === "--aou" || a.startsWith("--aou="));
  const unmanageValue = unmanage < 0 ? "" : args[unmanage].includes("=") ? args[unmanage].split("=")[1] : (args[unmanage + 1] ?? "");
  if (/^delete/i.test(unmanageValue)) tier = "destructive";
  // Complete mode deletes every resource in the group that the template does not mention.
  const mode = args.findIndex((a) => a === "--mode" || a.startsWith("--mode="));
  const modeValue = mode < 0 ? "" : args[mode].includes("=") ? args[mode].split("=")[1] : (args[mode + 1] ?? "");
  if (path[0] === "deployment" && modeValue.toLowerCase() === "complete") tier = "destructive";
  if (verb === "download" && tier === "read") tier = "write";
  const sensitive =
    (path.some((token) => SENSITIVE_TOKEN.test(token)) && !NOT_SENSITIVE.test(joined)) || SENSITIVE_PATHS.some((re) => re.test(joined)) || hasFlag(flags, SENSITIVE_FLAGS);
  if (sensitive && tier === "read") tier = "write";
  return result(tier, sensitive);
}

/** A tiny shell-word splitter for a command given as one string: quotes and backslash escapes, no expansion. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length) {
      current += command[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (quote) throw new Error("Unterminated quote in command.");
  if (started) words.push(current);
  if (words[0] === "az") words.shift();
  return words;
}

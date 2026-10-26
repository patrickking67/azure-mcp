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
// Independent of tier, an argument starting with '@' is refused: the CLI reads '@path' as "the
// contents of this local file", which would let a prompt-injected command upload a local file.

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
]);
const DESTRUCTIVE_PREFIXES = ["delete-", "remove-", "stop-", "purge-", "deallocate-", "restart-", "reset-", "rotate-", "regenerate-", "revoke-", "force-"];

const SENSITIVE_VERBS = new Set([
  "list-keys", "keys", "list-connection-strings", "show-connection-string", "list-credentials", "get-credentials", "list-secrets",
  "list-publishing-profiles", "list-publishing-credentials", "generate-sas", "list-auth-keys", "get-auth-keys", "list-access-keys",
]);
const SENSITIVE_GROUPS = new Set(["keys", "credential", "credentials", "connection-string", "appsettings"]);

// az rest may only target Azure's own endpoints: it attaches a token for these, and a body sent anywhere else is a leak.
const REST_HOSTS = [/\.azure\.com$/, /\.azure\.net$/, /^graph\.microsoft\.com$/, /^api\.loganalytics\.io$/, /\.windows\.net$/, /^management\.core\.windows\.net$/];

export function commandPath(args: string[]): string[] {
  const path: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    path.push(arg);
  }
  return path;
}

function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const name of names) {
      if (arg === name) return args[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

export function hasFlag(args: string[], names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function verbTier(verb: string): Tier {
  if (READ_VERBS.has(verb) || READ_PREFIXES.some((p) => verb.startsWith(p))) return "read";
  if (DESTRUCTIVE_VERBS.has(verb) || DESTRUCTIVE_PREFIXES.some((p) => verb.startsWith(p))) return "destructive";
  return "write";
}

export function classify(args: string[]): Classification {
  const path = commandPath(args);
  const verb = path.at(-1) ?? "";
  const joined = path.join(" ");
  const result = (tier: Tier, sensitive = false, blocked?: string): Classification => ({ path, verb, tier, sensitive, ...(blocked ? { blocked } : {}) });

  if (path.length === 0) return result("read", false, "no command given; pass the words after 'az', e.g. [\"vm\", \"list\"]");
  for (const [prefix, reason] of BLOCKED_PREFIXES) {
    if (joined === prefix || joined.startsWith(`${prefix} `)) return result("write", false, `'az ${prefix}' ${reason}`);
  }
  for (const arg of args) {
    if (arg.startsWith("@") || /=@/.test(arg)) return result("write", false, `argument '${arg}' would make the CLI read a local file; pass the content inline instead`);
  }
  if (hasFlag(args, ["--debug"])) return result("write", false, "--debug can print request details; use --verbose");

  if (path[0] === "rest" && path.length === 1) {
    const url = flagValue(args, ["--url", "--uri", "-u"]);
    if (!url) return result("read", false, "az rest needs --url");
    if (!url.startsWith("/")) {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return result("read", false, `az rest --url '${url}' is not a URL`);
      }
      if (!url.startsWith("https://") || !REST_HOSTS.some((re) => re.test(host))) return result("read", false, `az rest may only call Azure endpoints over https, not ${host}`);
    }
    const method = (flagValue(args, ["--method", "-m"]) ?? "get").toLowerCase();
    let tier: Tier = ["get", "head", "options"].includes(method) ? "read" : method === "delete" ? "destructive" : "write";
    if (tier === "read" && hasFlag(args, ["--output-file"])) tier = "write";
    return result(tier);
  }

  let tier = verbTier(verb);
  if (verb === "download" || hasFlag(args, ["--output-file", "--file-path"]) && tier === "read") tier = "write";
  const sensitive =
    SENSITIVE_VERBS.has(verb) ||
    (path.slice(0, -1).some((token) => SENSITIVE_GROUPS.has(token)) && tier === "read") ||
    (joined.startsWith("keyvault secret") && ["show", "download", "show-deleted"].includes(verb));
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

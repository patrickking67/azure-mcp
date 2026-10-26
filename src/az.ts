// Locating and running the Azure CLI. Every call is an argv array; nothing is ever passed through a shell.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { envValue } from "./env.js";

export class AzureCliError extends Error {}

export type AzInvocation = { command: string; prefix: string[]; source: string };

// Windows has no az.exe: the launcher is az.cmd, and Node cannot spawn a .cmd without a shell.
// Shelling out would mean building command strings, which is exactly the injection surface we
// refuse to open. az.cmd itself just runs "python.exe -IBm azure.cli", so we resolve that
// interpreter directly and keep every call on an argv array.
function pythonForCliRoot(root: string): string | undefined {
  const candidate = join(root, "python.exe");
  return existsSync(candidate) ? candidate : undefined;
}

export function resolveAzBinary(): AzInvocation {
  const configured = envValue("AZ_PATH");
  if (configured && existsSync(configured)) return { command: configured, prefix: [], source: "AZ_PATH" };

  if (process.platform === "win32") {
    const roots = [
      join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft SDKs", "Azure", "CLI2"),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft SDKs", "Azure", "CLI2"),
    ];
    for (const root of roots) {
      const python = pythonForCliRoot(root);
      if (python) return { command: python, prefix: ["-IBm", "azure.cli"], source: root };
    }
    // Fall back to whatever the PATH launcher points at, deriving <root>\python.exe from <root>\wbin\az.cmd.
    for (const dir of (process.env.PATH ?? "").split(";")) {
      for (const name of ["az.cmd", "az.bat"]) {
        const launcher = join(dir, name);
        if (!existsSync(launcher)) continue;
        const python = pythonForCliRoot(dirname(dirname(launcher)));
        if (python) return { command: python, prefix: ["-IBm", "azure.cli"], source: launcher };
      }
    }
  }

  for (const candidate of ["/opt/homebrew/bin/az", "/usr/local/bin/az", "/usr/bin/az"]) {
    if (existsSync(candidate)) return { command: candidate, prefix: [], source: candidate };
  }
  return { command: "az", prefix: [], source: "PATH" };
}

export const AZ = resolveAzBinary();
export const AZ_LABEL = AZ.prefix.length > 0 ? `${AZ.command} ${AZ.prefix.join(" ")}` : AZ.command;

export type AzRunResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

// Set when the CLI tools must not touch the user's own ~/.azure (service principal or managed identity mode).
let isolatedConfigDir: string | undefined;
export function useIsolatedCliConfig(): string {
  isolatedConfigDir ??= mkdtempSync(join(tmpdir(), "azure-mcp-cli-"));
  return isolatedConfigDir;
}

export function cliConfigDir(): string | undefined {
  return isolatedConfigDir;
}

// The CLI tools run in an empty working directory, so a relative path (token.json, dist, '.') or a
// command that uploads "the current directory" (webapp up, acr build .) reaches nothing on this machine.
let sandboxDir: string | undefined;
export function cliSandboxDir(): string {
  sandboxDir ??= mkdtempSync(join(tmpdir(), "azure-mcp-cwd-"));
  return sandboxDir;
}

/** Run `az <args>` with stdin closed (prompts fail fast instead of hanging) and bounded output. */
export function azRun(args: string[], options: { timeoutMs?: number; cwd?: string } = {}): Promise<AzRunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, AZURE_CORE_NO_COLOR: "true", AZURE_CORE_SURVEY_MESSAGE: "false", PYTHONIOENCODING: "utf-8" };
    if (isolatedConfigDir) env.AZURE_CONFIG_DIR = isolatedConfigDir;
    let child;
    try {
      child = spawn(AZ.command, [...AZ.prefix, ...args], { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true, ...(options.cwd ? { cwd: options.cwd } : {}) });
    } catch (error) {
      reject(error);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    const take = (sink: Buffer[]) => (chunk: Buffer) => {
      if (size >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      size += chunk.length;
      sink.push(chunk);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, truncated });
    });
  });
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export async function azJson(args: string[]): Promise<JsonValue> {
  let result: AzRunResult;
  try {
    result = await azRun(args);
  } catch (error) {
    throw new AzureCliError(
      `Could not start the Azure CLI at '${AZ_LABEL}'. Install it, or set AZ_PATH (Settings > Extensions > Azure) to its absolute path. ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new AzureCliError(
      `Azure CLI '${AZ_LABEL} ${args.join(" ")}' failed. Ensure 'az login' has been run, ` +
        `or configure a service principal (tenant id, client id, client secret) in the connector settings. ` +
        `Underlying error: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
    );
  }
  return result.stdout ? (JSON.parse(result.stdout) as JsonValue) : null;
}

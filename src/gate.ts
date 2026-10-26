// Write gating.
//
// Two independent gates stand between a model and a change in Azure, and both are opened by a human
// editing the connector settings:
//
//   1. AZURE_MODE must be "write". Default is "read".
//   2. AZURE_ALLOW_DESTRUCTIVE must be "true" for the disruptive tier: deletes, deallocations,
//      restarts, key regeneration, anything that takes something away from a person using it now.
//
// On top of both, every write tool takes `confirm: true`. The env vars are the operator's standing
// decision; `confirm` is the model stating, per call, that it means this specific change.
//
// Write tools stay registered in read mode and refuse with a message naming the setting. A tool that
// vanishes reads as a broken install; a tool that names the setting is something an operator can fix.
//
// Remotely (src/remote.ts) a third check applies: the signed-in caller must hold the matching Entra
// app role. The server's gate is the ceiling for everyone; the role narrows it per caller.

import { z } from "zod";
import { envValue } from "./env.js";

export type Tier = "read" | "write" | "destructive";

export const MODE_VAR = "AZURE_MODE";
export const DESTRUCTIVE_VAR = "AZURE_ALLOW_DESTRUCTIVE";

export function isWriteMode(): boolean {
  return (envValue(MODE_VAR) ?? "read").toLowerCase() === "write";
}

export function isDestructiveAllowed(): boolean {
  return (envValue(DESTRUCTIVE_VAR) ?? "").toLowerCase() === "true";
}

type CallerCheck = (tier: Exclude<Tier, "read">) => string | null;
let callerCheck: CallerCheck | undefined;

/** The remote transport installs a per-caller check (Entra app roles). Returns a refusal, or null to allow. */
export function setCallerTierCheck(check: CallerCheck): void {
  callerCheck = check;
}

export const confirmParam = z
  .literal(true)
  .describe("Must be exactly true. Acknowledges that this call changes live Azure resources. There is no dry run: if this is set, the change is made.");

export function requireWrite(tool: string): void {
  if (!isWriteMode()) {
    throw new Error(
      `${tool} is a write tool and this server is in read mode. To enable writes, set ${MODE_VAR}=write ` +
        `(Settings > Extensions > Azure > Mode) and restart the client. Nothing was changed.`,
    );
  }
  const refusal = callerCheck?.("write");
  if (refusal) throw new Error(`${tool}: ${refusal} Nothing was changed.`);
}

export function requireDestructive(tool: string, impact: string): void {
  if (!isWriteMode() || !isDestructiveAllowed()) {
    throw new Error(
      `${tool} is a destructive tool (${impact}) and needs both gates open: ${MODE_VAR}=write and ${DESTRUCTIVE_VAR}=true ` +
        `in the connector settings, then restart the client. Nothing was changed.`,
    );
  }
  const refusal = callerCheck?.("destructive");
  if (refusal) throw new Error(`${tool}: ${refusal} Nothing was changed.`);
}

export function requireTier(tool: string, tier: Tier, impact = "irreversible or disruptive"): void {
  if (tier === "write") requireWrite(tool);
  else if (tier === "destructive") requireDestructive(tool, impact);
}

export const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const DESTRUCTIVE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export function annotationsFor(tier: Tier): typeof READ_ANNOTATIONS | typeof WRITE_ANNOTATIONS | typeof DESTRUCTIVE_ANNOTATIONS {
  return tier === "read" ? READ_ANNOTATIONS : tier === "write" ? WRITE_ANNOTATIONS : DESTRUCTIVE_ANNOTATIONS;
}

export function gateStatus(): { [key: string]: string | boolean } {
  return {
    mode: isWriteMode() ? "write" : "read",
    mode_env_var: MODE_VAR,
    destructive_allowed: isDestructiveAllowed(),
    destructive_env_var: DESTRUCTIVE_VAR,
    note:
      "Write tools stay listed in read mode and refuse with a message naming the setting. Every write tool also requires confirm=true. " +
      "Remote callers additionally need the Azure.Write or Azure.Destructive Entra app role.",
  };
}

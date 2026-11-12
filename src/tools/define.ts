// One registration helper for every tool, so tier, gate, confirm, annotations, the Azure CLI
// equivalent and the API reference entry are declared once per tool and cannot drift apart.

import type { McpServer, ToolCallback } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { annotationsFor, confirmParam, requireTier, type Tier } from "../gate.js";
import type { JsonObject } from "../client.js";
import { toolInputSchema } from "../schema.js";

/** What a handler receives: the parsed output of the tool's input shape. */
type ToolArgs<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

type ToolResult = { [key: string]: unknown; content: { type: "text"; text: string }[]; isError?: boolean };

export type ToolSpec<S extends z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  /** read, write (gate 1) or destructive (gates 1 and 2). Write tiers get a required confirm parameter. */
  tier: Tier;
  /** The Azure CLI command this tool is equivalent to, e.g. "az vm list". */
  cli?: string;
  /** For the destructive refusal message: what the call takes away. */
  impact?: string;
  /** Narrow the tier per call (ARM_Request: DELETE is destructive, POST is a write). The annotation keeps `tier`. */
  runtimeTier?: (args: ToolArgs<S>) => Tier;
  ref?: { method: string; path: string; apiVersion: string };
  inputSchema: S;
  meta?: Record<string, unknown>;
  handler: (args: ToolArgs<S>) => Promise<ToolResult>;
};

const reference = new Map<string, JsonObject>();

export function apiReference(): JsonObject[] {
  return [...reference.values()];
}

export function defineTool<S extends z.ZodRawShape>(server: McpServer, spec: ToolSpec<S>): void {
  if (spec.ref || spec.cli) {
    reference.set(spec.name, {
      tool: spec.name,
      tier: spec.tier,
      method: spec.ref?.method ?? null,
      path: spec.ref?.path ?? null,
      api_version: spec.ref?.apiVersion ?? null,
      az: spec.cli ?? null,
    });
  }
  const gated = spec.tier !== "read";
  // The shape is wrapped here, once, so every tool is advertised and validated as one object schema.
  const inputSchema = toolInputSchema(gated ? { ...spec.inputSchema, confirm: confirmParam } : spec.inputSchema);
  const description = spec.cli ? `${spec.description} CLI: \`${spec.cli}\`.` : spec.description;
  const callback = (async (args: ToolArgs<S>) => {
    if (gated) requireTier(spec.name, spec.runtimeTier ? spec.runtimeTier(args) : spec.tier, spec.impact);
    return spec.handler(args);
    // ToolCallback is a conditional type the compiler cannot resolve for a generic S.
  }) as unknown as ToolCallback<typeof inputSchema>;
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description,
      inputSchema,
      annotations: { ...annotationsFor(spec.tier), title: spec.title },
      // Claude Code asks the user before every call of a tool carrying this, on top of the server's gates.
      ...(gated || spec.meta ? { _meta: { ...(gated ? { "anthropic/requiresUserInteraction": true } : {}), ...spec.meta } } : {}),
    },
    callback,
  );
}

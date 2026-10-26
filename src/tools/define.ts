// One registration helper for every tool, so tier, gate, confirm, annotations, the Azure CLI
// equivalent and the API reference entry are declared once per tool and cannot drift apart.

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { annotationsFor, confirmParam, requireTier, type Tier } from "../gate.js";
import type { JsonObject } from "../client.js";

type ToolResult = { [key: string]: unknown; content: { type: "text"; text: string }[]; isError?: boolean };

export type ToolSpec<S extends ZodRawShapeCompat> = {
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
  runtimeTier?: (args: ShapeOutput<S>) => Tier;
  ref?: { method: string; path: string; apiVersion: string };
  inputSchema: S;
  meta?: Record<string, unknown>;
  handler: (args: ShapeOutput<S>) => Promise<ToolResult>;
};

const reference = new Map<string, JsonObject>();

export function apiReference(): JsonObject[] {
  return [...reference.values()];
}

export function defineTool<S extends ZodRawShapeCompat>(server: McpServer, spec: ToolSpec<S>): void {
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
  const inputSchema = (gated ? { ...spec.inputSchema, confirm: confirmParam } : spec.inputSchema) as S;
  const description = spec.cli ? `${spec.description} CLI: \`${spec.cli}\`.` : spec.description;
  const callback = (async (args: ShapeOutput<S>) => {
    if (gated) requireTier(spec.name, spec.runtimeTier ? spec.runtimeTier(args) : spec.tier, spec.impact);
    return spec.handler(args);
    // ToolCallback<S> is a conditional type the compiler cannot resolve for a generic S.
  }) as unknown as ToolCallback<S>;
  server.registerTool<ZodRawShapeCompat, S>(
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

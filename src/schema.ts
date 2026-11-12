// Turns a tool's zod shape into the input schema handed to the MCP SDK.
//
// SDK 2 asks a schema for JSON Schema 2020-12. This server has always advertised draft-07, and the two
// dialects agree on every keyword these tools use, so the dialect is kept and the tool listing clients
// see is the same as before the SDK upgrade (test/tool-listing.test.mjs pins it). Arguments are still
// validated by zod; only the advertised JSON Schema is pinned.

import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";

export type ToolInput<S extends z.ZodRawShape> = StandardSchemaWithJSON<z.input<z.ZodObject<S>>, z.output<z.ZodObject<S>>>;

export function toolInputSchema<S extends z.ZodRawShape>(shape: S): ToolInput<S> {
  const schema = z.object(shape);
  const standard = schema["~standard"];
  const convert = (io: "input" | "output") => (): Record<string, unknown> => z.toJSONSchema(schema, { target: "draft-7", io });
  return {
    "~standard": {
      version: standard.version,
      vendor: standard.vendor,
      validate: (value) => standard.validate(value),
      jsonSchema: { input: convert("input"), output: convert("output") },
    },
  };
}

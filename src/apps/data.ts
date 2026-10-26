// Loaders shared by the views. A view reads several Azure APIs at once; one failing (no Defender plan,
// no Cost Management reader role) must not blank the whole view, so each read goes through attempt(),
// which records a note and lets the rest render.

import { isJsonObject, type JsonObject, type JsonValue } from "../client.js";

export async function attempt<T>(label: string, run: () => Promise<T>, notes: string[]): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`${label}: ${message.length > 300 ? `${message.slice(0, 300)}…` : message}`);
    return undefined;
  }
}

/** Cost Management answers {columns:[{name}], rows:[[...]]}; turn it into objects keyed by column name. */
export function costRows(result: JsonObject | undefined): JsonObject[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];
  const names = (result.columns as JsonValue[]).map((c) => (isJsonObject(c) ? String(c.name ?? "") : ""));
  return (result.rows as JsonValue[]).filter(Array.isArray).map((row) => {
    const entry: JsonObject = {};
    (row as JsonValue[]).forEach((value, i) => {
      entry[names[i] ?? `col${i}`] = value;
    });
    return entry;
  });
}

export const str = (v: JsonValue | undefined): string | null => (typeof v === "string" && v ? v : null);
export const num = (v: JsonValue | undefined): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/** KQL string literal content. Quotes and backslashes are refused rather than escaped. */
export function kqlLiteral(value: string, label: string): string {
  if (/['"\\\n\r]/.test(value)) throw new Error(`${label} cannot contain quotes, backslashes or newlines.`);
  return value;
}

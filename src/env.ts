// Hosts pass unset optional user_config through as the literal "${user_config.x}" placeholder; treat those as unset.
export function envValue(key: string): string | undefined {
  const value = process.env[key];
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("${")) return undefined;
  return trimmed;
}

export function envFlag(key: string): boolean {
  return (envValue(key) ?? "").toLowerCase() === "true";
}

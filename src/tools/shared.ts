import { z } from "zod";

export const subscriptionSchema = {
  subscription_id: z.string().optional().describe("Azure subscription id. Omit to use the configured default or the az default subscription."),
};

export const resourceGroupParam = (what: string) => z.string().min(1).describe(`Resource group of the ${what}.`);

export const KEY_VAULT_NAME = /^[A-Za-z0-9-]{3,24}$/;
export const KEY_VAULT_SECRET_NAME = /^[A-Za-z0-9-]{1,127}$/;

// Names are interpolated into ARM paths. ARM rejects most bad input itself, but a '/', '?' or '#'
// would change which resource or query the request reaches, so those are refused before sending.
export function segment(value: string, label: string): string {
  if (!value || /[/?#\\]/.test(value) || value === "." || value === "..") throw new Error(`${label} '${value}' is not a valid Azure name.`);
  return encodeURIComponent(value);
}

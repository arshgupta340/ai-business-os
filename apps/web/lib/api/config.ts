/**
 * Environment reads for the API layer. Next.js inlines NEXT_PUBLIC_* values
 * only when they are written out literally, so keep these exact expressions.
 */

/** True when NEXT_PUBLIC_MOCK=1. UI code never reads the flag itself; it calls the client and hooks. */
export function isMockMode(): boolean {
  return process.env.NEXT_PUBLIC_MOCK === "1";
}

/** Base URL for the REST API. Empty means same origin, which is what mock mode in the browser uses. */
export function defaultBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
}

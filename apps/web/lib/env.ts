/**
 * Public environment flags for the browser.
 *
 * Next.js inlines NEXT_PUBLIC_* values at build time only when they are read
 * as literal `process.env.NAME` expressions, so keep each read below as is.
 */

/** True when the app runs on fixtures with no backend (NEXT_PUBLIC_MOCK=1). */
export function isMockMode(): boolean {
  return process.env.NEXT_PUBLIC_MOCK === '1';
}

/**
 * True when the Build screen runs the short scripted demo path
 * (NEXT_PUBLIC_DEMO_SCRIPT=1). Off by default: the real builder is untouched.
 */
export function isDemoScript(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_SCRIPT === '1';
}

/**
 * The phone number the demo result panel shows (NEXT_PUBLIC_DEMO_PHONE_NUMBER),
 * fixed before the demo. Undefined when it is missing or empty.
 */
export function getDemoPhoneNumber(): string | undefined {
  const value = process.env.NEXT_PUBLIC_DEMO_PHONE_NUMBER;
  return value && value.trim() ? value.trim() : undefined;
}

export type PublicSupabaseConfig = {url: string; anonKey: string};

/** Returns null when either Supabase value is missing or empty. */
export function getPublicSupabaseConfig(): PublicSupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return null;
  }
  return {url, anonKey};
}

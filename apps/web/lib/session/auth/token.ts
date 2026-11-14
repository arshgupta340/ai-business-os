import {isMockMode} from '@/lib/env';
import {getSupabaseBrowserClient} from '@/lib/supabase/client';

/** The fixed bearer token used in mock mode. It is not a secret. */
export const MOCK_ACCESS_TOKEN = 'mock-token';

/**
 * The bearer token for `Authorization: Bearer <token>` (docs/API.md 1).
 * Mock mode: always MOCK_ACCESS_TOKEN, with no network.
 * Otherwise: the current Supabase access token, or null when signed out or
 * when Supabase is not configured.
 */
export async function getAccessToken(): Promise<string | null> {
  if (isMockMode()) {
    return MOCK_ACCESS_TOKEN;
  }
  const supabase = getSupabaseBrowserClient();
  if (!supabase) {
    return null;
  }
  try {
    const {data} = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {getPublicSupabaseConfig} from '@/lib/env';

let cachedClient: SupabaseClient | null = null;

/**
 * Returns one shared Supabase browser client, or null when
 * NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.
 * It never throws for missing configuration. Callers show a configuration
 * error instead.
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (cachedClient) {
    return cachedClient;
  }
  const config = getPublicSupabaseConfig();
  if (!config) {
    return null;
  }
  cachedClient = createClient(config.url, config.anonKey, {
    auth: {persistSession: true, autoRefreshToken: true},
  });
  return cachedClient;
}

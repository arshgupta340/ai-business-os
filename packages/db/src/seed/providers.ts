// The real provider clients behind the AuthAdmin and SquareCatalogClient interfaces.
// Plain fetch, so the db package needs no SDK. Error messages carry the HTTP status and the
// provider's own message, never a request header or a key. Not exercised by the unit tests.

import type { AuthAdmin } from './owner';
import type { SquareCatalogClient, SquareCatalogObject } from './square';

type Fetch = typeof fetch;

/** Supabase Auth admin API, called with the secret (service role) key. */
export function supabaseAuthAdmin(supabaseUrl: string, serviceRoleKey: string, fetchImpl: Fetch = fetch): AuthAdmin {
  const base = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/admin/users`;
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' };

  async function call<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetchImpl(url, { ...init, headers });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg = String(body.msg ?? body.message ?? body.error_description ?? body.error ?? 'no message');
      throw new Error(`Supabase Auth admin API returned HTTP ${res.status}: ${msg}`);
    }
    return body as T;
  }

  return {
    async findUserByEmail(email) {
      const want = email.toLowerCase();
      const perPage = 200;
      for (let page = 1; page <= 50; page += 1) {
        const body = await call<{ users?: { id: string; email?: string }[] }>(`${base}?page=${page}&per_page=${perPage}`, { method: 'GET' });
        const users = body.users ?? [];
        const hit = users.find((u) => (u.email ?? '').toLowerCase() === want);
        if (hit) return { id: hit.id };
        if (users.length < perPage) return undefined;
      }
      throw new Error('Supabase Auth has more than 10000 users; the owner lookup stopped.');
    },
    async createUser(email, password) {
      const body = await call<{ id?: string }>(base, { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) });
      if (!body.id) throw new Error('Supabase Auth created the user but returned no ID.');
      return { id: body.id };
    },
  };
}

/** The Square version the installed SDK (square 46) sends. */
const SQUARE_VERSION = '2026-09-16';
/** Always the sandbox host. There is no production option. */
const SQUARE_SANDBOX_BASE = 'https://connect.squareupsandbox.com/v2';

export function squareSandboxCatalogClient(accessToken: string, fetchImpl: Fetch = fetch): SquareCatalogClient {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' };

  async function call<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetchImpl(`${SQUARE_SANDBOX_BASE}${path}`, { ...init, headers });
    const body = (await res.json().catch(() => ({}))) as { errors?: { category?: string; code?: string; field?: string; detail?: string }[] };
    if (!res.ok || (body.errors && body.errors.length > 0)) {
      const detail = (body.errors ?? []).map((e) => `${e.category ?? ''} ${e.code ?? ''}${e.field ? ` field=${e.field}` : ''}: ${e.detail ?? ''}`).join('; ');
      throw new Error(`Square sandbox returned HTTP ${res.status}: ${detail || 'no detail'}`);
    }
    return body as T;
  }

  return {
    async listCatalog(types) {
      const out: SquareCatalogObject[] = [];
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ types: types.join(',') });
        if (cursor) q.set('cursor', cursor);
        const body = await call<{ objects?: SquareCatalogObject[]; cursor?: string }>(`/catalog/list?${q.toString()}`, { method: 'GET' });
        out.push(...(body.objects ?? []));
        cursor = body.cursor;
      } while (cursor);
      return out;
    },
    async batchUpsert(idempotencyKey, objects) {
      const body = await call<{ objects?: SquareCatalogObject[]; id_mappings?: { client_object_id?: string; object_id?: string }[] }>(
        '/catalog/batch-upsert',
        { method: 'POST', body: JSON.stringify({ idempotency_key: idempotencyKey, batches: [{ objects }] }) },
      );
      return {
        objects: body.objects ?? [],
        idMappings: (body.id_mappings ?? []).flatMap((m) =>
          m.client_object_id && m.object_id ? [{ clientObjectId: m.client_object_id, objectId: m.object_id }] : []),
      };
    },
  };
}

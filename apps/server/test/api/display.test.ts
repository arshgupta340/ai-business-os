// Issue #108: the server sends the display fields it can already load. `decidedByName` comes from
// the users row of the business owner, and a price edit's `itemName` and `variationName` come from
// the catalog cache row in its subjectId. None of them is stored on the approval or hashed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BUNDLE_ACTIONS, ENDPOINTS, MATERIAL_FIELDS, canonicalJson, hashCanonical, verifyPayloadHash } from '@abos/contracts';
import { buildApp } from '../../src/app';
import { parseEnv } from '../../src/env';
import { createInMemoryEngine } from '../../src/api/ports';
import { ownerDisplayNames, withApprovalDisplayFields } from '../../src/api/display';
import { createHarness, headers, verifier } from './harness';

const env = parseEnv({ TWILIO_PHONE_NUMBER: '+15555550199' });

describe('issue #108 display fields on approvals', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let app: FastifyInstance;
  const setName = (userId: string, name: string | null) => h.admin((q) => q.query('update public.users set display_name = $2 where id = $1', [userId, name]));

  /**
   * Inserts one PENDING approval row as the owner role, with the real canonical text and hash.
   * `rejected` then records a rejection with one update the approval guard checks. A rejected
   * approval runs nothing, so this fixture never stands in for an approved write.
   */
  async function insertApproval(id: string, bundleType: 'fact_edit' | 'price_edit', subjectId: string, material: Record<string, unknown>, rejected = false) {
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 600_000).toISOString();
    const payload = { businessId: 'biz_a', subjectId, ...material, actionBundle: [...BUNDLE_ACTIONS[bundleType]], expiresAt };
    await h.insert('approval_requests', { id, business_id: 'biz_a', actor_type: 'owner', actor_id: 'usr_a', bundle_type: bundleType,
      action_bundle: [...BUNDLE_ACTIONS[bundleType]], subject_id: subjectId, payload, payload_canonical: canonicalJson(payload),
      payload_hash: await hashCanonical(payload), created_at: createdAt, expires_at: expiresAt });
    if (rejected) await h.admin((q) => q.query("update public.approval_requests set state = 'REJECTED', decided_by = 'usr_a', decided_at = now() where id = $1", [id]));
  }
  const price = (variationId: string) => ({ squareItemId: 'ITEM_a', variationId, fromPriceMinor: 100, newPriceMinor: 90, currency: 'USD', squareVersion: 1 });
  const get = async (id: string) => {
    const res = await app.inject({ url: `/api/approvals/${id}?businessId=biz_a`, headers });
    expect(res.statusCode, res.body).toBe(200);
    return ENDPOINTS.getApproval.response.parse(res.json());
  };

  beforeAll(async () => {
    h = await createHarness();
    await setName('usr_a', '  Ada Owner ');
    await setName('usr_b', 'Bea Other');
    await h.insert('business_facts', { id: 'fact_done', business_id: 'biz_a', kind: 'policy', key: 'done', value: { minutes: 10 }, source_type: 'seed' });
    await insertApproval('apv_done', 'fact_edit', 'fact_done', { kind: 'policy', key: 'done', fromVersion: 1, before: { minutes: 10 }, after: { minutes: 20 } }, true);
    await insertApproval('apv_price', 'price_edit', 'cat_a1', price('VAR_a1'));
    await insertApproval('apv_price_gone', 'price_edit', 'cat_gone', price('VAR_gone'), true);
    app = await buildApp(env, { db: h.db, verifier, ports: createInMemoryEngine(h.approvals) });
  }, 30_000);
  afterAll(async () => { await app?.close(); await h?.close(); });

  it('names the decider on a decided approval and sends no name on a pending one', async () => {
    const decided = await get('apv_done');
    expect(decided).toMatchObject({ state: 'REJECTED', decidedBy: 'usr_a', decidedByName: 'Ada Owner' });
    const pending = await get('apv_a1');
    expect(pending.state).toBe('PENDING');
    expect(pending).not.toHaveProperty('decidedByName');
  });

  it('the list carries the same fields as the single read', async () => {
    const res = await app.inject({ url: '/api/approvals?businessId=biz_a&state=REJECTED', headers });
    const page = ENDPOINTS.listApprovals.response.parse(res.json());
    expect(page.items.map((a) => [a.id, a.decidedByName]).sort()).toEqual([['apv_done', 'Ada Owner'], ['apv_price_gone', 'Ada Owner']]);
    const pending = ENDPOINTS.listApprovals.response.parse((await app.inject({ url: '/api/approvals?businessId=biz_a&bundleType=price_edit', headers })).json());
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({ id: 'apv_price', itemName: 'Pizza a', variationName: '1' });
  });

  it('a price edit carries the catalog names of its subject row, outside the hashed payload', async () => {
    const approval = await get('apv_price');
    expect(approval).toMatchObject({ bundleType: 'price_edit', subjectId: 'cat_a1', itemName: 'Pizza a', variationName: '1' });
    expect(Object.keys(approval.payload).sort()).toEqual([...MATERIAL_FIELDS.price_edit].sort());
    expect(await verifyPayloadHash('price_edit', approval.payload, approval.payloadHash)).toBe(true);
  });

  it('a price edit whose catalog row is gone has no names and still answers', async () => {
    const approval = await get('apv_price_gone');
    expect(approval).toMatchObject({ state: 'REJECTED', decidedByName: 'Ada Owner' });
    expect(approval).not.toHaveProperty('itemName');
    expect(approval).not.toHaveProperty('variationName');
  });

  it('a fact edit never gets catalog names, even when a catalog row shares nothing with it', async () => {
    const approval = await get('apv_done');
    expect(approval).not.toHaveProperty('itemName');
  });

  it('the decision response names the decider', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/approvals/apv_a1/decision?businessId=biz_a',
      headers: { ...headers, 'idempotency-key': 'display-one' }, payload: { decision: 'approve', payloadHash: h.hashOf('apv_a1') } });
    expect(res.statusCode, res.body).toBe(200);
    const body = ENDPOINTS.decideApproval.response.parse(res.json());
    expect(body.approval).toMatchObject({ id: 'apv_a1', state: 'APPROVED', decidedBy: 'usr_a', decidedByName: 'Ada Owner' });
    expect(Object.keys(res.json().approval).sort()).toEqual(['decidedAt', 'decidedBy', 'decidedByName', 'id', 'state']);
  });

  it('a failed name lookup after the decision still answers 200, without a name', async () => {
    const failing = { ...h.db, query: (text: string, params?: unknown[]) => text.includes('b.owner_id = u.id') ? Promise.reject(new Error('lookup down')) : h.db.query(text, params) };
    const isolated = await buildApp(env, { db: failing, verifier, ports: createInMemoryEngine(h.approvals) });
    try {
      const res = await isolated.inject({ method: 'POST', url: '/api/approvals/apv_a2/decision?businessId=biz_a', headers, payload: { decision: 'reject', payloadHash: h.hashOf('apv_a2') } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().approval).toMatchObject({ id: 'apv_a2', state: 'REJECTED', decidedBy: 'usr_a' });
      expect(res.json().approval).not.toHaveProperty('decidedByName');
    } finally { await isolated.close(); }
  });

  it('never names a user who does not own the business', async () => {
    expect([...(await ownerDisplayNames(h.db, 'biz_a', ['usr_a', 'usr_b']))]).toEqual([['usr_a', 'Ada Owner']]);
    expect([...(await ownerDisplayNames(h.db, 'biz_b', ['usr_a', 'usr_b']))]).toEqual([['usr_b', 'Bea Other']]);
    // A row of business A never picks up a catalog row of business B, whatever its subjectId says.
    const [foreign] = await withApprovalDisplayFields(h.db, 'biz_a', [{ id: 'apv_x', bundleType: 'price_edit', subjectId: 'cat_b1', decidedBy: 'usr_b' }]);
    expect(foreign).toEqual({ id: 'apv_x', bundleType: 'price_edit', subjectId: 'cat_b1', decidedBy: 'usr_b' });
  });

  it('sends no name when the user has none', async () => {
    await setName('usr_a', null);
    try {
      expect(await get('apv_done')).not.toHaveProperty('decidedByName');
      await setName('usr_a', '   ');
      expect(await get('apv_done')).not.toHaveProperty('decidedByName');
    } finally { await setName('usr_a', 'Ada Owner'); }
  });
});

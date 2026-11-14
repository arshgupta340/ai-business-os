import { describe, expect, it } from 'vitest';
import {
  BuilderTurnResponseSchema,
  ENDPOINTS,
  ListOrdersQuerySchema,
  PaginationQuerySchema,
  TelemetryResponseSchema,
  buildPath,
  createToolHandler,
  pageOf,
  toolResultSchema,
  CallSchema,
  type Toolset,
} from './index';

const call = {
  id: 'call_77', businessId: 'biz_pizza_01', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2', channel: 'phone', stage: 'CUSTOMER_CONFIRMED',
  providerCallId: 'CA123', callerLast4: '0123', status: 'COMPLETED', endReason: 'completed', startedAt: '2026-11-13T19:40:00Z', endedAt: '2026-11-13T19:44:00Z',
};
const conflict = {
  id: 'cfl_01', businessId: 'biz_pizza_01', kind: 'menu_item', key: 'SQ_VAR_MARG_LG', required: true, state: 'resolved',
  candidates: [ { factId: 'fact_menu_1', sourceType: 'upload', value: { priceMinor: 2100 } }, { sourceType: 'square', sourceRef: 'cat_marg_lg', value: { priceMinor: 2000 } } ],
  resolvedBy: 'usr_owner_01', resolvedAt: '2026-11-13T19:10:00Z', createdAt: '2026-11-13T19:00:30Z',
};

describe('endpoint table', () => {
  it('has unique method+path pairs, owners and tiers', () => {
    const keys = Object.values(ENDPOINTS).map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of Object.values(ENDPOINTS)) {
      expect(['arsh', 'saina']).toContain(e.owner);
      expect(['MUST', 'SHOULD']).toContain(e.tier);
      expect(e.path.startsWith('/api/')).toBe(true);
    }
    // API.md section 3 (35 routes) plus the 7 from issue #56.
    expect(keys.sort()).toEqual([
      'GET /api/businesses', 'GET /api/businesses/:id', 'PATCH /api/businesses/:id', 'GET /api/businesses/:id/facts',
      'POST /api/businesses/:id/facts/propose', 'POST /api/businesses/:id/catalog/sync', 'POST /api/businesses/:id/catalog/prices/propose',
      'POST /api/businesses/:id/files', 'GET /api/files/:id',
      'POST /api/builder/sessions', 'GET /api/builder/sessions/:id', 'POST /api/builder/sessions/:id/messages',
      'GET /api/agents', 'POST /api/agents', 'GET /api/agents/:id', 'POST /api/agents/:id/preview', 'POST /api/agents/:id/test',
      'POST /api/agents/:id/sim-call', 'POST /api/agents/:id/publish', 'POST /api/agents/:id/pause', 'GET /api/agents/:id/versions',
      'POST /api/agents/:id/rollback', 'POST /api/realtime/client-secret', 'GET /api/live-agent', 'PUT /api/live-agent',
      'GET /api/approvals', 'GET /api/approvals/:id', 'POST /api/approvals/:id/decision',
      'GET /api/orders', 'GET /api/orders/:id', 'GET /api/orders/:id/checkout', 'GET /api/bookings', 'GET /api/bookings/:id',
      'GET /api/activity', 'GET /api/integrations/health',
      'GET /api/businesses/:id/catalog', 'GET /api/calls', 'GET /api/calls/:id', 'GET /api/telemetry',
      'POST /api/conflicts/:id/resolve', 'POST /api/orders/:id/cancel', 'POST /api/executions/:id/resolve',
    ].sort());
  });

  it('includes the issue #56 endpoints with their owner and tier', () => {
    expect(ENDPOINTS.getCatalog).toMatchObject({ method: 'GET', path: '/api/businesses/:id/catalog', owner: 'arsh', tier: 'MUST' });
    expect(ENDPOINTS.listCalls).toMatchObject({ method: 'GET', path: '/api/calls', owner: 'arsh', tier: 'MUST' });
    expect(ENDPOINTS.getCall).toMatchObject({ method: 'GET', path: '/api/calls/:id', owner: 'arsh' });
    expect(ENDPOINTS.getTelemetry).toMatchObject({ path: '/api/telemetry', owner: 'arsh', tier: 'SHOULD' });
    expect(ENDPOINTS.resolveConflict).toMatchObject({ method: 'POST', path: '/api/conflicts/:id/resolve', owner: 'saina', tier: 'MUST' });
    expect(ENDPOINTS.cancelOrder).toMatchObject({ path: '/api/orders/:id/cancel', owner: 'arsh', tier: 'SHOULD' });
    expect(ENDPOINTS.resolveExecution).toMatchObject({ path: '/api/executions/:id/resolve', owner: 'arsh', tier: 'SHOULD' });
  });

  it('new endpoint schemas parse samples', () => {
    expect(ENDPOINTS.getCatalog.response.safeParse({ items: [ { squareItemId: 'SQ_ITEM_MARG', businessId: 'biz_pizza_01', name: 'Margherita', available: true,
      variations: [ { id: 'SQ_VAR_MARG_LG', name: 'Large', priceMinor: 2000, currency: 'USD' } ],
      modifierLists: [ { id: 'SQ_ML_TOP', name: 'Toppings', selectionType: 'MULTIPLE', modifiers: [ { id: 'SQ_MOD_MUSH', name: 'Mushrooms', priceMinor: 150 } ] } ],
      syncedAt: '2026-11-13T19:30:00Z' } ], syncedAt: '2026-11-13T19:30:00Z' }).success).toBe(true);
    expect(CallSchema.safeParse(call).success).toBe(true);
    expect(ENDPOINTS.listCalls.response.safeParse({ items: [call] }).success).toBe(true);
    expect(ENDPOINTS.listCalls.query.safeParse({ businessId: 'biz_pizza_01', agentId: 'agt_pizza_01', since: '2026-11-13T00:00:00Z', limit: '20' }).success).toBe(true);
    expect(TelemetryResponseSchema.safeParse({ metrics: [ { name: 'call_answer_latency', p50Ms: 800, p95Ms: 1400, count: 12 }, { name: 'first_audio', p50Ms: 600, p95Ms: 900, count: 12 } ] }).success).toBe(true);
    expect(TelemetryResponseSchema.safeParse({ metrics: [ { name: 'made_up', p50Ms: 1, p95Ms: 1, count: 1 } ] }).success).toBe(false);
    expect(ENDPOINTS.resolveConflict.body.safeParse({ resolution: 'keep_authoritative' }).success).toBe(true);
    expect(ENDPOINTS.resolveConflict.body.safeParse({ resolution: 'keep_upload' }).success).toBe(false);
    expect(ENDPOINTS.resolveConflict.response.safeParse({ conflict }).success).toBe(true);
    expect(ENDPOINTS.resolveExecution.body.safeParse({ action: 'retry' }).success).toBe(true);
    expect(ENDPOINTS.resolveExecution.body.safeParse({ action: 'mark_ready' }).success).toBe(false);
    expect(ENDPOINTS.resolveExecution.response.safeParse({ execution: {
      id: 'exe_1', businessId: 'biz_pizza_01', approvalId: 'apv_123', actionType: 'square.checkout.create', stepIndex: 0, capabilityId: 'order.checkout.prepare',
      idempotencyKey: '2fd6d973a180e400b74a9947b499dc765bae29b092d3e26166f234da71177985', status: 'QUEUED', attempts: 1,
      createdAt: '2026-11-13T19:44:10Z', updatedAt: '2026-11-13T19:45:10Z' } }).success).toBe(true);
  });

  it('builder turn: unsupportedRequests is required; proposedChange is optional and only fact_edit or price_edit', () => {
    const base = {
      reply: { id: 'bmsg_02', sessionId: 'bld_01', role: 'assistant', inputMode: 'text', text: 'Done.', createdAt: '2026-11-13T19:01:00Z' },
      draftSpec: {}, missingFields: [], suggestions: [], stopConditions: [], progress: { answered: 1, required: 6 },
    };
    expect(BuilderTurnResponseSchema.safeParse(base).success).toBe(false);
    expect(BuilderTurnResponseSchema.safeParse({ ...base, unsupportedRequests: ['refunds'] }).success).toBe(true);
    expect(BuilderTurnResponseSchema.safeParse({ ...base, unsupportedRequests: [], proposedChange: { approvalId: 'apv_f01', bundleType: 'fact_edit' } }).success).toBe(true);
    expect(BuilderTurnResponseSchema.safeParse({ ...base, unsupportedRequests: [], proposedChange: { approvalId: 'apv_f01', bundleType: 'order_bundle' } }).success).toBe(false);
  });

  it('business contact allows address', () => {
    expect(ENDPOINTS.getBusiness.response.safeParse({ id: 'biz_pizza_01', name: 'Demo Pizza Co.', category: 'restaurant', timezone: 'America/Los_Angeles',
      contact: { address: '1 Main St, San Luis Obispo, CA' }, settings: {}, createdAt: '2026-11-13T08:00:00Z', updatedAt: '2026-11-13T08:00:00Z' }).success).toBe(true);
  });

  it('queries: comma lists and string limits', () => {
    const q = ListOrdersQuerySchema.parse({ businessId: 'biz_pizza_01', status: 'PAYMENT_PENDING,PAID_VERIFIED', limit: '25' });
    expect(q.status).toEqual(['PAYMENT_PENDING', 'PAID_VERIFIED']);
    expect(q.limit).toBe(25);
    expect(ListOrdersQuerySchema.safeParse({ businessId: 'biz_pizza_01', status: 'PAID' }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(ENDPOINTS.listApprovals.query.safeParse({ businessId: 'biz_pizza_01', state: 'PENDING', bundleType: 'order_bundle' }).success).toBe(true);
  });

  it('pageOf and buildPath', () => {
    expect(pageOf(CallSchema).safeParse({ items: [], nextCursor: 'x' }).success).toBe(true);
    expect(buildPath(ENDPOINTS.getOrder.path, { id: 'ord_123' })).toBe('/api/orders/ord_123');
    expect(() => buildPath(ENDPOINTS.getOrder.path)).toThrow();
  });
});

describe('tools', () => {
  it('a tool result is ok:true plus its payload, or ok:false with a reason', () => {
    const s = toolResultSchema('get_order_status');
    expect(s.safeParse({ ok: true, orderId: 'ord_1', status: 'PAYMENT_PENDING', paid: false, checkoutLinkSent: true }).success).toBe(true);
    expect(s.safeParse({ ok: false, reason: 'NOT_FOUND' }).success).toBe(true);
    expect(s.safeParse({ ok: false, reason: 'INTERNAL' }).success).toBe(false);
  });

  it('propose_order: proposalId and approvalId present exactly when nothing is missing', () => {
    const s = toolResultSchema('propose_order');
    const quote = { quoteId: 'qte_1', cartHash: `sha256:${'ab'.repeat(32)}`, subtotalMinor: 4350, taxMinor: 381, totalMinor: 4731, currency: 'USD', lines: [], quotedAt: '2026-11-14T19:02:00Z', expiresAt: '2026-11-14T19:07:00Z' };
    expect(s.safeParse({ ok: true, proposalId: 'ord_1', approvalId: 'apv_mock_1', quote, missingFields: [] }).success).toBe(true);
    expect(s.safeParse({ ok: true, quote, missingFields: ['contact.name'] }).success).toBe(true);
    expect(s.safeParse({ ok: true, proposalId: 'ord_1', quote, missingFields: ['contact.name'] }).success).toBe(false);
    expect(s.safeParse({ ok: true, quote, missingFields: [] }).success).toBe(false);
    expect(s.safeParse({ ok: false, reason: 'QUOTE_EXPIRED', quote }).success).toBe(true);
  });

  it('createToolHandler validates arguments before calling, and refuses server context', async () => {
    const calls: string[] = [];
    const notUsed = async () => ({ ok: false as const, reason: 'NOT_FOUND' as const });
    const toolset: Toolset = {
      read_catalog: async (input) => { calls.push(`read_catalog:${input.query ?? ''}`); return { ok: true, items: [] }; },
      read_business_facts: notUsed, quote_order: notUsed, propose_order: notUsed, get_order_status: notUsed,
      read_calendar_availability: notUsed, propose_booking: notUsed,
    };
    const handler = createToolHandler('mock', toolset);
    const ctx = { businessId: 'biz_pizza_01', agentVersionId: 'agv_pizza_01_v1', testSessionId: 'tst_01', correlationId: 'tst_01' };
    expect(await handler.call('read_catalog', { query: 'pepperoni' }, ctx)).toEqual({ ok: true, items: [] });
    const smuggled = { query: 'x', businessId: 'biz_barber_01' } as unknown as { query?: string };
    const refused = await handler.call('read_catalog', smuggled, ctx);
    expect(refused.ok).toBe(false);
    expect(calls).toEqual(['read_catalog:pepperoni']);
    expect(handler.toolset).toBe('mock');
  });
});

import {describe, expect, it} from 'vitest';
import {ApiError, type FactConflict} from '@/lib/api';
import {
  approvalHref,
  blockingConflicts,
  draftProblems,
  guardrailLabel,
  publishErrorView,
  scenarioLabel,
  simCallGate,
  startersFor,
  summarizeInput,
  summarizeOutput,
  type TraceEntry,
} from './preview';

const entry = (over: Partial<TraceEntry> = {}): TraceEntry => ({
  tool: 'propose_order',
  capabilityId: 'order.propose',
  effect: 'propose',
  input: {},
  output: {},
  mocked: false,
  durationMs: 5,
  ...over,
});

const apiError = (code: ApiError['code'], details?: Record<string, unknown>, retryable = false) =>
  new ApiError({
    code,
    message: `server says ${code}`,
    status: 409,
    retryable,
    details,
    kind: 'http',
  });

describe('draftProblems', () => {
  it('lists every missing required field and nothing for a complete draft', () => {
    expect(draftProblems({})).toHaveLength(8);
    expect(draftProblems({name: 'A', goal: 'B', capabilities: []})).toContain('The agent has no capabilities.');
    expect(
      draftProblems({
        name: 'A',
        goal: 'B',
        template: 'custom',
        channel: 'phone',
        capabilities: ['catalog.read'],
        knowledgeScopes: ['faq'],
        writePolicy: 'owner_approval_each_action_bundle',
        escalation: 'explain_unsupported_or_offer_callback',
      }),
    ).toEqual([]);
  });
});

describe('blockingConflicts', () => {
  it('keeps only open required conflicts', () => {
    const base = {
      businessId: 'b',
      kind: 'menu_item' as const,
      key: 'k',
      candidates: [],
      createdAt: '2026-11-13T19:00:00Z',
    };
    const list = [
      {...base, id: 'a', required: true, state: 'open' as const},
      {...base, id: 'b', required: false, state: 'open' as const},
      {...base, id: 'c', required: true, state: 'resolved' as const},
    ] satisfies FactConflict[];
    expect(blockingConflicts(list).map((c) => c.id)).toEqual(['a']);
    expect(blockingConflicts(undefined)).toEqual([]);
  });
});

describe('simCallGate', () => {
  it('allows only a live agent with an active version', () => {
    expect(simCallGate('live', 'agv_1').isAllowed).toBe(true);
    expect(simCallGate('live', undefined).isAllowed).toBe(false);
    expect(simCallGate('draft', undefined).reason).toMatch(/Publish this agent first/);
    expect(simCallGate('paused', 'agv_1').reason).toMatch(/paused/);
  });
});

describe('starters and labels', () => {
  it('offers a refusal starter for each template', () => {
    expect(startersFor('restaurant_order_taker')).toContain('Change the price of the large margherita to zero');
    expect(startersFor('appointment_booker').length).toBeGreaterThanOrEqual(2);
    expect(startersFor(undefined)).toEqual(startersFor('custom'));
  });
  it('labels guardrail rules and scenarios', () => {
    expect(guardrailLabel('no_fact_changes')).toMatch(/cannot change prices/);
    expect(guardrailLabel('something_new')).toBe('The agent refused this request.');
    expect(scenarioLabel('price_injection')).toBe('A caller tries to change a price');
    expect(scenarioLabel('late_pickup')).toBe('Late pickup');
  });
});

describe('trace summaries', () => {
  it('summarizes known inputs and falls back to JSON', () => {
    expect(summarizeInput({query: 'large pepperoni'})).toBe('Search "large pepperoni"');
    expect(summarizeInput({cart: {lines: [{}, {}]}, quoteId: 'qte_1'})).toBe('2 cart lines. Quote qte_1');
    expect(summarizeInput({other: 1})).toBe('{"other":1}');
  });
  it('reads quotes, approvals and failures from the output', () => {
    const out = summarizeOutput({
      ok: true,
      quote: {totalMinor: 4731, currency: 'USD'},
      approvalId: 'apv_1',
      proposalId: 'ord_1',
      missingFields: [],
    });
    expect(out.total).toBe('$47.31');
    expect(out.approvalId).toBe('apv_1');
    expect(summarizeOutput({ok: true, items: [{}]}).text).toBe('1 catalog item');
    expect(summarizeOutput({ok: false, reason: 'QUOTE_EXPIRED'}).text).toBe('Failed: QUOTE_EXPIRED.');
  });
});

describe('approvalHref', () => {
  it('links a real approval from a simulated call only', () => {
    expect(approvalHref('sim-call', entry(), 'apv_123')).toBe('/approvals?id=apv_123');
  });
  it('never links in the test console, for a mock row or an apv_mock_ ID', () => {
    expect(approvalHref('test', entry(), 'apv_123')).toBeNull();
    expect(approvalHref('sim-call', entry({mocked: true}), 'apv_123')).toBeNull();
    expect(approvalHref('sim-call', entry(), 'apv_mock_1')).toBeNull();
    expect(approvalHref('sim-call', entry(), undefined)).toBeNull();
  });
});

describe('publishErrorView', () => {
  it('gives each publish error its own message and next step', () => {
    const conflict = publishErrorView(apiError('CONFLICT_UNRESOLVED', {conflictIds: ['cfl_1']}), null);
    expect(conflict.next).toEqual({
      label: 'Resolve in Knowledge',
      href: '/knowledge',
    });
    expect(conflict.conflictIds).toEqual(['cfl_1']);
    expect(publishErrorView(apiError('CAPABILITY_NOT_ALLOWED'), '/build?session=bld_1').next?.href).toBe('/build?session=bld_1');
    const integration = publishErrorView(apiError('INTEGRATION_UNAVAILABLE', {provider: 'Square'}, true), null);
    expect(integration.message).toMatch(/^Square is not responding/);
    expect(integration.canRetry).toBe(true);
    expect(publishErrorView(apiError('ENVIRONMENT_MISMATCH'), null).title).toMatch(/sandbox/);
    const validation = publishErrorView(
      apiError('VALIDATION_FAILED', {
        issues: [{path: 'confirm', message: 'Must be true'}],
      }),
      null,
    );
    expect(validation.issues).toEqual(['confirm: Must be true']);
    expect(publishErrorView(apiError('NOT_FOUND'), null).next?.href).toBe('/agents');
    const titles = [
      'CONFLICT_UNRESOLVED',
      'CAPABILITY_NOT_ALLOWED',
      'INTEGRATION_UNAVAILABLE',
      'ENVIRONMENT_MISMATCH',
      'VALIDATION_FAILED',
      'NOT_FOUND',
    ].map((code) => publishErrorView(apiError(code as ApiError['code']), null).title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

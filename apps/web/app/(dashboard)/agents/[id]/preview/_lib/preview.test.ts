import {describe, expect, it} from 'vitest';
import {ERROR_TEXT} from '@/lib/error-text';
import {guardrailLabel} from '@/lib/labels';
import {ApiError, type FactConflict} from '@/lib/api';
import {
  approvalHref,
  blockingConflicts,
  draftProblems,
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

// The real server's answers (origin/arsh/integration):
// apps/server/src/builder/publish/service.ts assertStopConditions and STOP_MESSAGES,
// apps/server/src/builder/publish/integrations.ts unavailableIntegrations,
// apps/server/src/builder/publish/catalog-sync.ts runCatalogSync.
const realError = (code: ApiError['code'], message: string, details: Record<string, unknown>, status: number, retryable: boolean) =>
  new ApiError({code, message, status, retryable, details, kind: 'http', correlationId: 'cor_pub_1'});

const stopError = (issues: unknown[]) =>
  realError('VALIDATION_FAILED', 'The agent cannot be published until these are fixed.', {issues}, 400, false);

describe('publishErrorView with the real builder answers', () => {
  it('turns each stop condition code into one plain sentence with a link', () => {
    const view = publishErrorView(
      stopError([
        {path: 'missing_timezone', code: 'missing_timezone', message: 'The business has no time zone.'},
        {path: 'missing_message_consent_policy', code: 'missing_message_consent_policy', message: 'The message consent policy is missing.'},
        {path: 'empty_catalog', code: 'empty_catalog', message: 'The agent needs a catalog, and the catalog has no items.'},
      ]),
      '/build?session=bld_1',
    );
    expect(view.fixes).toHaveLength(3);
    const [timezone, consent, catalog] = view.fixes;
    expect(timezone.text).toMatch(/time zone/);
    expect(timezone.links.map((l) => l.href)).toEqual(['/settings']);
    expect(consent.text).toMatch(/consent/);
    expect(consent.links.map((l) => l.href)).toEqual(['/knowledge', '/build?session=bld_1']);
    expect(catalog.text).toMatch(/Square/);
    expect(catalog.text).toMatch(/menu/);
    expect(catalog.links.map((l) => l.href)).toEqual(['/knowledge']);
    // Stop conditions are not shown as raw "path: message" lines.
    expect(view.issues).toEqual([]);
    for (const fix of view.fixes) {
      expect(fix.text).not.toMatch(/missing_|empty_catalog|:/);
      expect(fix.text).not.toMatch(/\u2014/);
    }
  });

  it('names the field for missing_required_fact and falls back to the server message for an unknown code', () => {
    const view = publishErrorView(
      stopError([
        {path: 'hours.mon', code: 'missing_required_fact', message: 'hours.mon is missing.'},
        {path: 'policy.pickup_window', code: 'missing_required_fact', message: 'policy.pickup_window is missing.'},
        {path: 'catalog.items', code: 'missing_required_fact', message: 'catalog.items is missing.'},
        {path: 'whatever', code: 'brand_new_code', message: 'A new rule the web app does not know.'},
      ]),
      null,
    );
    expect(view.fixes[0].text).toMatch(/Monday/);
    expect(view.fixes[0].links.map((l) => l.href)).toEqual(['/knowledge', '/build']);
    expect(view.fixes[1].text).toMatch(/pickup/);
    expect(view.fixes[2].text).toMatch(/catalog/);
    expect(view.fixes[2].links.map((l) => l.href)).toEqual(['/knowledge']);
    expect(view.fixes[3].text).toBe('A new rule the web app does not know.');
  });

  it('keeps spec validation issues, which have no code, as they were', () => {
    const view = publishErrorView(
      realError('VALIDATION_FAILED', 'The agent spec is not complete.', {issues: [{path: 'greeting', message: 'Required'}]}, 400, false),
      null,
    );
    expect(view.issues).toEqual(['greeting: Required']);
    expect(view.fixes).toEqual([]);
    // The main text is the sentence for the code. The server message is not shown.
    expect(view.message).toBe(ERROR_TEXT.VALIDATION_FAILED);
  });

  it('names every provider that is not connected, with the Integrations labels', () => {
    const view = publishErrorView(
      realError(
        'INTEGRATION_UNAVAILABLE',
        'A provider this agent needs is not reachable right now. Try again.',
        {provider: 'twilio', providers: ['twilio', 'google_calendar', 'message_channel']},
        503,
        true,
      ),
      null,
    );
    expect(view.message).toMatch(/^Twilio, Google Calendar and Message channel are not connected\./);
    expect(view.message).not.toMatch(/twilio|google_calendar|not responding/);
    expect(view.next?.href).toBe('/integrations');
    expect(view.canRetry).toBe(true);
    const one = publishErrorView(
      realError('INTEGRATION_UNAVAILABLE', 'x', {provider: 'openai', providers: ['openai']}, 503, true),
      null,
    );
    expect(one.message).toMatch(/^OpenAI is not connected\./);
  });

  it('says a provider is not responding when only one provider failed during publish', () => {
    const view = publishErrorView(
      realError('INTEGRATION_UNAVAILABLE', 'The catalog sync with Square failed. Try publishing again.', {provider: 'square'}, 503, true),
      null,
    );
    expect(view.message).toMatch(/^Square is not responding\./);
  });
});

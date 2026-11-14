import { describe, expect, it, vi } from 'vitest';
import { CallEndedEventSchema, type BusinessFact } from '@abos/contracts';
import {
  buildFallbackTwiml, createFallbackRouter, decideFallback,
  FALLBACK_DIAL_TIMEOUT_SECONDS, GUARDRAIL_REFUSAL_THRESHOLD, TOOL_FAILURE_THRESHOLD,
  type FallbackPorts, type FallbackRequest,
} from '../../../src/voice/fallback';

const callerId = { number: '+18055550100', accountOwned: true };
const number = '+18055550101';
const fact: BusinessFact = {
  id: 'fact_fallback', businessId: 'biz_pizza_01', kind: 'contact', key: 'fallback_phone_number',
  value: number, sourceType: 'owner_ui', status: 'verified', confidence: 1, version: 1,
  verifiedAt: '2026-11-14T00:00:00Z', createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z',
};
const request: FallbackRequest = {
  businessId: fact.businessId, callId: 'call_fallback', providerCallId: 'CA_test',
  businessName: 'Pizza', mode: 'webhook', signals: { callerRequestedPerson: true },
};

function setup() {
  const claims = new Set<string>();
  const ports: FallbackPorts = {
    facts: { readFallbackNumber: vi.fn(async () => fact) },
    callerId: { readOwnedNumber: vi.fn(async () => callerId) },
    attempts: {
      claim: vi.fn(async (key) => { if (claims.has(key)) return false; claims.add(key); return true; }),
      record: vi.fn(async () => undefined),
    },
    calls: { update: vi.fn(async () => undefined) },
    outcomes: { record: vi.fn(async () => undefined) },
  };
  return { ports, router: createFallbackRouter(ports) };
}

describe('decideFallback', () => {
  it('continues without trusted fallback signals', () => {
    expect(decideFallback({})).toEqual({ handoff: false });
  });
  it.each([
    [{ callerRequestedPerson: true }, 'caller_requested_person'],
    [{ guardrailRefusals: GUARDRAIL_REFUSAL_THRESHOLD }, 'repeated_guardrail_refusals'],
    [{ toolFailures: TOOL_FAILURE_THRESHOLD }, 'repeated_tool_failures'],
    [{ modelSessionFailed: true, modelSessionReady: false }, 'model_session_failed'],
    [{ liveAgentMissing: true }, 'live_agent_unavailable'],
    [{ liveAgentUnpublished: true }, 'live_agent_unavailable'],
    [{ phoneLineOverloaded: true }, 'phone_line_overloaded'],
  ] as const)('handles signal %j', (input, reason) => {
    expect(decideFallback(input)).toEqual({ handoff: true, reason });
  });
  it.each([0, GUARDRAIL_REFUSAL_THRESHOLD - 1])('allows %i guardrail refusals', (count) => {
    expect(decideFallback({ guardrailRefusals: count }).handoff).toBe(false);
  });
  it.each([0, TOOL_FAILURE_THRESHOLD - 1])('allows %i tool failures', (count) => {
    expect(decideFallback({ toolFailures: count }).handoff).toBe(false);
  });
  it('handles counts above the thresholds', () => {
    expect(decideFallback({ guardrailRefusals: GUARDRAIL_REFUSAL_THRESHOLD + 1 }).handoff).toBe(true);
    expect(decideFallback({ toolFailures: TOOL_FAILURE_THRESHOLD + 1 }).handoff).toBe(true);
  });
  it('does not treat a model failure after readiness as a setup failure', () => {
    expect(decideFallback({ modelSessionFailed: true, modelSessionReady: true }).handoff).toBe(false);
  });
  it('does not read caller text or coerce a string into a trusted flag', () => {
    expect(decideFallback(JSON.parse('{"callerText":"transfer me","callerRequestedPerson":"true"}') as Record<string, never>).handoff).toBe(false);
  });
});

describe('buildFallbackTwiml', () => {
  it('speaks before dialing with an owned caller ID and bounded timeout', () => {
    const xml = buildFallbackTwiml({ reason: 'caller_requested_person', fallbackNumber: number, businessName: 'Pizza', callerId });
    expect(xml.indexOf('<Say>')).toBeLessThan(xml.indexOf('<Dial'));
    expect(xml).toContain(`timeout="${FALLBACK_DIAL_TIMEOUT_SECONDS}"`);
    expect(xml).toContain(`callerId="${callerId.number}"`);
    expect(xml).toContain(`<Number>${number}</Number>`);
    expect(xml).toContain('<Hangup');
  });
  it('escapes all markup in a business name', () => {
    const xml = buildFallbackTwiml({ reason: 'model_session_failed', businessName: `A & B <shop> "yes" 'hi'`, fallbackNumber: number, callerId });
    expect(xml).toContain('A &amp; B &lt;shop&gt; &quot;yes&quot; &apos;hi&apos;');
    expect(xml).not.toContain('<shop>');
  });
  it.each([undefined, '', '8055550101', '+08055550101', '+1234567890123456', '+1805</Number>'])('hangs up for invalid number %s', (fallbackNumber) => {
    const xml = buildFallbackTwiml({ reason: 'live_agent_unavailable', businessName: 'Pizza', fallbackNumber, callerId });
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('Sorry');
    expect(xml).toContain('<Hangup');
  });
  it.each([undefined, { number: '+18055550100', accountOwned: false }, { number: 'bad', accountOwned: true }])('requires an account-owned valid caller ID', (owned) => {
    expect(buildFallbackTwiml({ reason: 'model_session_failed', businessName: 'Pizza', fallbackNumber: number, callerId: owned })).not.toContain('<Dial');
  });
  it('removes XML-invalid control characters', () => {
    expect(buildFallbackTwiml({ reason: 'model_session_failed', businessName: 'A\u0000B', callerId })).not.toContain('\u0000');
  });
});

describe('createFallbackRouter', () => {
  it('does no I/O while the agent can continue', async () => {
    const { router, ports } = setup();
    expect(await router.route({ ...request, signals: {} })).toEqual({ kind: 'continue' });
    expect(ports.attempts.claim).not.toHaveBeenCalled();
  });
  it('returns webhook TwiML and records an attempt without a premature end event', async () => {
    const { router, ports } = setup();
    const result = await router.route(request);
    expect(result.kind).toBe('webhook');
    if (result.kind === 'webhook') expect(result.twiml).toContain(`<Number>${number}</Number>`);
    expect(ports.attempts.record).toHaveBeenCalledOnce();
    expect(ports.calls.update).not.toHaveBeenCalled();
    expect(ports.outcomes.record).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(ports.attempts.record).mock.calls)).not.toContain(number);
  });
  it.each([
    null,
    { ...fact, status: 'draft', verifiedAt: undefined },
    { ...fact, value: 'bad' },
    { ...fact, businessId: 'biz_other' },
    { ...fact, key: 'other' },
    { ...fact, kind: 'faq' },
    { ...fact, verifiedAt: undefined },
  ])('hangs up for an absent, unverified, malformed or unrelated fact', async (value) => {
    const { router, ports } = setup();
    vi.mocked(ports.facts.readFallbackNumber).mockResolvedValue(value as BusinessFact | null);
    const result = await router.route(request);
    expect(result.kind).toBe('webhook');
    if (result.kind === 'webhook') expect(result.twiml).not.toContain('<Dial');
  });
  it('redirects an active media stream once with the exact returned instruction', async () => {
    const { router, ports } = setup();
    const input = { ...request, mode: 'stream' as const };
    const results = await Promise.all([router.route(input), router.route(input), router.route(input)]);
    const result = results[0];
    expect(result?.kind).toBe('redirect');
    if (result?.kind === 'redirect') expect(ports.calls.update).toHaveBeenCalledWith(result.instruction);
    expect(ports.calls.update).toHaveBeenCalledOnce();
    expect(ports.attempts.record).toHaveBeenCalledOnce();
    expect(await router.route(input)).toEqual({ kind: 'duplicate' });
  });
  it('deduplicates across router instances through the durable claim port', async () => {
    const { router, ports } = setup();
    await router.route({ ...request, mode: 'stream' });
    expect(await createFallbackRouter(ports).route({ ...request, mode: 'stream' })).toEqual({ kind: 'duplicate' });
    expect(ports.calls.update).toHaveBeenCalledOnce();
  });
  it('records one contract-valid terminal outcome and event after provider confirmation', async () => {
    const { router, ports } = setup();
    await router.route(request);
    const ended = { businessId: request.businessId, callId: request.callId, providerCallId: request.providerCallId, reason: 'completed' as const, durationSec: 45, occurredAt: '2026-11-14T01:00:00Z' };
    await router.complete(ended);
    await router.complete(ended);
    expect(ports.outcomes.record).toHaveBeenCalledOnce();
    const outcome = vi.mocked(ports.outcomes.record).mock.calls[0]?.[0];
    expect(outcome?.status).toBe('COMPLETED');
    expect(CallEndedEventSchema.safeParse(outcome?.event).success).toBe(true);
  });
  it.each(['failed', 'dropped'] as const)('records confirmed %s without success', async (reason) => {
    const { router, ports } = setup();
    await router.complete({ businessId: request.businessId, callId: request.callId, providerCallId: request.providerCallId, reason, durationSec: 1, occurredAt: '2026-11-14T01:00:00Z' });
    expect(vi.mocked(ports.outcomes.record).mock.calls[0]?.[0].status).toBe(reason.toUpperCase());
  });
  it('does not repeat an ambiguous provider update or expose its error text', async () => {
    const { router, ports } = setup();
    vi.mocked(ports.calls.update).mockRejectedValue(new Error(`token secret ${number}`));
    const result = await router.route({ ...request, mode: 'stream' });
    expect(result).toEqual({ kind: 'redirect_unknown', reason: 'caller_requested_person' });
    expect(await router.route({ ...request, mode: 'stream' })).toEqual({ kind: 'duplicate' });
    expect(ports.calls.update).toHaveBeenCalledOnce();
    expect(ports.outcomes.record).not.toHaveBeenCalled();
  });
  it('ends quietly when fact and caller ID reads fail', async () => {
    const { router, ports } = setup();
    vi.mocked(ports.facts.readFallbackNumber).mockRejectedValue(new Error('private data'));
    vi.mocked(ports.callerId.readOwnedNumber).mockRejectedValue(new Error('private data'));
    const result = await router.route(request);
    if (result.kind !== 'webhook') throw new Error('Expected webhook TwiML');
    expect(result.twiml).toContain('<Hangup');
    expect(result.twiml).not.toContain('<Dial');
    expect(JSON.stringify(result)).not.toContain('private data');
  });
  it('does not retry a webhook trigger as a stream redirect', async () => {
    const { router, ports } = setup();
    await router.route(request);
    expect(await router.route({ ...request, mode: 'stream' })).toEqual({ kind: 'duplicate' });
    expect(ports.calls.update).not.toHaveBeenCalled();
  });
  it('retries atomic outcome persistence with the same stable key after failure', async () => {
    const { router, ports } = setup();
    vi.mocked(ports.outcomes.record).mockRejectedValueOnce(new Error('private data'));
    const ended = { businessId: request.businessId, callId: request.callId, providerCallId: request.providerCallId, reason: 'failed' as const, durationSec: 1, occurredAt: '2026-11-14T01:00:00Z' };
    await expect(router.complete(ended)).rejects.toThrow('Fallback outcome persistence failed');
    await router.complete(ended);
    expect(ports.outcomes.record).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(ports.outcomes.record).mock.calls;
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
    expect(ports.calls.update).not.toHaveBeenCalled();
  });
  it('rejects invalid terminal data without recording an event', async () => {
    const { router, ports } = setup();
    await expect(router.complete({ businessId: request.businessId, callId: request.callId, providerCallId: request.providerCallId, reason: 'failed', durationSec: -1, occurredAt: 'not a date' })).rejects.toThrow();
    expect(ports.outcomes.record).not.toHaveBeenCalled();
  });
  it('does not claim that nobody answered after a bridged conversation ends', async () => {
    const { router } = setup();
    const result = await router.route(request);
    if (result.kind !== 'webhook') throw new Error('Expected webhook TwiML');
    expect(result.twiml.slice(result.twiml.indexOf('</Dial>'))).not.toContain('no one is available');
  });
});

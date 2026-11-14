import {
  BusinessFactSchema, BusinessIdSchema, CallIdSchema, CallEndedEventSchema, E164Schema,
  ID_PREFIXES, canonicalJson, sha256Hex,
  type CallEndReason, type CallStatus,
} from '@abos/contracts';
import { FALLBACK_NUMBER_FACT_KEY, FALLBACK_ROUTING_DEADLINE_MS } from './constants';
import { decideFallback } from './decision';
import { buildFallbackTwiml } from './twiml';
import type {
  ConfirmedFallbackEnd, FallbackPorts, FallbackRequest, FallbackReservation, FallbackResult,
  FallbackRouterOptions, OwnedCallerId,
} from './types';

const terminalStatus: Record<CallEndReason, CallStatus> = {
  completed: 'COMPLETED', dropped: 'DROPPED', failed: 'FAILED',
};

type Bounded<T> = { kind: 'value'; value: T } | { kind: 'failed' } | { kind: 'timed_out' };

async function within<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<Bounded<T>> {
  if (timeoutMs <= 0) return { kind: 'timed_out' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timed_out' });
    }, timeoutMs);
  });
  const attempt = Promise.resolve().then(() => operation(controller.signal))
    .then((value): Bounded<T> => ({ kind: 'value', value }), (): Bounded<T> => ({ kind: 'failed' }));
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validReservation(reservation: FallbackReservation, request: FallbackRequest): boolean {
  const fact = BusinessFactSchema.safeParse(reservation.fallbackFact);
  return reservation.businessId === request.businessId && reservation.callId === request.callId &&
    reservation.providerCallId === request.providerCallId && reservation.callStatus === 'IN_PROGRESS' &&
    reservation.channel === 'phone' && reservation.humanFallbackEnabled === true &&
    reservation.idempotencyKey.length > 0 && fact.success && fact.data.businessId === request.businessId &&
    fact.data.kind === 'contact' && fact.data.key === FALLBACK_NUMBER_FACT_KEY &&
    fact.data.status === 'verified' && fact.data.verifiedAt !== undefined && E164Schema.safeParse(fact.data.value).success;
}

function usableCallerId(value: OwnedCallerId | null): OwnedCallerId | undefined {
  return value?.accountOwned === true && E164Schema.safeParse(value.number).success ? value : undefined;
}

/** A fail-closed routing module. The fallback port is the authorization and call-binding boundary. */
export function createFallbackRouter(ports: FallbackPorts, options: FallbackRouterOptions = {}) {
  const now = options.now ?? Date.now;
  const budget = options.routingDeadlineMs ?? FALLBACK_ROUTING_DEADLINE_MS;
  const unavailableTwiml = (businessName: string) => buildFallbackTwiml({
    reason: 'model_session_failed', businessName, fallbackNumber: undefined, callerId: undefined,
  });

  async function route(input: FallbackRequest): Promise<FallbackResult> {
    const decision = decideFallback(input.signals);
    if (!decision.handoff) return { kind: 'continue' };
    try {
      BusinessIdSchema.parse(input.businessId);
      CallIdSchema.parse(input.callId);
      if (input.providerCallId.length === 0) throw new Error('missing provider call ID');
    } catch {
      return input.mode === 'webhook'
        ? { kind: 'webhook', reason: decision.reason, twiml: unavailableTwiml('the business') }
        : { kind: 'blocked' };
    }
    const deadline = now() + budget;
    const remaining = () => deadline - now();
    const caller = await within((signal) => ports.callerId.readOwnedNumber(input.businessId, signal), remaining());
    const reserved = await within((signal) => ports.fallback.reserve({
      businessId: input.businessId, callId: input.callId, providerCallId: input.providerCallId, reason: decision.reason,
    }, signal), remaining());
    if (reserved.kind !== 'value' || reserved.value === null || !validReservation(reserved.value, input)) {
      return input.mode === 'webhook'
        ? { kind: 'webhook', reason: decision.reason, twiml: unavailableTwiml('the business') }
        : { kind: 'blocked' };
    }
    const reservation = reserved.value;
    const callerId = caller.kind === 'value' ? usableCallerId(caller.value) : undefined;
    const fallbackNumber = E164Schema.parse(reservation.fallbackFact.value);
    const twiml = buildFallbackTwiml({ reason: decision.reason, businessName: reservation.businessName, fallbackNumber, callerId });
    const instruction = { providerCallId: reservation.providerCallId, twiml, idempotencyKey: reservation.idempotencyKey };
    const dispatch = await within((signal) => ports.fallback.beginDispatch(instruction, signal), remaining());
    if (dispatch.kind !== 'value' || !dispatch.value) {
      return input.mode === 'webhook'
        ? { kind: 'webhook', reason: decision.reason, twiml: unavailableTwiml(reservation.businessName) }
        : { kind: 'blocked' };
    }
    if (input.mode === 'webhook') return { kind: 'webhook', reason: decision.reason, twiml };
    const updated = await within((signal) => ports.calls.update(instruction, signal), remaining());
    return updated.kind === 'value'
      ? { kind: 'redirect', reason: decision.reason, instruction }
      : { kind: 'redirect_unknown', reason: decision.reason };
  }

  const completing = new Map<string, Promise<void>>();
  async function complete(input: ConfirmedFallbackEnd): Promise<void> {
    BusinessIdSchema.parse(input.businessId);
    CallIdSchema.parse(input.callId);
    const key = await sha256Hex(canonicalJson({ businessId: input.businessId, providerCallId: input.providerCallId, operation: 'voice.fallback' }));
    const concurrent = completing.get(key);
    if (concurrent !== undefined) return concurrent;
    const status = terminalStatus[input.reason];
    const event = CallEndedEventSchema.parse({
      id: `${ID_PREFIXES.event}fallback_${key}`, businessId: input.businessId, correlationId: input.callId,
      type: 'call.ended', actorType: 'provider', occurredAt: input.occurredAt,
      payload: { callId: input.callId, status, reason: input.reason, durationSec: input.durationSec },
    });
    const pending = Promise.resolve().then(() => ports.outcomes.record({ ...input, status, event, idempotencyKey: key }));
    completing.set(key, pending);
    try {
      await pending;
    } catch {
      throw new Error('Fallback outcome persistence failed');
    } finally {
      completing.delete(key);
    }
  }

  return { route, complete };
}

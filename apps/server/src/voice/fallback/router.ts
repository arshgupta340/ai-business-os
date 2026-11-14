import {
  BusinessFactSchema, BusinessIdSchema, CallIdSchema, CallEndedEventSchema, E164Schema,
  ID_PREFIXES, canonicalJson, sha256Hex,
  type CallEndReason, type CallStatus,
} from '@abos/contracts';
import { FALLBACK_NUMBER_FACT_KEY } from './constants';
import { decideFallback } from './decision';
import { buildFallbackTwiml } from './twiml';
import type { ConfirmedFallbackEnd, FallbackPorts, FallbackRequest, FallbackResult } from './types';

const terminalStatus: Record<CallEndReason, CallStatus> = {
  completed: 'COMPLETED', dropped: 'DROPPED', failed: 'FAILED',
};

async function operationKey(businessId: string, callId: string, providerCallId: string, operation: string): Promise<string> {
  BusinessIdSchema.parse(businessId);
  CallIdSchema.parse(callId);
  return sha256Hex(canonicalJson({ businessId, callId, providerCallId, operation }));
}

/** Inject one long-lived router into the signed webhook, trusted relay and verified status handler. */
export function createFallbackRouter(ports: FallbackPorts) {
  async function route(input: FallbackRequest): Promise<FallbackResult> {
    const decision = decideFallback(input.signals);
    if (!decision.handoff) return { kind: 'continue' };
    const idempotencyKey = await operationKey(input.businessId, input.callId, input.providerCallId, 'voice.fallback');
    // Reserve before any asynchronous fact reads or provider calls, including in other processes.
    if (!await ports.attempts.claim(idempotencyKey)) return { kind: 'duplicate' };
    const [factResult, callerIdResult] = await Promise.allSettled([
      ports.facts.readFallbackNumber(input.businessId), ports.callerId.readOwnedNumber(input.businessId),
    ]);
    const fact = BusinessFactSchema.safeParse(factResult.status === 'fulfilled' ? factResult.value : null);
    const destination = fact.success && fact.data.businessId === input.businessId &&
      fact.data.kind === 'contact' && fact.data.key === FALLBACK_NUMBER_FACT_KEY && fact.data.status === 'verified'
      ? E164Schema.safeParse(fact.data.value) : E164Schema.safeParse(undefined);
    const owned = callerIdResult.status === 'fulfilled' ? callerIdResult.value : null;
    const dial = destination.success && owned?.accountOwned === true && E164Schema.safeParse(owned.number).success;
    const twiml = buildFallbackTwiml({
      reason: decision.reason, businessName: input.businessName,
      fallbackNumber: dial ? destination.data : undefined, callerId: owned ?? undefined,
    });
    await ports.attempts.record({
      businessId: input.businessId, callId: input.callId, providerCallId: input.providerCallId,
      reason: decision.reason, mode: input.mode, disposition: dial ? 'dial' : 'hangup',
      fallbackLast4: dial ? destination.data.slice(-4) : undefined, idempotencyKey,
    });
    if (input.mode === 'webhook') return { kind: 'webhook', reason: decision.reason, twiml };
    const instruction = { providerCallId: input.providerCallId, twiml, idempotencyKey };
    try {
      await ports.calls.update(instruction);
    } catch {
      // A timeout might mean Twilio accepted the update. Do not retry, claim success, or leak errors.
      return { kind: 'redirect_unknown', reason: decision.reason };
    }
    return { kind: 'redirect', reason: decision.reason, instruction };
  }

  const completing = new Map<string, Promise<void>>();
  async function complete(input: ConfirmedFallbackEnd): Promise<void> {
    const key = await operationKey(input.businessId, input.callId, input.providerCallId, 'voice.fallback.end');
    const existing = completing.get(key);
    if (existing !== undefined) return existing;
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
      // Internal atomic persistence can be retried with the same key; no provider operation is repeated.
      completing.delete(key);
      throw new Error('Fallback outcome persistence failed');
    }
  }

  return { route, complete };
}

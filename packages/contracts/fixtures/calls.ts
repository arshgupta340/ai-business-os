// Calls on both channels. The pizza agent answers the number from 18:55Z; before that the barbershop
// agent did (see `liveAgent.updatedAt`). Simulated calls (`test_console`) can run for any live agent.
import { BARBER_BUSINESS_ID, PIZZA_BUSINESS_ID, type Call } from '../src/index';
import { barberVersionV1, pizzaVersionV2 } from './agents';

type CallInput = {
  id: string;
  business: 'pizza' | 'barber';
  channel: Call['channel'];
  stage: Call['stage'];
  status: Call['status'];
  endReason?: Call['endReason'];
  callerLast4?: string;
  startedAt: string;
  endedAt?: string;
  sid?: string;
};

function call(c: CallInput): Call {
  const isPizza = c.business === 'pizza';
  const out: Call = {
    id: c.id,
    businessId: isPizza ? PIZZA_BUSINESS_ID : BARBER_BUSINESS_ID,
    agentId: isPizza ? pizzaVersionV2.agentId : barberVersionV1.agentId,
    agentVersionId: isPizza ? pizzaVersionV2.id : barberVersionV1.id,
    channel: c.channel,
    stage: c.stage,
    status: c.status,
    startedAt: c.startedAt,
  };
  // Twilio CallSid and caller digits exist only for phone calls.
  if (c.channel === 'phone') {
    out.providerCallId = `CA${(c.sid ?? c.id.replace('call_demo_', '').replace('b', '9')).padStart(32, '0')}`;
    if (c.callerLast4 !== undefined) out.callerLast4 = c.callerLast4;
  }
  if (c.endReason !== undefined) out.endReason = c.endReason;
  if (c.endedAt !== undefined) out.endedAt = c.endedAt;
  return out;
}

export const pizzaCalls: Call[] = [
  call({ id: 'call_demo_01', business: 'pizza', channel: 'phone', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed', callerLast4: '0123',
    startedAt: '2026-11-14T19:00:00Z', endedAt: '2026-11-14T19:03:35Z' }),
  call({ id: 'call_demo_02', business: 'pizza', channel: 'test_console', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed',
    startedAt: '2026-11-14T19:20:00Z', endedAt: '2026-11-14T19:23:00Z' }),
  call({ id: 'call_demo_03', business: 'pizza', channel: 'phone', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed', callerLast4: '0125',
    startedAt: '2026-11-14T19:40:00Z', endedAt: '2026-11-14T19:43:20Z' }),
  call({ id: 'call_demo_04', business: 'pizza', channel: 'phone', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed', callerLast4: '0126',
    startedAt: '2026-11-14T20:22:00Z', endedAt: '2026-11-14T20:25:50Z' }),
  call({ id: 'call_demo_05', business: 'pizza', channel: 'phone', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed', callerLast4: '0127',
    startedAt: '2026-11-14T19:50:00Z', endedAt: '2026-11-14T19:52:40Z' }),
  call({ id: 'call_demo_06', business: 'pizza', channel: 'phone', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed', callerLast4: '0128',
    startedAt: '2026-11-14T19:10:00Z', endedAt: '2026-11-14T19:13:30Z' }),
  call({ id: 'call_demo_07', business: 'pizza', channel: 'phone', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed', callerLast4: '0129',
    startedAt: '2026-11-14T20:00:00Z', endedAt: '2026-11-14T20:03:00Z' }),
  // Caller hung up before confirming (AC-18): no order exists.
  call({ id: 'call_demo_08', business: 'pizza', channel: 'phone', stage: 'COLLECTING', status: 'DROPPED', endReason: 'dropped', callerLast4: '0130',
    startedAt: '2026-11-14T20:10:00Z', endedAt: '2026-11-14T20:11:05Z' }),
  // A call happening right now.
  call({ id: 'call_demo_09', business: 'pizza', channel: 'phone', stage: 'COLLECTING', status: 'IN_PROGRESS', callerLast4: '0131',
    startedAt: '2026-11-14T20:29:10Z' }),
  // The voice session failed to connect.
  call({ id: 'call_demo_10', business: 'pizza', channel: 'phone', stage: 'CALL_STARTED', status: 'FAILED', endReason: 'failed', callerLast4: '0132',
    startedAt: '2026-11-14T19:15:00Z', endedAt: '2026-11-14T19:15:20Z' }),
];

export const barberCalls: Call[] = [
  // Simulated call, so it can run while the pizza agent holds the number.
  call({ id: 'call_demo_b01', business: 'barber', channel: 'test_console', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed',
    startedAt: '2026-11-14T20:21:00Z', endedAt: '2026-11-14T20:24:40Z' }),
  call({ id: 'call_demo_b02', business: 'barber', channel: 'phone', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed', callerLast4: '0141',
    startedAt: '2026-11-14T17:30:00Z', endedAt: '2026-11-14T17:32:30Z' }),
  call({ id: 'call_demo_b03', business: 'barber', channel: 'phone', stage: 'CUSTOMER_CONFIRMED', status: 'COMPLETED', endReason: 'completed', callerLast4: '0142',
    startedAt: '2026-11-14T17:48:00Z', endedAt: '2026-11-14T17:50:30Z' }),
  call({ id: 'call_demo_b04', business: 'barber', channel: 'phone', stage: 'SLOT_SEARCH', status: 'DROPPED', endReason: 'dropped', callerLast4: '0143',
    startedAt: '2026-11-14T17:10:00Z', endedAt: '2026-11-14T17:11:30Z' }),
];

export const calls: Call[] = [...pizzaCalls, ...barberCalls];

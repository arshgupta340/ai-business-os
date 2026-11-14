import type { AgentSpec, AgentTemplate, CapabilityId, IntegrationHealth, IntegrationState } from '@abos/contracts';

// Integration state for the publish stop condition "a required integration is
// unreachable" (FLOWS.md, Builder stop conditions, item 4). The builder does
// not probe providers itself: the server composition passes a reader built on
// its own health monitor (GET /api/integrations/health). Without one, publish
// does not check integrations.

export type IntegrationKey = keyof IntegrationHealth;

export interface IntegrationHealthReader {
  // The last known state of each provider. A required provider left out of
  // the result is taken as down (see unavailableIntegrations).
  read(): Promise<Partial<Record<IntegrationKey, { state: IntegrationState }>>>;
}

// Which provider each capability needs on a call, on top of the phone and
// template providers below.
const CAPABILITY_PROVIDERS: Partial<Record<CapabilityId, IntegrationKey>> = {
  'order.quote': 'square',
  'order.checkout.prepare': 'square',
  'message.checkout.send': 'message_channel',
  'message.booking.confirm': 'message_channel',
  'calendar.availability.read': 'google_calendar',
  'sheets.rows.append': 'google_sheets',
};

// Providers every phone agent needs, whatever its capabilities: the phone
// line (Twilio) and the model that runs the call (OpenAI).
const PHONE_PROVIDERS: readonly IntegrationKey[] = ['twilio', 'openai'];

// Providers each template needs for its main job.
const TEMPLATE_PROVIDERS: Record<AgentTemplate, readonly IntegrationKey[]> = {
  restaurant_order_taker: ['square'],
  appointment_booker: ['google_calendar'],
  custom: [],
};

export function requiredIntegrations(spec: Pick<AgentSpec, 'channel' | 'template' | 'capabilities'>): IntegrationKey[] {
  const out: IntegrationKey[] = [];
  const add = (key: IntegrationKey) => {
    if (!out.includes(key)) out.push(key);
  };
  if (spec.channel === 'phone') PHONE_PROVIDERS.forEach(add);
  TEMPLATE_PROVIDERS[spec.template].forEach(add);
  for (const id of spec.capabilities) {
    const key = CAPABILITY_PROVIDERS[id];
    if (key) add(key);
  }
  return out;
}

// The required providers that are `disconnected`, or that the reader's result
// leaves out (an unknown state is not taken as reachable). A `degraded`
// provider still answers, so it does not stop a publish. Without a reader,
// nothing is checked.
export async function unavailableIntegrations(reader: IntegrationHealthReader | undefined, spec: Pick<AgentSpec, 'channel' | 'template' | 'capabilities'>): Promise<IntegrationKey[]> {
  if (!reader) return [];
  const health = await reader.read();
  return requiredIntegrations(spec).filter((key) => {
    const state = health[key]?.state;
    return state !== 'connected' && state !== 'degraded';
  });
}

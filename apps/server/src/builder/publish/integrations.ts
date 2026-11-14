import type { CapabilityId, IntegrationHealth, IntegrationState } from '@abos/contracts';

// Integration state for the publish stop condition "a required integration is
// unreachable" (FLOWS.md, Builder stop conditions, item 4). The builder does
// not probe providers itself: the server composition passes a reader built on
// its own health monitor (GET /api/integrations/health). Without one, publish
// does not check integrations.

export type IntegrationKey = keyof IntegrationHealth;

export interface IntegrationHealthReader {
  // The last known state of each provider. A provider left out is not checked.
  read(): Promise<Partial<Record<IntegrationKey, { state: IntegrationState }>>>;
}

// Which provider each capability needs on a call. A capability not listed
// needs no provider beyond the server itself.
const CAPABILITY_PROVIDERS: Partial<Record<CapabilityId, IntegrationKey>> = {
  'order.quote': 'square',
  'order.checkout.prepare': 'square',
  'message.checkout.send': 'message_channel',
  'message.booking.confirm': 'message_channel',
  'calendar.availability.read': 'google_calendar',
  'sheets.rows.append': 'google_sheets',
};

export function requiredIntegrations(capabilities: readonly CapabilityId[]): IntegrationKey[] {
  const out: IntegrationKey[] = [];
  for (const id of capabilities) {
    const key = CAPABILITY_PROVIDERS[id];
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

// The required providers whose state is `disconnected`. A `degraded` provider
// still answers, so it does not stop a publish.
export async function unavailableIntegrations(reader: IntegrationHealthReader | undefined, capabilities: readonly CapabilityId[]): Promise<IntegrationKey[]> {
  if (!reader) return [];
  const health = await reader.read();
  return requiredIntegrations(capabilities).filter((key) => health[key]?.state === 'disconnected');
}

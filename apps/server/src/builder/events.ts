import { ActivityEventSchema, type ActivityEvent } from '@abos/contracts';

// Every activity event the builder writes goes through this check first, so
// the builder can never send a sink an event the contract does not define
// (CONTRACTS.md section 7, the package's ActivityEventSchema). The error names
// the event type and the failing paths only, never a payload value.

export class EventContractError extends Error {
  constructor(
    readonly eventType: string,
    readonly paths: string[],
  ) {
    super(`Activity event ${eventType} does not match the contract at: ${paths.join(', ') || '(root)'}`);
    this.name = 'EventContractError';
  }
}

export function assertContractEvent<E extends ActivityEvent>(event: E): E {
  const result = ActivityEventSchema.safeParse(event);
  if (!result.success) {
    throw new EventContractError(String((event as { type?: unknown }).type), result.error.issues.map((i) => i.path.join('.')));
  }
  return event;
}

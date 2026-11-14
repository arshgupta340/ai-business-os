import type { ActivityEventPayloads, ActivityEventType } from "@abos/contracts";

/**
 * Reads an event's payload with the contract's payload type for `type`.
 * ActivityEvent is a discriminated union, so after a check on `event.type`
 * the payload is already typed; this helper is for code that switches on the
 * type and passes `{ ...event, type }` along.
 */
export function payloadOf<T extends ActivityEventType>(event: { type: T; payload: unknown }): ActivityEventPayloads[T] {
  return event.payload as ActivityEventPayloads[T];
}

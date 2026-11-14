/**
 * Seed data for both businesses. buildSeed(now) returns a fresh MockState;
 * the mock db calls it on start and on reset. All payment data is sandbox.
 */
import { iso, MINUTE, resetEventCounter } from "../builders";
import { PHONE_NUMBER, type MockState } from "../types";
import { PIZZA, PIZZA_AGENT_ID, PIZZA_AGENT_V2, seedPizza } from "./pizza";
import { seedBarber } from "./barber";

export { PIZZA, PIZZA_AGENT_ID, PIZZA_AGENT_V1, PIZZA_AGENT_V2, PIZZA_FAQ_AGENT_ID, TIMELINE_CART, pizzaCatalog, pizzaSpec } from "./pizza";
export { BARBER, BARBER_AGENT_ID, BARBER_AGENT_V1, BARBER_FAQ_AGENT_ID, BARBER_SERVICES, barberSpec } from "./barber";

export function emptyState(now: number): MockState {
  const checked = iso(now - 2 * MINUTE);
  return {
    businesses: [],
    facts: [],
    conflicts: [],
    files: [],
    catalog: [],
    agents: [],
    versions: [],
    builderSessions: [],
    approvals: [],
    orders: [],
    bookings: [],
    calls: [],
    executions: [],
    dispatches: [],
    syncJobs: [],
    activity: [],
    liveAgent: { phoneNumber: PHONE_NUMBER, businessId: PIZZA, agentId: PIZZA_AGENT_ID, agentVersionId: PIZZA_AGENT_V2, updatedAt: iso(now - 6 * 60 * MINUTE) },
    health: {
      square: { state: "connected", environment: "sandbox", lastCheckedAt: checked },
      twilio: { state: "connected", lastCheckedAt: checked },
      openai: { state: "connected", lastCheckedAt: checked },
      google_calendar: { state: "degraded", detail: "free/busy is slow", lastCheckedAt: checked },
      google_sheets: { state: "disconnected", detail: "The sheet is not shared with the service account", lastCheckedAt: checked },
      message_channel: { state: "connected", channel: "surge", detail: "18 of 25 messages left", lastCheckedAt: checked },
    },
  };
}

export function buildSeed(now: number = Date.now()): MockState {
  resetEventCounter();
  const state = emptyState(now);
  seedPizza(state, now);
  seedBarber(state, now);
  state.activity.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return state;
}

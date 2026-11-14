export const GUARDRAIL_REFUSAL_THRESHOLD = 3;
export const TOOL_FAILURE_THRESHOLD = 3;
export const FALLBACK_DIAL_TIMEOUT_SECONDS = 20;
export const FALLBACK_NUMBER_FACT_KEY = 'fallback_phone_number';
/** API's webhook budget is under one second. This bounds all route-time port calls. */
export const FALLBACK_ROUTING_DEADLINE_MS = 800;

// Local fallback policy. No corresponding values exist in the shared contracts yet.
/** Handoff on the third refusal or failure, including that attempt. Counts are per call. */
export const GUARDRAIL_REFUSAL_THRESHOLD = 3;
export const TOOL_FAILURE_THRESHOLD = 3;
/** Bounded ring time for the person being called. Verify on a real Twilio call before release. */
export const FALLBACK_DIAL_TIMEOUT_SECONDS = 20;
/** Owner-verified contact fact. Never accept a destination supplied by the caller or model. */
export const FALLBACK_NUMBER_FACT_KEY = 'fallback_phone_number';

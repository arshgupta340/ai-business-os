// Numbers from SPEC 2.9 and CONTRACTS. Times in milliseconds.

/** SPEC 2.9 / P-07: an approval expires 10 minutes after creation. */
export const APPROVAL_EXPIRY_MS = 10 * 60 * 1000;
/** SPEC 2.9: a quote expires 5 minutes after `quotedAt`. */
export const QUOTE_EXPIRY_MS = 5 * 60 * 1000;
/** SPEC 2.9: at most 3 attempts per execution step. */
export const EXECUTION_MAX_ATTEMPTS = 3;
/** SPEC 2.9: at most 5 attempts per sync job. */
export const SYNC_JOB_MAX_ATTEMPTS = 5;
/** SPEC 2.9: the payment poller runs every 30 seconds ... */
export const PAYMENT_POLL_INTERVAL_MS = 30 * 1000;
/** ... for 15 minutes after the link is ready. */
export const PAYMENT_POLL_DURATION_MS = 15 * 60 * 1000;
/** SPEC 2.9: 10 MB per uploaded file (matches the files.size_bytes check, 10485760). */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** API 1: list pagination. */
export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;
/** API 1: the server replays a decision for the same Idempotency-Key for 24 hours. */
export const IDEMPOTENCY_REPLAY_MS = 24 * 60 * 60 * 1000;
/** DATA-MODEL 2.14: the expiry sweeper runs every 30 seconds. */
export const APPROVAL_SWEEP_INTERVAL_MS = 30 * 1000;
/** API 5: the phone stream token lives 60 seconds and is accepted once. */
export const STREAM_TOKEN_TTL_MS = 60 * 1000;

/** CONTRACTS 2: availability slots sit on a 15 minute grid; at most 5 per read (default 5). */
export const AVAILABILITY_GRID_MINUTES = 15;
export const AVAILABILITY_MAX_SLOTS = 5;
/** CONTRACTS 6 and 8: at most 3 alternatives on a slot conflict. */
export const SLOT_CONFLICT_MAX_ALTERNATIVES = 3;
/** CONTRACTS 3: cart line limits. */
export const CART_LINE_MAX_QUANTITY = 20;
export const CART_LINE_NOTE_MAX_LENGTH = 140;

/** SPEC 2.1 seeded data. */
export const SEEDED_TIMEZONE = 'America/Los_Angeles';
export const PIZZA_BUSINESS_ID = 'biz_pizza_01';
export const BARBER_BUSINESS_ID = 'biz_barber_01';
/** SPEC 3.2: the voice model. */
export const REALTIME_MODEL = 'gpt-realtime-2.1';

/**
 * CONTRACTS 5: the simulated Square fallback shortens the idempotency key to this many characters.
 * Unconfirmed: spike B-02 must prove the cap before code relies on it.
 */
export const SQUARE_SIMULATED_IDEMPOTENCY_KEY_MAX = 45;

/**
 * Shared formatting for every screen. Money is in minor units (cents) on the
 * wire. Times are ISO strings in UTC and are shown in the business time zone.
 */

export function formatMoney(amountMinor: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {style: 'currency', currency}).format(amountMinor / 100);
}

export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {timeZone, hour: 'numeric', minute: '2-digit'}).format(new Date(iso));
}

/**
 * The short name people say for a time zone: "America/Los_Angeles" shows as
 * "PST" in winter and "PDT" in summer. Falls back to the zone ID.
 */
export function timeZoneAbbreviation(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', {timeZone, timeZoneName: 'short'})
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

export function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {timeZone, weekday: 'short', month: 'short', day: 'numeric'}).format(
    new Date(iso),
  );
}

/** Whole seconds from `now` until `iso`. Never negative. */
export function secondsUntil(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000));
}

/** "9:41" for a countdown, "0:00" once it has passed. */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** "just now", "4 min ago", "2 h ago", then the date. */
export function formatRelative(iso: string, timeZone: string, now: number = Date.now()): string {
  const seconds = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return formatDateTime(iso, timeZone);
}

/**
 * A phone number for reading aloud: "+15555550199" shows as "+1 (555) 555 0199".
 * Only North American numbers (+1 and ten digits) are reformatted. Anything
 * else is returned unchanged.
 */
export function formatPhone(value: string): string {
  const compact = value.trim().replace(/[\s().-]/g, '');
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(compact);
  if (!match) return value;
  return `+1 (${match[1]}) ${match[2]} ${match[3]}`;
}

/**
 * A North American number the way people dial it: "+18052039807" shows as
 * "(805) 203-9807". For a number shown large to callers in the United States.
 * Anything else falls back to formatPhone.
 */
export function formatPhoneLocal(value: string): string {
  const compact = value.trim().replace(/[\s().-]/g, '');
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(compact);
  if (!match) return formatPhone(value);
  return `(${match[1]}) ${match[2]}-${match[3]}`;
}

/** The last four characters of a phone number or ID, for redacted display. */
export function lastFour(value: string): string {
  return value.slice(-4);
}

/**
 * Who did something, for "Published ... by ..." lines. The API sends a user
 * ID (`usr_...`) and no name, and every business has one owner (SPEC 2.1),
 * so a user ID reads as "the owner". Never shows the raw ID.
 */
export function actorName(userId: string | undefined): string {
  if (!userId) return 'the system';
  return userId.startsWith('usr_') ? 'the owner' : 'the system';
}

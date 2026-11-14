// Authenticated Google clients and readable error messages.

import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { JWT } from "google-auth-library";
import type { ServiceAccount } from "./env.js";

/**
 * Least privilege for this spike:
 * - calendar.events: list, insert and delete events on calendars shared to the
 *   service account. It cannot read or change calendar settings or sharing.
 * - calendar.freebusy: free/busy only. freebusy.query does not accept
 *   calendar.events, so it needs its own scope.
 * - spreadsheets: read and append values. drive.file would be narrower but only
 *   covers files the app created or the user opened with it, not a sheet a
 *   person shared to the service account.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/spreadsheets",
];

export function authClient(sa: ServiceAccount): JWT {
  return new JWT({ email: sa.clientEmail, key: sa.privateKey, scopes: SCOPES });
}

export function calendarClient(auth: JWT): calendar_v3.Calendar {
  return calendar({ version: "v3", auth });
}

export function sheetsClient(auth: JWT): sheets_v4.Sheets {
  return sheets({ version: "v4", auth });
}

interface GaxiosLikeError {
  status?: number;
  code?: number | string;
  message?: string;
  response?: { status?: number; data?: unknown };
}

/** Turns a Google API error into one line with a likely fix. Never includes credentials. */
export function explainGoogleError(err: unknown, sa?: ServiceAccount): string {
  const e = err as GaxiosLikeError;
  const status = e?.response?.status ?? e?.status ?? (typeof e?.code === "number" ? e.code : undefined);
  const data = e?.response?.data as
    | { error?: { message?: string; status?: string; errors?: { reason?: string }[] } | string; error_description?: string }
    | undefined;
  const apiError = typeof data?.error === "object" ? data.error : undefined;
  const msg = apiError?.message ?? data?.error_description ?? (typeof data?.error === "string" ? data.error : undefined) ?? e?.message ?? String(err);
  const reason = apiError?.errors?.[0]?.reason ?? apiError?.status ?? "";
  const who = sa ? sa.clientEmail : "the service account";

  let hint = "";
  if (/invalid_grant|invalid_client|Invalid JWT/i.test(msg)) {
    hint = "The key was rejected. Check that the key is current and the system clock is right.";
  } else if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(msg + reason)) {
    hint = "Enable the API for this project (README step 2), wait a minute, then run again.";
  } else if (status === 404) {
    hint = `Not found. Either the ID is wrong or the item is not shared with ${who} (README steps 6 and 7).`;
  } else if (status === 403) {
    hint = `Permission denied. Share the calendar or sheet with ${who} with edit rights (README steps 6 and 7).`;
  } else if (status === 401) {
    hint = "Not authenticated. Check GOOGLE_SERVICE_ACCOUNT_JSON.";
  } else if (status === 400 && /Unable to parse range/i.test(msg)) {
    hint = "The sheet tab name could not be read as a range.";
  }
  return `Google API error${status ? ` ${status}` : ""}${reason ? ` (${reason})` : ""}: ${msg}${hint ? `\n  Fix: ${hint}` : ""}`;
}

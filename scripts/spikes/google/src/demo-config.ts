// Demo barbershop settings used by the spike scripts. Placeholders, not seed data.

import type { BusinessHours } from "./slots.js";

export const TIME_ZONE = "America/Los_Angeles";

export const DEMO_HOURS: BusinessHours = {
  mon: [],
  tue: [{ open: "09:00", close: "18:00" }],
  wed: [{ open: "09:00", close: "18:00" }],
  thu: [{ open: "09:00", close: "18:00" }],
  fri: [{ open: "09:00", close: "19:00" }],
  sat: [{ open: "08:00", close: "16:00" }],
  sun: [{ open: "10:00", close: "15:00" }],
};

export const DEMO_SERVICE = { name: "Haircut", durationMinutes: 30 };
export const DEMO_BUFFER_MINUTES = 10;
export const DEMO_MIN_NOTICE_MINUTES = 60;
export const GRID_MINUTES = 15;

/** Default booking ID for the single-step scripts, so create and delete pair up. */
export const DEFAULT_BOOKING_ID = "bkg_spike_manual";

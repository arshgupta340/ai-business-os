// Barbershop bookings and the fixed calendar busy blocks the mock availability tool reads.
// All appointments are on Tuesday 2026-11-17 (PST, UTC-8): hours 09:00 to 18:00 local, 17:00Z to 02:00Z.
import { BARBER_BUSINESS_ID, SEEDED_TIMEZONE, type Booking, type ServiceOffering } from '../src/index';
import { serviceBeardTrim, serviceHaircut, serviceHaircutBeard } from './facts';
import { storedKey } from './hashes';
import { BARBER_CALENDAR_ID, MINUTE_MS, addMs } from './world';

/** The demo appointment day, in the business timezone. */
export const BOOKING_DEMO_DATE = '2026-11-17';

type BookingInput = {
  n: string; // "b02" gives bkg_demo_b02, call_demo_b02, apv_demo_b02
  status: Booking['status'];
  service: ServiceOffering;
  startUtc: string;
  customerName: string;
  recipient: string;
  createdAt: string;
  updatedAt: string;
  googleEventId?: string;
};

function booking(b: BookingInput): Booking {
  const out: Booking = {
    id: `bkg_demo_${b.n}`,
    businessId: BARBER_BUSINESS_ID,
    callId: `call_demo_${b.n}`,
    status: b.status,
    serviceId: b.service.id,
    serviceName: b.service.name,
    startUtc: b.startUtc,
    endUtc: addMs(b.startUtc, b.service.durationMinutes * MINUTE_MS),
    timezone: SEEDED_TIMEZONE,
    calendarId: BARBER_CALENDAR_ID,
    customer: { name: b.customerName, messageRecipient: b.recipient, messageConsent: true },
    approvalId: `apv_demo_${b.n}`,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
  if (b.googleEventId !== undefined) out.googleEventId = b.googleEventId;
  return out;
}

/** Waiting for the owner. Haircut and beard, 15:00 to 15:45 local. */
export const bookingAwaitingApproval = booking({
  n: 'b01', status: 'AWAITING_OWNER_APPROVAL', service: serviceHaircutBeard, startUtc: '2026-11-17T23:00:00Z',
  customerName: 'Ana', recipient: '+15555550140', createdAt: '2026-11-14T20:24:00Z', updatedAt: '2026-11-14T20:24:00Z',
});

/**
 * The booking of the scripted timeline. Haircut 11:00 to 11:30 local. FLOWS C8: the Google event `id`
 * is the calendar step's idempotency key, so the event ID equals that execution's key.
 */
export const bookingVerified = booking({
  n: 'b02', status: 'BOOKED_VERIFIED', service: serviceHaircut, startUtc: '2026-11-17T19:00:00Z',
  customerName: 'Ben', recipient: '+15555550141', createdAt: '2026-11-14T17:32:00Z', updatedAt: '2026-11-14T17:33:06Z',
  googleEventId: storedKey('idem:exe_demo_b02_0'),
});

/** Beard trim at 13:15 local; a block was added to the calendar after the proposal, so the re-check failed. */
export const bookingSlotConflict = booking({
  n: 'b03', status: 'SLOT_CONFLICT', service: serviceBeardTrim, startUtc: '2026-11-17T21:15:00Z',
  customerName: 'Chris', recipient: '+15555550142', createdAt: '2026-11-14T17:50:00Z', updatedAt: '2026-11-14T17:52:02Z',
});

export const bookings: Booking[] = [bookingAwaitingApproval, bookingSlotConflict, bookingVerified];

/** Free/busy blocks on the barbershop calendar (UTC). The verified booking is one of them. */
export type BusyBlock = { calendarId: string; startUtc: string; endUtc: string; label: string };

export const barberBusyBlocks: BusyBlock[] = [
  { calendarId: BARBER_CALENDAR_ID, startUtc: '2026-11-17T17:00:00Z', endUtc: '2026-11-17T18:30:00Z', label: 'Existing appointments' },
  { calendarId: BARBER_CALENDAR_ID, startUtc: bookingVerified.startUtc, endUtc: bookingVerified.endUtc, label: 'Haircut (bkg_demo_b02)' },
  { calendarId: BARBER_CALENDAR_ID, startUtc: '2026-11-17T21:00:00Z', endUtc: '2026-11-17T22:00:00Z', label: 'Lunch' },
];

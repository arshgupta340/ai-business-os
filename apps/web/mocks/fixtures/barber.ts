/** Demo Barbershop (biz_barber_01). Times are relative to `now`. */
import type { AgentSpec, Booking, BusinessFact, Call, ServiceOffering } from "@/lib/api/pending-contracts";
import { bookingApproval, iso, MINUTE } from "../builders";
import { BARBER_CALENDAR_ID, TIMEZONE, type MockState } from "../types";
import { History } from "./history";

export const BARBER = "biz_barber_01";
export const BARBER_AGENT_ID = "agt_barber_01";
export const BARBER_AGENT_V1 = "agv_barber_01_v1";
export const BARBER_FAQ_AGENT_ID = "agt_barber_faq_01";

export const BARBER_SERVICES: ServiceOffering[] = [
  { id: "svc_cut", businessId: BARBER, name: "Haircut", durationMinutes: 30, priceMinor: 3000, currency: "USD", bufferMinutes: 5 },
  { id: "svc_beard", businessId: BARBER, name: "Beard trim", durationMinutes: 15, priceMinor: 1500, currency: "USD", bufferMinutes: 5 },
  { id: "svc_cut_beard", businessId: BARBER, name: "Haircut and beard", durationMinutes: 45, priceMinor: 4000, currency: "USD", bufferMinutes: 5 },
];

export function barberSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: BARBER_AGENT_ID,
    businessId: BARBER,
    version: 1,
    template: "appointment_booker",
    name: "Barbershop Booking Assistant",
    channel: "phone",
    goal: "Book appointments from free calendar slots and send each one to the owner for approval.",
    knowledgeScopes: ["business_profile", "hours", "services"],
    capabilities: [
      "business.facts.read",
      "calendar.availability.read",
      "booking.propose",
      "calendar.event.create",
      "message.booking.confirm",
      "sheets.rows.append",
    ],
    writePolicy: "owner_approval_each_action_bundle",
    escalation: "explain_unsupported_or_offer_callback",
    status: "live",
    guardrailVersion: "v1",
    greeting:
      "Hi, thanks for calling Demo Barbershop. You are speaking with an AI assistant. I can tell you about our services and book an appointment. How can I help?",
    ...overrides,
  };
}

const HOURS: Record<string, { open: string; close: string } | { closed: true }> = {
  mon: { closed: true },
  tue: { open: "09:00", close: "18:00" },
  wed: { open: "09:00", close: "18:00" },
  thu: { open: "09:00", close: "19:00" },
  fri: { open: "09:00", close: "19:00" },
  sat: { open: "09:00", close: "16:00" },
  sun: { closed: true },
};

/** Next whole hour at least `hoursAhead` from now, used for appointment times. */
function slotAt(now: number, hoursAhead: number): number {
  const d = new Date(now + hoursAhead * 60 * MINUTE);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}

export function seedBarber(state: MockState, now: number): void {
  const h = new History(state, BARBER);
  const seedAt = now - 26 * 60 * MINUTE;
  const f = (id: string, kind: BusinessFact["kind"], key: string, value: unknown, extra: Partial<BusinessFact> = {}): BusinessFact => ({
    id,
    businessId: BARBER,
    kind,
    key,
    value,
    sourceType: "seed",
    status: "verified",
    confidence: 1,
    version: 1,
    verifiedAt: iso(seedAt),
    createdAt: iso(seedAt),
    updatedAt: iso(seedAt),
    ...extra,
  });

  state.businesses.push({
    id: BARBER,
    name: "Demo Barbershop",
    category: "barbershop",
    timezone: TIMEZONE,
    contact: { phone: "+15555550200", email: "barber@example.com", address: "200 Demo Avenue, San Luis Obispo, CA" },
    settings: {},
    createdAt: iso(seedAt),
    updatedAt: iso(seedAt),
  });

  for (const [day, value] of Object.entries(HOURS)) state.facts.push(f(`fact_barber_hours_${day}`, "hours", day, value));
  for (const svc of BARBER_SERVICES) state.facts.push(f(`fact_barber_${svc.id}`, "service", svc.id, svc));
  state.facts.push(
    f("fact_barber_notice", "policy", "minimum_notice", { minutes: 60 }),
    f("fact_barber_faq_parking", "faq", "parking", { question: "Is there parking?", answer: "Street parking out front." }),
  );

  // An uploaded services sheet with one low-confidence draft and no conflict
  const fileAt = now - 3 * 60 * MINUTE;
  state.files.push({
    id: "file_services_01",
    businessId: BARBER,
    name: "services.csv",
    mime: "text/csv",
    sizeBytes: 912,
    sha256: "9a3e5f1c0b2d4e6f8a1c3e5d7b9f0a2c4e6d8f0b1a3c5e7d9f1b3a5c7e9d1f3a",
    extractionState: "EXTRACTED",
    draftFactIds: ["fact_barber_draft_kids"],
    conflictIds: [],
    createdAt: iso(fileAt),
  });
  state.facts.push(
    f(
      "fact_barber_draft_kids",
      "service",
      "svc_kids",
      { id: "svc_kids", businessId: BARBER, name: "Kids cut", durationMinutes: 20, priceMinor: 2000, currency: "USD" },
      { sourceType: "upload", fileId: "file_services_01", status: "draft", confidence: 0.71, verifiedAt: undefined, createdAt: iso(fileAt) },
    ),
  );
  h.emit("extraction.completed", "file_services_01", "system", fileAt + 3000, {
    fileId: "file_services_01",
    mime: "text/csv",
    extractionState: "EXTRACTED",
    draftFactCount: 1,
    conflictCount: 0,
  });

  // Agents: a live booking agent (not on the phone number) and a draft FAQ agent
  const pubAt = now - 20 * 60 * MINUTE;
  state.versions.push({
    id: BARBER_AGENT_V1,
    agentId: BARBER_AGENT_ID,
    version: 1,
    spec: barberSpec(),
    knowledgeSnapshotRef: { facts: BARBER_SERVICES.map((s) => ({ id: `fact_barber_${s.id}`, version: 1 })) },
    createdBy: "usr_owner_01",
    publishedAt: iso(pubAt),
  });
  state.agents.push(
    {
      id: BARBER_AGENT_ID,
      businessId: BARBER,
      name: "Barbershop Booking Assistant",
      template: "appointment_booker",
      state: "live",
      activeVersionId: BARBER_AGENT_V1,
      draftSpec: barberSpec(),
      createdAt: iso(pubAt - 15 * MINUTE),
      updatedAt: iso(pubAt),
    },
    {
      id: BARBER_FAQ_AGENT_ID,
      businessId: BARBER,
      name: "Barbershop FAQ Assistant",
      template: "custom",
      state: "draft",
      draftSpec: {
        template: "custom",
        name: "Barbershop FAQ Assistant",
        channel: "phone",
        goal: "Answer questions about services, prices, hours and parking.",
        knowledgeScopes: ["business_profile", "hours", "services", "faq"],
        capabilities: ["business.facts.read"],
      },
      createdAt: iso(now - 2 * 60 * MINUTE),
      updatedAt: iso(now - 2 * 60 * MINUTE),
    },
  );
  h.emit("agent.published", BARBER_AGENT_ID, "owner", pubAt, { agentId: BARBER_AGENT_ID, agentVersionId: BARBER_AGENT_V1, version: 1 });

  // Calls and bookings
  const bookingCall = (
    key: string,
    service: ServiceOffering,
    who: [string, string],
    startAt: number,
    slotStart: number,
  ): { booking: Booking; approval: ReturnType<typeof bookingApproval>; at: number } => {
    const call: Call = {
      id: `call_barber_${key}`,
      businessId: BARBER,
      agentId: BARBER_AGENT_ID,
      agentVersionId: BARBER_AGENT_V1,
      channel: "phone",
      stage: "CUSTOMER_CONFIRMED",
      providerCallId: `CAbarber${key}`,
      callerLast4: who[1].slice(-4),
      status: "COMPLETED",
      endReason: "completed",
      startedAt: iso(startAt),
      endedAt: iso(startAt + 4 * MINUTE),
    };
    const at = h.call(call, ["INQUIRY", "SLOT_SEARCH", "PROPOSAL", "CUSTOMER_CONFIRMED"], "booking", startAt);
    const booking: Booking = {
      id: `bkg_barber_${key}`,
      businessId: BARBER,
      callId: call.id,
      status: "AWAITING_OWNER_APPROVAL",
      serviceId: service.id,
      serviceName: service.name,
      startUtc: iso(slotStart),
      endUtc: iso(slotStart + service.durationMinutes * MINUTE),
      timezone: TIMEZONE,
      calendarId: BARBER_CALENDAR_ID,
      customer: { name: who[0], messageRecipient: who[1], messageConsent: true },
      createdAt: iso(at),
      updatedAt: iso(at),
    };
    const approval = bookingApproval(booking, BARBER_AGENT_V1, `apv_barber_${key}`, at);
    booking.approvalId = approval.id;
    state.bookings.push(booking);
    state.approvals.push(approval);
    h.proposal(booking, approval, call, at);
    h.endCall(call, at + 30_000);
    return { booking, approval, at };
  };

  {
    const { booking, approval, at } = bookingCall("booked", BARBER_SERVICES[0], ["Ana", "+15555550124"], now - 160 * MINUTE, slotAt(now, 20));
    h.approvedBooking(booking, approval, at + MINUTE, "booked");
  }
  {
    const { booking, approval, at } = bookingCall("conflict", BARBER_SERVICES[2], ["Ben", "+15555550125"], now - 120 * MINUTE, slotAt(now, 22));
    h.approvedBooking(booking, approval, at + MINUTE, "slot_conflict");
  }
  {
    const { booking, approval, at } = bookingCall("rejected", BARBER_SERVICES[1], ["Cy", "+15555550126"], now - 100 * MINUTE, slotAt(now, 26));
    h.decide(approval, "REJECTED", booking.callId!, at + 2 * MINUTE);
    h.bookingStatus(booking, "AWAITING_OWNER_APPROVAL", "REJECTED", at + 2 * MINUTE);
  }
  {
    const { booking, approval } = bookingCall("expired", BARBER_SERVICES[0], ["Dee", "+15555550127"], now - 80 * MINUTE, slotAt(now, 28));
    h.expire(approval, booking.callId!);
    h.bookingStatus(booking, "AWAITING_OWNER_APPROVAL", "EXPIRED", Date.parse(approval.expiresAt));
  }
  {
    const call: Call = {
      id: "call_barber_dropped",
      businessId: BARBER,
      agentId: BARBER_AGENT_ID,
      agentVersionId: BARBER_AGENT_V1,
      channel: "phone",
      stage: "SLOT_SEARCH",
      providerCallId: "CAbarberdropped",
      callerLast4: "0166",
      status: "DROPPED",
      endReason: "dropped",
      startedAt: iso(now - 40 * MINUTE),
      endedAt: iso(now - 39 * MINUTE),
    };
    const t = h.call(call, ["INQUIRY", "SLOT_SEARCH"], "booking", now - 40 * MINUTE);
    h.endCall(call, t + 20_000);
  }
  bookingCall("pending", BARBER_SERVICES[0], ["Eve", "+15555550128"], now - 4 * MINUTE, slotAt(now, 30));
}

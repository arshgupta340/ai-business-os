// Agents, their versions, the live-agent row and a builder session partway through an interview.
import {
  BARBER_BUSINESS_ID,
  PIZZA_BUSINESS_ID,
  type Agent,
  type AgentSpec,
  type AgentVersion,
  type BuilderMessage,
  type BuilderSession,
  type BuilderTurnResponse,
  type CapabilityId,
  type DraftAgentSpec,
  type KnowledgeSnapshotRef,
  type LiveAgent,
} from '../src/index';
import { CATALOG_SYNCED_AT } from './catalog';
import { barberFacts, pizzaVerifiedFacts } from './facts';
import { DEMO_PHONE_NUMBER, OWNER_USER_ID, SEEDED_AT } from './world';

/** SPEC 2.2: the capabilities of the restaurant template (tools plus the executor bundle). */
export const PIZZA_CAPABILITIES: CapabilityId[] = [
  'catalog.read',
  'business.facts.read',
  'order.quote',
  'order.propose',
  'order.status.read',
  'order.checkout.prepare',
  'message.checkout.send',
  'sheets.rows.append',
];

/** SPEC 2.2: the capabilities of the appointment template. */
export const BARBER_CAPABILITIES: CapabilityId[] = [
  'business.facts.read',
  'calendar.availability.read',
  'booking.propose',
  'calendar.event.create',
  'message.booking.confirm',
  'sheets.rows.append',
];

const PIZZA_GREETING_V1 = 'Hi, thanks for calling Demo Pizza Co. You are speaking with an AI assistant. What can I get for you?';
const PIZZA_GREETING_V2 =
  'Hi, thanks for calling Demo Pizza Co. You are speaking with an AI assistant. I can answer menu questions and take pickup orders. What can I get for you?';
const BARBER_GREETING =
  'Hi, thanks for calling Demo Barbershop. You are speaking with an AI assistant. I can tell you about our services and book an appointment. How can I help?';

export const pizzaSpecV1 = {
  id: 'agt_pizza_01',
  businessId: PIZZA_BUSINESS_ID,
  version: 1,
  template: 'restaurant_order_taker',
  name: 'Pizza Order Assistant',
  channel: 'phone',
  goal: 'Take pickup orders over the phone and send each one to the owner for approval.',
  knowledgeScopes: ['business_profile', 'catalog', 'hours', 'order_policies'],
  capabilities: PIZZA_CAPABILITIES,
  writePolicy: 'owner_approval_each_action_bundle',
  escalation: 'explain_unsupported_or_offer_callback',
  status: 'live',
  guardrailVersion: 'v1',
  greeting: PIZZA_GREETING_V1,
} satisfies AgentSpec;

export const pizzaSpecV2 = {
  ...pizzaSpecV1,
  version: 2,
  goal: 'Answer menu and hours questions and take pickup orders, each sent to the owner for approval.',
  knowledgeScopes: ['business_profile', 'catalog', 'hours', 'order_policies', 'faq'],
  greeting: PIZZA_GREETING_V2,
} satisfies AgentSpec;

export const barberSpecV1 = {
  id: 'agt_barber_01',
  businessId: BARBER_BUSINESS_ID,
  version: 1,
  template: 'appointment_booker',
  name: 'Booking Assistant',
  channel: 'phone',
  goal: 'Book haircut and beard appointments on the shop calendar, each sent to the owner for approval.',
  knowledgeScopes: ['business_profile', 'hours', 'services', 'faq'],
  capabilities: BARBER_CAPABILITIES,
  writePolicy: 'owner_approval_each_action_bundle',
  escalation: 'explain_unsupported_or_offer_callback',
  status: 'live',
  guardrailVersion: 'v1',
  greeting: BARBER_GREETING,
} satisfies AgentSpec;

function snapshotOf(facts: { id: string; version: number; status: string }[], catalogSyncedAt?: string): KnowledgeSnapshotRef {
  const ref: KnowledgeSnapshotRef = { facts: facts.filter((f) => f.status === 'verified').map((f) => ({ id: f.id, version: f.version })) };
  if (catalogSyncedAt !== undefined) ref.catalogSyncedAt = catalogSyncedAt;
  return ref;
}

export const pizzaVersionV1 = {
  id: 'agv_pizza_01_v1',
  agentId: pizzaSpecV1.id,
  version: 1,
  spec: pizzaSpecV1,
  knowledgeSnapshotRef: snapshotOf(pizzaVerifiedFacts, '2026-11-13T19:30:00Z'),
  createdBy: OWNER_USER_ID,
  publishedAt: '2026-11-13T19:30:00Z',
} satisfies AgentVersion;

export const pizzaVersionV2 = {
  id: 'agv_pizza_01_v2',
  agentId: pizzaSpecV2.id,
  version: 2,
  spec: pizzaSpecV2,
  knowledgeSnapshotRef: snapshotOf(pizzaVerifiedFacts, CATALOG_SYNCED_AT),
  createdBy: OWNER_USER_ID,
  publishedAt: '2026-11-14T16:00:00Z',
} satisfies AgentVersion;

export const barberVersionV1 = {
  id: 'agv_barber_01_v1',
  agentId: barberSpecV1.id,
  version: 1,
  spec: barberSpecV1,
  knowledgeSnapshotRef: snapshotOf(barberFacts),
  createdBy: OWNER_USER_ID,
  publishedAt: '2026-11-14T17:00:00Z',
} satisfies AgentVersion;

export const agentVersions: AgentVersion[] = [pizzaVersionV2, pizzaVersionV1, barberVersionV1];

/** The live pizza agent on version 2. It answers the phone number. */
export const pizzaAgent = {
  id: pizzaSpecV2.id,
  businessId: PIZZA_BUSINESS_ID,
  name: pizzaSpecV2.name,
  template: 'restaurant_order_taker',
  state: 'live',
  activeVersionId: pizzaVersionV2.id,
  activeVersion: pizzaVersionV2,
  draftSpec: pizzaSpecV2,
  isLiveAgent: true,
  createdAt: '2026-11-13T19:05:00Z',
  updatedAt: '2026-11-14T16:00:00Z',
} satisfies Agent;

/** The barbershop agent: published and live, but not the one answering the number right now. */
export const barberAgent = {
  id: barberSpecV1.id,
  businessId: BARBER_BUSINESS_ID,
  name: barberSpecV1.name,
  template: 'appointment_booker',
  state: 'live',
  activeVersionId: barberVersionV1.id,
  activeVersion: barberVersionV1,
  draftSpec: barberSpecV1,
  isLiveAgent: false,
  createdAt: '2026-11-14T16:30:00Z',
  updatedAt: '2026-11-14T17:00:00Z',
} satisfies Agent;

/** A custom FAQ-only agent mid-build (P-13). Not published yet. */
export const faqDraftSpec = {
  id: 'agt_pizza_faq_01',
  businessId: PIZZA_BUSINESS_ID,
  template: 'custom',
  name: 'Pizza FAQ Line',
  channel: 'phone',
  goal: 'Answer questions about the menu, hours and policies.',
  knowledgeScopes: ['business_profile', 'catalog', 'hours', 'faq'],
  capabilities: ['catalog.read', 'business.facts.read'],
  writePolicy: 'owner_approval_each_action_bundle',
  escalation: 'explain_unsupported_or_offer_callback',
  status: 'draft',
  guardrailVersion: 'v1',
} satisfies DraftAgentSpec;

export const faqDraftAgent = {
  id: faqDraftSpec.id,
  businessId: PIZZA_BUSINESS_ID,
  name: faqDraftSpec.name,
  template: 'custom',
  state: 'draft',
  draftSpec: faqDraftSpec,
  isLiveAgent: false,
  createdAt: '2026-11-14T20:20:00Z',
  updatedAt: '2026-11-14T20:28:00Z',
} satisfies Agent;

export const agents: Agent[] = [pizzaAgent, barberAgent, faqDraftAgent];

export const liveAgent = {
  phoneNumber: DEMO_PHONE_NUMBER,
  businessId: PIZZA_BUSINESS_ID,
  agentId: pizzaAgent.id,
  agentVersionId: pizzaVersionV2.id,
  updatedAt: '2026-11-14T18:55:00Z', // the barbershop agent held the number from 17:00Z to 18:55Z
} satisfies LiveAgent;

/** The barbershop agent answering the number (response of PUT /api/live-agent). */
export const liveAgentBarber = {
  phoneNumber: DEMO_PHONE_NUMBER,
  businessId: BARBER_BUSINESS_ID,
  agentId: barberAgent.id,
  agentVersionId: barberVersionV1.id,
  updatedAt: '2026-11-14T20:31:00Z',
} satisfies LiveAgent;

/** Nothing answers the number yet (issue #56). */
export const liveAgentEmpty = {
  phoneNumber: DEMO_PHONE_NUMBER,
  businessId: PIZZA_BUSINESS_ID,
  updatedAt: SEEDED_AT,
} satisfies LiveAgent;

// ---- Builder session, partway through (Flow A) ----

const SESSION_ID = 'bld_demo_01';

export const builderMessages = [
  { id: 'bmsg_demo_01', sessionId: SESSION_ID, role: 'assistant', inputMode: 'text',
    text: 'What would you like an agent to do for your business?', createdAt: '2026-11-14T20:20:00Z' },
  { id: 'bmsg_demo_02', sessionId: SESSION_ID, role: 'owner', inputMode: 'voice',
    text: 'I want a second line that only answers questions about the menu and our hours.', createdAt: '2026-11-14T20:20:40Z' },
  { id: 'bmsg_demo_03', sessionId: SESSION_ID, role: 'assistant', inputMode: 'text',
    text: 'I can build a question-only agent. It will read your Square menu and your verified hours and policies. It will not take orders. Should it offer to take a message when it cannot answer?',
    specPatch: { template: 'custom', name: 'Pizza FAQ Line', capabilities: ['catalog.read', 'business.facts.read'] },
    evidenceRefs: ['fact_pizza_hours_fri', 'fact_pizza_policy_pickup_only'], createdAt: '2026-11-14T20:20:45Z' },
  { id: 'bmsg_demo_04', sessionId: SESSION_ID, role: 'owner', inputMode: 'text',
    text: 'Yes. And can it take card numbers over the phone so people can prepay?', createdAt: '2026-11-14T20:22:10Z' },
  { id: 'bmsg_demo_05', sessionId: SESSION_ID, role: 'assistant', inputMode: 'text',
    text: 'Taking card numbers over the phone is not available. Payment always goes through a Square sandbox link that the customer opens. What should the agent say when someone calls after closing time?',
    createdAt: '2026-11-14T20:22:15Z' },
  { id: 'bmsg_demo_06', sessionId: SESSION_ID, role: 'owner', inputMode: 'voice',
    text: 'Also, we close at 11 pm on Fridays now.', createdAt: '2026-11-14T20:27:50Z' },
] satisfies BuilderMessage[];

/** The reply to bmsg_demo_06: the hours change becomes a fact_edit proposal waiting for confirmation. */
export const builderReply = {
  id: 'bmsg_demo_07',
  sessionId: SESSION_ID,
  role: 'assistant',
  inputMode: 'text',
  text: 'Friday closing time changes from 10:00 pm to 11:00 pm. Please confirm the change in the dialog. Until then the agents keep the current hours.',
  evidenceRefs: ['fact_pizza_hours_fri', 'fact_pizza_hours_fri_d2'],
  createdAt: '2026-11-14T20:28:00Z',
} satisfies BuilderMessage;

export const builderMissingFields = ['greeting', 'policy.after_hours', 'escalation.callback_wording'];

export const builderSession = {
  id: SESSION_ID,
  businessId: PIZZA_BUSINESS_ID,
  status: 'active',
  messages: [...builderMessages, builderReply],
  draftSpec: faqDraftSpec,
  missingFields: builderMissingFields,
  progress: { answered: 3, required: 6 },
  agentId: faqDraftAgent.id,
  createdAt: '2026-11-14T20:20:00Z',
  updatedAt: '2026-11-14T20:28:00Z',
} satisfies BuilderSession;

/** A just-created session (response of POST /api/builder/sessions). */
export const builderSessionNew = {
  id: 'bld_demo_02',
  businessId: PIZZA_BUSINESS_ID,
  status: 'active',
  messages: [{ id: 'bmsg_demo_20', sessionId: 'bld_demo_02', role: 'assistant', inputMode: 'text',
    text: 'What would you like an agent to do for your business?', createdAt: '2026-11-14T20:31:00Z' }],
  draftSpec: {},
  missingFields: [],
  progress: { answered: 0, required: 0 },
  createdAt: '2026-11-14T20:31:00Z',
  updatedAt: '2026-11-14T20:31:00Z',
} satisfies BuilderSession;

export const builderTurn = {
  reply: builderReply,
  draftSpec: faqDraftSpec,
  missingFields: builderMissingFields,
  suggestions: ['Confirm the Friday hours change', 'Resolve the menu price conflict'],
  stopConditions: [{ code: 'conflict_open' }, { code: 'missing_greeting' }],
  progress: { answered: 3, required: 6 },
  unsupportedRequests: ['Take card numbers over the phone'],
  proposedChange: { approvalId: 'apv_demo_f01', bundleType: 'fact_edit' },
} satisfies BuilderTurnResponse;

import type { BuilderModel, BuilderTurnInput, BuilderTurnOutput } from './model';

// Replays stored builder turns for the scripted interviews. Used whenever
// OPENAI_API_KEY is absent.
//
// HONEST LABEL: these outputs were written by hand in the shape the real
// model must return. They were not captured from OpenAI, because no key
// exists yet. Once a key exists, rerun the scripts against the real model and
// replace these with captured outputs.
//
// A turn is found by the owner's text, normalized (case, spacing and trailing
// punctuation do not matter). An unknown text gets a fixed reply that says the
// builder is in recorded mode and changes nothing.

export const RECORDED_SCRIPTS = {
  pizza: [
    'I run a pizza shop and want an AI that takes pickup orders.',
    'Ask the caller if they agree to get one text with the payment link, and only send it if they say yes.',
  ],
  barbershop: [
    'I run a barbershop and want an AI that books appointments.',
    'We need at least 2 hours notice. Ask the customer if we can text them a confirmation, and only text them if they say yes.',
  ],
  unsupported: ['Also have it send marketing texts to all my customers every week.'],
} as const;

const PIZZA_CAPS = [
  'catalog.read',
  'business.facts.read',
  'order.quote',
  'order.propose',
  'order.status.read',
  'order.checkout.prepare',
  'message.checkout.send',
  'sheets.rows.append',
];

const BARBER_CAPS = [
  'business.facts.read',
  'calendar.availability.read',
  'booking.propose',
  'calendar.event.create',
  'message.booking.confirm',
  'sheets.rows.append',
];

const empty = {
  template: null,
  capabilityIds: [],
  unsupportedRequests: [],
  name: null,
  goal: null,
  greeting: null,
  knowledgeScopes: null,
  answers: [],
} satisfies Partial<BuilderTurnOutput>;

const RECORDINGS: Record<string, BuilderTurnOutput> = {
  [RECORDED_SCRIPTS.pizza[0]]: {
    ...empty,
    reply:
      'I can build that: a phone agent that answers menu questions, reads back an exact total, and sends each order to you for approval before any payment link goes out. I found your Square menu, your hours and your 20 minute pickup window. One thing is left. How should the agent ask the caller for consent before it texts them the payment link?',
    template: 'restaurant_order_taker',
    capabilityIds: PIZZA_CAPS,
    confidence: 0.94,
    name: 'Pizza Order Assistant',
    goal: 'Answer menu questions and propose pickup orders for owner approval.',
    greeting: 'Hi, thanks for calling Demo Pizza Co. I am an AI assistant and I can take your pickup order.',
    knowledgeScopes: ['business_profile', 'catalog', 'hours', 'order_policies'],
  },
  [RECORDED_SCRIPTS.pizza[1]]: {
    ...empty,
    reply: 'Got it. The agent will ask for consent and will only send the payment link after the caller says yes. The draft is ready for preview.',
    template: 'restaurant_order_taker',
    capabilityIds: PIZZA_CAPS,
    confidence: 0.95,
    answers: [
      {
        field: 'policy.message_consent',
        value: 'Ask the caller if they agree to get one text with the payment link. Send it only after a clear yes.',
      },
    ],
  },
  [RECORDED_SCRIPTS.barbershop[0]]: {
    ...empty,
    reply:
      'I can build that: a phone agent that checks your calendar, offers open slots, and sends each booking to you for approval before it goes on the calendar. I found your hours and three services. Two things are left. How much notice do you need before an appointment, and how should the agent ask for consent before it texts a confirmation?',
    template: 'appointment_booker',
    capabilityIds: BARBER_CAPS,
    confidence: 0.93,
    name: 'Barbershop Booking Assistant',
    goal: 'Offer open appointment slots and propose bookings for owner approval.',
    greeting: 'Hi, thanks for calling Demo Barbershop. I am an AI assistant and I can help you book an appointment.',
    knowledgeScopes: ['business_profile', 'hours', 'services'],
  },
  [RECORDED_SCRIPTS.barbershop[1]]: {
    ...empty,
    reply: 'Thanks. Bookings will need at least 2 hours notice, and the agent will only text a confirmation after the customer agrees. The draft is ready for preview.',
    template: 'appointment_booker',
    capabilityIds: BARBER_CAPS,
    confidence: 0.94,
    answers: [
      { field: 'policy.minimum_notice', value: 'At least 2 hours before the appointment.' },
      { field: 'policy.message_consent', value: 'Ask the customer if we can text them a confirmation. Text only after a clear yes.' },
    ],
  },
  [RECORDED_SCRIPTS.unsupported[0]]: {
    ...empty,
    // This recording names a capability that does not exist on purpose, so
    // the strip-and-report path runs on every replay.
    reply: 'This agent cannot send marketing texts. It only sends a message that belongs to an order or booking the customer agreed to.',
    capabilityIds: ['marketing.sms.broadcast'],
    unsupportedRequests: ['send marketing texts'],
    confidence: 0.9,
  },
};

const UNKNOWN_REPLY =
  'The builder is running on recorded answers because no OpenAI key is set, and there is no recorded answer for that message. Nothing was changed.';

export function normalizeScriptText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
}

const BY_TEXT = new Map(Object.entries(RECORDINGS).map(([text, out]) => [normalizeScriptText(text), out]));

export class RecordedBuilderModel implements BuilderModel {
  readonly kind = 'recorded' as const;

  async turn(input: BuilderTurnInput): Promise<unknown> {
    const hit = BY_TEXT.get(normalizeScriptText(input.ownerText));
    if (hit) return structuredClone(hit);
    return { ...empty, reply: UNKNOWN_REPLY, confidence: 0 } satisfies BuilderTurnOutput;
  }
}

/**
 * One place for the owner-facing name of every contract value that is not a
 * state: message channels, guardrail rules, action types, fact kinds and keys,
 * agent templates, approval bundles, providers, fact sources, approval actors,
 * agent tools, tool effects and activity event types. States and their tones
 * live in status.ts.
 *
 * Rule: no raw contract value reaches the owner. Each map is typed on the
 * contract enum, so a value added to the contract and not labelled here fails
 * the typecheck, and labels.coverage.test.ts fails as well. Each lookup
 * function takes a raw value and never returns it: a value this app does not
 * know shows in a readable form or as a plain generic phrase.
 *
 * Screens must not keep their own maps of these values. Import from here.
 * Catalog sync states are not here: use statusView('catalogSync', state).
 */

import type {
  ActionType,
  ActivityEventType,
  AgentTemplate,
  ApprovalActorType,
  BundleType,
  Effect,
  FactKind,
  FactSourceType,
  GuardrailRule,
  HoursKey,
  IntegrationProvider,
  MessageChannel,
  MessageChannelSetting,
  ToolName,
  WebhookProvider,
} from '@abos/contracts';
import {readableLabel} from './status';

/** The label for `raw` in `labels`, or undefined when `raw` is not one of its own keys. */
function lookup<K extends string>(labels: Record<K, string>, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // Object.hasOwn keeps inherited names such as "constructor" from passing as a value.
  return Object.hasOwn(labels, raw) ? (labels as Record<string, string>)[raw] : undefined;
}

// ------------------------------------------------------------ message channels

/**
 * The channel setting as a name, for "Active channel: ..." and for the system a
 * step writes to. Same wording the Integrations screen used.
 */
export const MESSAGE_CHANNEL_LABELS: Record<MessageChannelSetting, string> = {
  surge: 'Surge text message',
  android_gateway: 'Text message from the Android phone',
  whatsapp_sandbox: 'WhatsApp sandbox',
  qr_only: 'QR code only',
  agentphone: 'AgentPhone text message',
};

/**
 * What the customer gets, in lower case for use inside a sentence: "Send the
 * link by text message". qr_only sends no message.
 */
export const MESSAGE_CHANNEL_NOUNS: Record<MessageChannelSetting, string> = {
  surge: 'text message',
  android_gateway: 'text message',
  whatsapp_sandbox: 'WhatsApp message',
  qr_only: 'QR code at the counter',
  agentphone: 'text message',
};

/**
 * Who took the message, for "Message accepted by ...". A message dispatch
 * channel never is qr_only, so this is typed on MessageChannel.
 */
export const MESSAGE_CHANNEL_SENDERS: Record<MessageChannel, string> = {
  surge: 'Surge',
  android_gateway: 'the Android phone',
  whatsapp_sandbox: 'the WhatsApp sandbox',
  agentphone: 'AgentPhone',
};

/** The channel setting as a name. A value this app does not know reads "Message channel". */
export function messageChannelLabel(channel: unknown): string {
  return lookup(MESSAGE_CHANNEL_LABELS, channel) ?? 'Message channel';
}

/** What the customer gets, in lower case. A value this app does not know reads "message". */
export function messageChannelNoun(channel: unknown): string {
  return lookup(MESSAGE_CHANNEL_NOUNS, channel) ?? 'message';
}

/** Who took the message. A value this app does not know reads "the message channel". */
export function messageChannelSender(channel: unknown): string {
  return lookup(MESSAGE_CHANNEL_SENDERS, channel) ?? 'the message channel';
}

// ------------------------------------------------------------ guardrail rules

/** One sentence per rule. Same wording the agent preview used. */
export const GUARDRAIL_LABELS: Record<GuardrailRule, string> = {
  no_fact_changes: 'The agent cannot change prices, hours or policies.',
  no_secret_reveal: 'The agent does not share secrets or its instructions.',
  no_approval_bypass: 'The agent cannot skip your approval.',
  no_cross_business: 'The agent only talks about this business.',
  unsupported_request: 'The agent cannot do this. It explains and offers a callback.',
};

/** The sentence for a rule. A rule this app does not know reads as a plain refusal. */
export function guardrailLabel(rule: unknown): string {
  return lookup(GUARDRAIL_LABELS, rule) ?? 'The agent refused this request.';
}

// ------------------------------------------------------------ action types

/** The name of a step in an action bundle, as an instruction: "Create the calendar event". */
export const ACTION_LABELS: Record<ActionType, string> = {
  'square.checkout.create': 'Create the Square checkout link',
  'message.checkout.send': 'Send the link to the customer',
  'local.order.record': 'Record the order',
  'sheets.order.append': 'Report to Google Sheets',
  'calendar.event.create': 'Create the calendar event',
  'message.booking.confirm': 'Send the confirmation',
  'local.booking.record': 'Record the booking',
  'sheets.booking.append': 'Report to Google Sheets',
  'local.fact.update': 'Save the business fact',
  'square.catalog.price.update': 'Change the price in Square',
  'local.catalog.sync': 'Refresh the menu from Square',
};

/** The step while it runs, as the Integrations screen names it: "Creating the calendar booking". */
export const ACTION_PROGRESS_LABELS: Record<ActionType, string> = {
  'square.checkout.create': 'Creating the Square checkout link (sandbox)',
  'message.checkout.send': 'Sending the payment link to the customer',
  'local.order.record': 'Saving the order',
  'sheets.order.append': 'Adding the order to the report sheet',
  'calendar.event.create': 'Creating the calendar booking',
  'message.booking.confirm': 'Sending the booking confirmation',
  'local.booking.record': 'Saving the booking',
  'sheets.booking.append': 'Adding the booking to the report sheet',
  'local.fact.update': 'Saving the business fact',
  'square.catalog.price.update': 'Changing the price in Square (sandbox)',
  'local.catalog.sync': 'Refreshing the menu from Square',
};

/** The step name. An action type this app does not know shows in a readable form. */
export function actionLabel(actionType: unknown): string {
  return lookup(ACTION_LABELS, actionType) ?? readableLabel(actionType, 'A step');
}

/** The step name while it runs. An action type this app does not know shows in a readable form. */
export function actionProgressLabel(actionType: unknown): string {
  return lookup(ACTION_PROGRESS_LABELS, actionType) ?? readableLabel(actionType, 'A step');
}

// ------------------------------------------------------------ facts

/** The kind of one fact. */
export const FACT_KIND_LABELS: Record<FactKind, string> = {
  hours: 'Opening hours',
  policy: 'Policy',
  service: 'Service',
  contact: 'Contact',
  faq: 'Question and answer',
  menu_item: 'Menu item',
};

/** A heading for a group of facts of one kind. Same wording the Business knowledge screen used. */
export const FACT_KIND_GROUP_LABELS: Record<FactKind, string> = {
  hours: 'Opening hours',
  policy: 'Policies',
  service: 'Services',
  contact: 'Contact',
  faq: 'Questions and answers',
  menu_item: 'Menu item from a file',
};

/** The day an hours fact is for. */
export const HOURS_KEY_LABELS: Record<HoursKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

/** Where a fact came from. Same wording the Business knowledge screen used. */
export const FACT_SOURCE_LABELS: Record<FactSourceType, string> = {
  square: 'Square',
  google_calendar: 'Google Calendar',
  owner_chat: 'You, in the builder chat',
  owner_ui: 'You, in the dashboard',
  upload: 'Uploaded file',
  seed: 'Setup data',
};

/** The kind of one fact. A kind this app does not know shows in a readable form. */
export function factKindLabel(kind: unknown): string {
  return lookup(FACT_KIND_LABELS, kind) ?? readableLabel(kind, 'Business fact');
}

/** A heading for a group of facts. A kind this app does not know shows in a readable form. */
export function factKindGroupLabel(kind: unknown): string {
  return lookup(FACT_KIND_GROUP_LABELS, kind) ?? readableLabel(kind, 'Business facts');
}

/** Where a fact came from. A source this app does not know shows in a readable form. */
export function factSourceLabel(sourceType: unknown): string {
  return lookup(FACT_SOURCE_LABELS, sourceType) ?? readableLabel(sourceType, 'Unknown source');
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The item and variation names a menu_item fact value may carry, under either field name. */
export function menuItemNames(value: unknown): {item?: string; variation?: string} {
  if (!isRecord(value)) return {};
  return {item: text(value.item) ?? text(value.itemName), variation: text(value.variation) ?? text(value.variationName)};
}

/**
 * The name of a fact for display, never the raw key. An hours key is a day
 * ("Monday"). A service or a question uses its name or question from the
 * value. A menu item uses its item and variation names ("Margherita, Large").
 * Any other key shows in a readable form: "margherita_large" becomes
 * "Margherita large". Names from the value are business text, shown as written.
 */
export function factKeyLabel(kind: unknown, key: unknown, value?: unknown): string {
  if (kind === 'hours') {
    const day = lookup(HOURS_KEY_LABELS, key);
    if (day) return day;
  }
  if (isRecord(value)) {
    if (kind === 'service' && text(value.name)) return text(value.name)!;
    if (kind === 'faq' && text(value.question)) return text(value.question)!;
  }
  if (kind === 'menu_item') {
    const menu = menuItemNames(value);
    if (menu.item) return menu.variation ? `${menu.item}, ${menu.variation}` : menu.item;
  }
  return readableLabel(key, 'Unnamed entry');
}

// ------------------------------------------------------------ agents and approvals

/** Same wording the Build screen used. */
export const AGENT_TEMPLATE_LABELS: Record<AgentTemplate, string> = {
  restaurant_order_taker: 'Restaurant order taker',
  appointment_booker: 'Appointment booker',
  custom: 'Custom agent',
};

/** Same wording the Build screen used. */
export const BUNDLE_LABELS: Record<BundleType, string> = {
  order_bundle: 'Order',
  booking_bundle: 'Booking',
  fact_edit: 'Business fact change',
  price_edit: 'Price change',
};

/** Who opened an approval. Same wording the Approvals screen used. */
export const APPROVAL_ACTOR_LABELS: Record<ApprovalActorType, string> = {
  owner: 'Your own change',
  deployed_agent: 'Asked by your phone agent',
};

/** The template name. A template this app does not know shows in a readable form. */
export function agentTemplateLabel(template: unknown): string {
  return lookup(AGENT_TEMPLATE_LABELS, template) ?? readableLabel(template, 'Agent');
}

/** The bundle name. A bundle this app does not know reads "Request". */
export function bundleLabel(bundleType: unknown): string {
  return lookup(BUNDLE_LABELS, bundleType) ?? 'Request';
}

/** Who opened an approval. An actor this app does not know is not shown as the agent or the owner. */
export function approvalActorLabel(actorType: unknown): string {
  return lookup(APPROVAL_ACTOR_LABELS, actorType) ?? 'Asked for your approval';
}

/** One line per agent tool. Same wording the agent preview used. */
export const TOOL_LABELS: Record<ToolName, string> = {
  read_catalog: 'Looked up the catalog',
  read_business_facts: 'Read business facts',
  quote_order: 'Priced the order',
  propose_order: 'Proposed an order',
  get_order_status: 'Checked an order status',
  read_calendar_availability: 'Checked the calendar',
  propose_booking: 'Proposed a booking',
  propose_menu_message: 'Asked to send the menu (demo)',
};

/**
 * One word per tool effect. The deployed agent has only read and propose
 * tools; the other two are labelled so that no effect is ever shown raw.
 */
export const EFFECT_LABELS: Record<Effect, string> = {
  read: 'Read',
  propose: 'Proposal',
  write: 'Change',
  external_message: 'Customer message',
};

/** The tool line. A tool this app does not know reads "Used a tool". */
export function toolLabel(tool: unknown): string {
  return lookup(TOOL_LABELS, tool) ?? 'Used a tool';
}

/** The effect word. An effect this app does not know shows in a readable form. */
export function effectLabel(effect: unknown): string {
  return lookup(EFFECT_LABELS, effect) ?? readableLabel(effect, 'Other');
}

// ------------------------------------------------------------ providers

/**
 * Every provider key a health record or a webhook can carry. Same wording as
 * PROVIDER_LABELS in components/shell/ConnectionHealth.tsx, plus AgentPhone.
 */
export const PROVIDER_LABELS: Record<IntegrationProvider | WebhookProvider, string> = {
  square: 'Square',
  twilio: 'Twilio',
  openai: 'OpenAI',
  google_calendar: 'Google Calendar',
  google_sheets: 'Google Sheets',
  message_channel: 'Message channel',
  agentphone: 'AgentPhone',
};

/** The provider name. A key this app does not know shows in a readable form. */
export function providerLabel(provider: unknown): string {
  return lookup(PROVIDER_LABELS, provider) ?? readableLabel(provider, 'Unknown provider');
}

// ------------------------------------------------------------ activity events

/** A short title per event type, for a list that has no sentence of its own for the event. */
export const ACTIVITY_EVENT_LABELS: Record<ActivityEventType, string> = {
  'call.started': 'Call started',
  'call.ended': 'Call ended',
  'proposal.created': 'Proposal created',
  'approval.requested': 'Approval requested',
  'approval.decided': 'Approval decided',
  'approval.expired': 'Approval expired',
  'execution.started': 'Step started',
  'execution.succeeded': 'Step done',
  'execution.failed': 'Step failed',
  'checkout.created': 'Checkout link created (sandbox)',
  'message.sent': 'Message sent',
  'message.failed': 'Message failed',
  'payment.verified': 'Payment verified (sandbox)',
  'payment.failed': 'Payment failed (sandbox)',
  'booking.verified': 'Booking verified',
  'booking.slot_conflict': 'Slot taken',
  'order.status_changed': 'Order updated',
  'booking.status_changed': 'Booking updated',
  'sync.queued': 'Sync queued',
  'sync.succeeded': 'Sync done',
  'sync.failed': 'Sync failed',
  'fact.changed': 'Business fact updated',
  'extraction.completed': 'File read',
  'agent.published': 'Agent published',
  'agent.paused': 'Agent paused',
  'live_agent.changed': 'Live agent changed',
  'guardrail.refused': 'The agent refused a request',
  'webhook.rejected': 'Webhook rejected, nothing changed',
};

/** The title for an event type this app does not know. Never the raw type. */
export const UNKNOWN_EVENT_LABEL = 'Other activity';

/** The short title for an event type. A type this app does not know reads UNKNOWN_EVENT_LABEL. */
export function eventTypeLabel(type: unknown): string {
  return lookup(ACTIVITY_EVENT_LABELS, type) ?? UNKNOWN_EVENT_LABEL;
}

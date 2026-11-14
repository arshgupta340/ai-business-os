/**
 * Proves that no contract value labelled in labels.ts reaches the owner raw.
 * Each list is read from the contract schema (`Schema.options`), never copied
 * by hand, so a value added to a contract enum and not labelled fails here.
 */
import {describe, expect, it} from 'vitest';
import {
  ActionTypeSchema,
  ActivityEventTypeSchema,
  AgentTemplateSchema,
  ApprovalActorTypeSchema,
  BundleTypeSchema,
  EffectSchema,
  FactKindSchema,
  FactSourceTypeSchema,
  GuardrailRuleSchema,
  HoursKeySchema,
  IntegrationProviderSchema,
  MessageChannelSchema,
  MessageChannelSettingSchema,
  ToolNameSchema,
  WebhookProviderSchema,
} from '@abos/contracts';
import {expectOwnerLabel, FUTURE_VALUES, NOT_TEXT} from './owner-label.test-helpers';
import {
  ACTION_LABELS,
  ACTION_PROGRESS_LABELS,
  ACTIVITY_EVENT_LABELS,
  AGENT_TEMPLATE_LABELS,
  APPROVAL_ACTOR_LABELS,
  BUNDLE_LABELS,
  EFFECT_LABELS,
  FACT_KIND_GROUP_LABELS,
  FACT_KIND_LABELS,
  FACT_SOURCE_LABELS,
  GUARDRAIL_LABELS,
  HOURS_KEY_LABELS,
  MESSAGE_CHANNEL_LABELS,
  MESSAGE_CHANNEL_NOUNS,
  MESSAGE_CHANNEL_SENDERS,
  PROVIDER_LABELS,
  TOOL_LABELS,
  UNKNOWN_EVENT_LABEL,
  actionLabel,
  actionProgressLabel,
  agentTemplateLabel,
  approvalActorLabel,
  bundleLabel,
  effectLabel,
  eventTypeLabel,
  factKeyLabel,
  factKindGroupLabel,
  factKindLabel,
  factSourceLabel,
  guardrailLabel,
  messageChannelLabel,
  messageChannelNoun,
  messageChannelSender,
  providerLabel,
  toolLabel,
} from './labels';

/** expectOwnerLabel, plus no dotted identifier such as "square.checkout.create". */
function expectPlain(label: unknown, raw: string): void {
  expectOwnerLabel(label, raw);
  expect(label as string, `label for ${raw} has a dotted identifier`).not.toMatch(/\w\.\w/);
}

type Entry = {
  name: string;
  options: readonly string[];
  labels: Record<string, string>;
  lookup: (raw: unknown) => string;
};

const ENTRIES: Entry[] = [
  {name: 'message channel label', options: MessageChannelSettingSchema.options, labels: MESSAGE_CHANNEL_LABELS, lookup: messageChannelLabel},
  {name: 'message channel noun', options: MessageChannelSettingSchema.options, labels: MESSAGE_CHANNEL_NOUNS, lookup: messageChannelNoun},
  {name: 'message channel sender', options: MessageChannelSchema.options, labels: MESSAGE_CHANNEL_SENDERS, lookup: messageChannelSender},
  {name: 'guardrail rule', options: GuardrailRuleSchema.options, labels: GUARDRAIL_LABELS, lookup: guardrailLabel},
  {name: 'action type', options: ActionTypeSchema.options, labels: ACTION_LABELS, lookup: actionLabel},
  {name: 'action progress', options: ActionTypeSchema.options, labels: ACTION_PROGRESS_LABELS, lookup: actionProgressLabel},
  {name: 'fact kind', options: FactKindSchema.options, labels: FACT_KIND_LABELS, lookup: factKindLabel},
  {name: 'fact kind group', options: FactKindSchema.options, labels: FACT_KIND_GROUP_LABELS, lookup: factKindGroupLabel},
  {name: 'fact source', options: FactSourceTypeSchema.options, labels: FACT_SOURCE_LABELS, lookup: factSourceLabel},
  {name: 'agent template', options: AgentTemplateSchema.options, labels: AGENT_TEMPLATE_LABELS, lookup: agentTemplateLabel},
  {name: 'bundle type', options: BundleTypeSchema.options, labels: BUNDLE_LABELS, lookup: bundleLabel},
  {name: 'approval actor', options: ApprovalActorTypeSchema.options, labels: APPROVAL_ACTOR_LABELS, lookup: approvalActorLabel},
  {name: 'tool', options: ToolNameSchema.options, labels: TOOL_LABELS, lookup: toolLabel},
  {name: 'effect', options: EffectSchema.options, labels: EFFECT_LABELS, lookup: effectLabel},
  {
    name: 'provider',
    options: [...new Set([...IntegrationProviderSchema.options, ...WebhookProviderSchema.options])],
    labels: PROVIDER_LABELS,
    lookup: providerLabel,
  },
  {name: 'activity event type', options: ActivityEventTypeSchema.options, labels: ACTIVITY_EVENT_LABELS, lookup: eventTypeLabel},
];

const cases = ENTRIES.flatMap((entry) => entry.options.map((value) => [entry.name, value, entry] as const));

describe('every contract value has its own owner-facing label', () => {
  it('reads a non-empty list for every map', () => {
    for (const entry of ENTRIES) expect(entry.options.length, entry.name).toBeGreaterThan(0);
  });

  it.each(cases)('%s %s', (_name, value, entry) => {
    expect(Object.hasOwn(entry.labels, value), 'no label in labels.ts').toBe(true);
    expectPlain(entry.labels[value], value);
    expect(entry.lookup(value)).toBe(entry.labels[value]);
  });

  it('has no label for a value the contract does not have', () => {
    for (const entry of ENTRIES) expect(Object.keys(entry.labels).sort(), entry.name).toEqual([...entry.options].sort());
  });

  it('labels every hours key as a day', () => {
    for (const key of HoursKeySchema.options) {
      expectPlain(HOURS_KEY_LABELS[key], key);
      expect(factKeyLabel('hours', key)).toBe(HOURS_KEY_LABELS[key]);
    }
  });

  it('says sandbox on every Square payment step while it runs', () => {
    for (const type of ActionTypeSchema.options) {
      if (type.startsWith('square.')) expect(ACTION_PROGRESS_LABELS[type], type).toContain('sandbox');
    }
  });
});

describe('a value this app has never seen', () => {
  const unseen = ENTRIES.flatMap((entry) => FUTURE_VALUES.map((value) => [entry.name, value, entry] as const));

  it.each(unseen)('%s "%s" is never shown raw', (_name, value, entry) => {
    expectPlain(entry.lookup(value), value);
  });

  it('does not crash for a value that is not text', () => {
    for (const entry of ENTRIES) {
      for (const value of NOT_TEXT) expectPlain(entry.lookup(value), String(value));
    }
  });

  it('gives a generic title for an event type it does not know, never a readable form of it', () => {
    expect(eventTypeLabel('email.receipt.send')).toBe(UNKNOWN_EVENT_LABEL);
    expect(eventTypeLabel('constructor')).toBe(UNKNOWN_EVENT_LABEL);
    expect(eventTypeLabel(undefined)).toBe(UNKNOWN_EVENT_LABEL);
  });

  it('does not show an unknown approval actor as the agent or the owner', () => {
    expect(approvalActorLabel('system')).not.toBe(APPROVAL_ACTOR_LABELS.deployed_agent);
    expect(approvalActorLabel('system')).not.toBe(APPROVAL_ACTOR_LABELS.owner);
  });
});

describe('factKeyLabel', () => {
  it('never shows a raw key', () => {
    expect(factKeyLabel('menu_item', 'margherita_large')).toBe('Margherita large');
    expect(factKeyLabel('policy', 'pickup_only')).toBe('Pickup only');
    expect(factKeyLabel('contact', 'phoneNumber')).toBe('Phone number');
    expect(factKeyLabel('hours', 'holiday_hours')).toBe('Holiday hours');
    expect(factKeyLabel('hours', 'mon')).toBe('Monday');
    for (const kind of FactKindSchema.options) {
      for (const key of ['margherita_large', 'pickup_window', 'faq.delivery', 'SOME_KEY']) expectPlain(factKeyLabel(kind, key), key);
      for (const key of NOT_TEXT) expect(factKeyLabel(kind, key)).toBe('Unnamed entry');
    }
  });

  it('uses the names in the value when there are any', () => {
    expect(factKeyLabel('menu_item', 'margherita_large', {item: 'Margherita', variation: 'Large'})).toBe('Margherita, Large');
    expect(factKeyLabel('menu_item', 'margherita_large', {itemName: 'Margherita'})).toBe('Margherita');
    expect(factKeyLabel('service', 'haircut_30', {name: 'Haircut'})).toBe('Haircut');
    expect(factKeyLabel('faq', 'parking', {question: 'Is there parking?'})).toBe('Is there parking?');
    expect(factKeyLabel('service', 'haircut_30', {name: '   '})).toBe('Haircut 30');
    expect(factKeyLabel('policy', 'pickup_only', {name: 'Ignored for a policy'})).toBe('Pickup only');
  });
});

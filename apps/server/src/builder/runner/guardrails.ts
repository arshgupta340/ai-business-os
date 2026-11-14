import type { GuardrailRule, ToolName } from '../pending-contracts';

// A fixed check on each caller message before the model sees it. It is a
// second layer: the model's instructions say the same things, and the tools
// cannot change facts or skip approval whatever the model does. These patterns
// cover the PRD section 13 threat tests; they are not a complete filter.

const RULES: { rule: GuardrailRule; patterns: RegExp[] }[] = [
  {
    rule: 'no_approval_bypass',
    patterns: [/\b(skip|bypass|without|override)\b.{0,30}\bapprov/i, /\bi\s*(am|'m)\s+the\s+owner\b/i],
  },
  {
    rule: 'no_fact_changes',
    patterns: [
      /\b(change|set|make|update|lower|drop|edit)\b.{0,40}\b(price|prices|cost|hours|menu|policy|policies)\b/i,
      /\b(change|set|make)\b.{0,40}(\$\s?0\b|\bzero\b|\bfree\b)/i,
      /\b(give me|apply)\b.{0,20}\bdiscount\b/i,
    ],
  },
  {
    rule: 'no_secret_reveal',
    patterns: [/\b(secret|api key|password|access token|system prompt|your instructions)\b/i],
  },
  {
    rule: 'unsupported_request',
    patterns: [
      /\bignore\b.{0,20}\b(previous|prior|above|all)\b.{0,20}\binstructions\b/i,
      /\b(ignore|forget|break)\b.{0,20}\b(your|the|these|all|my)\b.{0,10}\b(rules|instructions|guardrails)\b/i,
    ],
  },
];

// A refusal names only what this agent can actually do, read from the tools
// its spec grants. A FAQ-only agent must never offer to take an order.
const REFUSAL_OPENERS: Record<GuardrailRule, string> = {
  no_fact_changes: 'I cannot change prices, hours or policies.',
  no_approval_bypass: 'Every order and booking goes to the shop for approval, and I cannot skip that.',
  no_secret_reveal: 'I cannot share that.',
  no_cross_business: 'I can only help with this shop.',
  unsupported_request: 'I cannot do that.',
};

export function refusalReply(rule: GuardrailRule, tools: readonly ToolName[]): string {
  const has = (t: ToolName) => tools.includes(t);
  const opener =
    rule === 'no_approval_bypass' && !has('propose_order') && !has('propose_booking')
      ? 'I cannot skip any rule, and I cannot take orders or bookings on this call.'
      : REFUSAL_OPENERS[rule];
  return [opener, whatICanDo(tools)].filter(Boolean).join(' ');
}

export function whatICanDo(tools: readonly ToolName[]): string {
  const actions: string[] = [];
  if (tools.includes('propose_order')) actions.push('take your order');
  if (tools.includes('propose_booking')) actions.push('book an appointment');
  const topics: string[] = [];
  if (tools.includes('read_catalog')) topics.push('the menu');
  if (tools.includes('read_business_facts')) topics.push('our hours and policies');
  if (tools.includes('read_calendar_availability')) topics.push('open appointment times');
  if (topics.length > 0) actions.push(`answer questions about ${topics.join(' and ')}`);
  if (actions.length === 0) return '';
  const last = actions.pop()!;
  return `I can ${actions.length > 0 ? `${actions.join(', ')} or ${last}` : last}.`;
}

export function checkCallerMessage(text: string): GuardrailRule | undefined {
  for (const { rule, patterns } of RULES) {
    if (patterns.some((p) => p.test(text))) return rule;
  }
  return undefined;
}

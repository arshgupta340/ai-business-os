import type { GuardrailRule } from '../pending-contracts';

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
    patterns: [/\bignore\b.{0,20}\b(previous|prior|above|all)\b.{0,20}\binstructions\b/i],
  },
];

export const REFUSAL_REPLIES: Record<GuardrailRule, string> = {
  no_fact_changes: 'I cannot change prices, hours or policies. I can help you place an order or answer a question about the menu.',
  no_approval_bypass: 'Every order and booking goes to the shop for approval, and I cannot skip that. I can still take your request.',
  no_secret_reveal: 'I cannot share that. I can help with an order, a booking or a question about the shop.',
  no_cross_business: 'I can only help with this shop.',
  unsupported_request: 'I cannot do that. I can help with an order, a booking or a question about the shop.',
};

export function checkCallerMessage(text: string): GuardrailRule | undefined {
  for (const { rule, patterns } of RULES) {
    if (patterns.some((p) => p.test(text))) return rule;
  }
  return undefined;
}

import { AgentSpecSchema, type AgentSpec } from '@abos/contracts';
import { z } from 'zod';

// The package's AgentSpecSchema with the builder's own limits on top. The
// contract allows any name and goal length, a missing goal text and an empty
// capability list. The builder keeps the limits it had before the contract
// merged: a name of at most 80 characters, a goal of 1 to 300, a greeting of
// at most 300, and at least one capability. A spec that passes this also
// passes the contract schema.
export const SPEC_LIMITS = { name: 80, goal: 300, greeting: 300 } as const;

export const BuilderAgentSpecSchema: z.ZodType<AgentSpec> = AgentSpecSchema.superRefine((spec, ctx) => {
  if (spec.name.length > SPEC_LIMITS.name) ctx.addIssue({ code: 'custom', path: ['name'], message: `must be at most ${SPEC_LIMITS.name} characters` });
  if (spec.goal.trim().length === 0) ctx.addIssue({ code: 'custom', path: ['goal'], message: 'must not be empty' });
  if (spec.goal.length > SPEC_LIMITS.goal) ctx.addIssue({ code: 'custom', path: ['goal'], message: `must be at most ${SPEC_LIMITS.goal} characters` });
  if (spec.greeting !== undefined && spec.greeting.length > SPEC_LIMITS.greeting) {
    ctx.addIssue({ code: 'custom', path: ['greeting'], message: `must be at most ${SPEC_LIMITS.greeting} characters` });
  }
  if (spec.capabilities.length === 0) ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'An agent needs at least one capability.' });
});

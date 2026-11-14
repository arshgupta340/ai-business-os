import { z } from 'zod';
import { AgentTemplateSchema, KnowledgeScopeSchema, type AgentSpec, type BuilderMessage } from '../pending-contracts';

// The builder model: one call per owner turn (API.md 3.3). Two implementations:
// OpenAiBuilderModel (Responses API, strict Structured Outputs) and
// RecordedBuilderModel (replays stored outputs, used when OPENAI_API_KEY is absent).

// The structured output of one turn (FLOWS.md step A4 names template,
// capabilityIds, confidence and unsupportedRequests). Strict Structured Outputs
// need every field present, so "no value" is null, not absent.
//
// `capabilityIds` is a plain string list on purpose. The model may name
// anything; the builder checks every entry against the registry after the
// call and removes what is not registered. Nothing here is trusted.
export const BuilderTurnOutputSchema = z.object({
  reply: z.string(),
  template: AgentTemplateSchema.nullable(),
  capabilityIds: z.array(z.string()),
  unsupportedRequests: z.array(z.string()),
  confidence: z.number(),
  name: z.string().nullable(),
  goal: z.string().nullable(),
  greeting: z.string().nullable(),
  knowledgeScopes: z.array(KnowledgeScopeSchema).nullable(),
  answers: z.array(z.object({ field: z.string(), value: z.string() })),
});
export type BuilderTurnOutput = z.infer<typeof BuilderTurnOutputSchema>;

export interface BuilderTurnInput {
  businessName: string;
  ownerText: string;
  history: Pick<BuilderMessage, 'role' | 'text'>[];
  draftSpec: Partial<AgentSpec>;
  missingFields: string[];
  // What the builder already knows, as data for the model to read.
  knownFacts: { kind: string; key: string; value: unknown }[];
}

export interface BuilderModel {
  readonly kind: 'openai' | 'recorded';
  // Returns the raw output. The caller validates it with BuilderTurnOutputSchema
  // and then against the registry. Throws on provider failure.
  turn(input: BuilderTurnInput): Promise<unknown>;
}

export class BuilderModelUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BuilderModelUnavailable';
  }
}

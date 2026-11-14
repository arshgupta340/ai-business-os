import type { ToolName } from '../pending-contracts';

// The model that plays the agent in a text run. It never calls a tool itself:
// it asks the runner through `executeTool`, and the runner decides whether the
// call is allowed, validates the input and records the trace.

export interface AgentTurnInput {
  instructions: string;
  history: { role: 'caller' | 'agent'; text: string }[];
  message: string;
  tools: ToolName[];
  now: Date;
  // Returns the ToolResult for the model to read. Never throws for a refused call.
  executeTool(name: string, input: unknown): Promise<unknown>;
}

export interface AgentModel {
  readonly kind: 'openai' | 'recorded';
  respond(input: AgentTurnInput): Promise<{ reply: string }>;
}

export class AgentModelUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AgentModelUnavailable';
  }
}

import OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS, ToolInputSchemas, type ToolName } from '../pending-contracts';
import { AgentModelUnavailable, type AgentModel, type AgentTurnInput } from './agent-model';

// The real agent model for text runs: OpenAI Responses API with function tools.
// It uses OPENAI_BUILDER_MODEL, because SPEC 3.3 names no separate text model.
//
// NOT RUN: there is no OPENAI_API_KEY yet. Tested only with a fake client.
// Function tools are sent with strict: false because some tool inputs have
// optional fields. The runner validates every tool input with Zod anyway.

export interface ResponsesCreateClient {
  responses: Pick<OpenAI['responses'], 'create'>;
}

const MAX_ROUNDS = 6;

export function toolDefinitions(tools: readonly ToolName[]) {
  return tools.map((name) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(ToolInputSchemas[name]) as Record<string, unknown>;
    return { type: 'function' as const, name, description: TOOL_DESCRIPTIONS[name], parameters, strict: false };
  });
}

export class OpenAiAgentModel implements AgentModel {
  readonly kind = 'openai' as const;
  private readonly client: ResponsesCreateClient;

  constructor(
    private readonly options: { apiKey: string; model: string; timeoutMs?: number },
    client?: ResponsesCreateClient,
  ) {
    this.client = client ?? new OpenAI({ apiKey: options.apiKey, timeout: options.timeoutMs ?? 20_000, maxRetries: 1 });
  }

  async respond(input: AgentTurnInput): Promise<{ reply: string }> {
    const conversation: ResponseInputItem[] = [
      ...input.history.map((m) => ({ role: m.role === 'caller' ? ('user' as const) : ('assistant' as const), content: m.text })),
      { role: 'user', content: input.message },
    ];
    const tools = toolDefinitions(input.tools);

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let response;
      try {
        response = await this.client.responses.create({
          model: this.options.model,
          instructions: input.instructions,
          input: conversation,
          tools,
          parallel_tool_calls: false,
        });
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        throw new AgentModelUnavailable(`openai request failed${typeof status === 'number' ? ` (${status})` : ''}`);
      }
      const calls = response.output.filter((item) => item.type === 'function_call');
      if (calls.length === 0) return { reply: response.output_text.trim() || 'Sorry, could you say that again?' };

      // Hand the model's own output items back, then one result per call.
      conversation.push(...(response.output as ResponseInputItem[]));
      for (const call of calls) {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          args = undefined;
        }
        const result = await input.executeTool(call.name, args);
        conversation.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
      }
    }
    return { reply: 'Sorry, I could not finish that. Could you say it another way?' };
  }
}

// One agent turn over the REAL read and propose tools, shared by sim-call (POST /api/agents/:id/sim-call)
// and the AgentPhone phone path (telephony/agentphone/voice.ts, D-12). Both run the same model, the same
// guardrail check, the same stage logic and the same plain-speech rule, so there is one runner, not three.
//
// It can never skip approval: the model reaches only the read and propose tools the spec grants, a propose
// tool only stores a proposal and opens a PENDING approval, and nothing here can decide one (AGENTS rule 6).
// The caller's words are data (rule 7): they go to the model as the caller's message, never as instructions.
import {
  ToolNameSchema, toolsForCapabilities,
  type AgentSpec, type CallStage, type GuardrailRule, type ToolContext, type ToolName, type ToolTraceEntry,
} from '@abos/contracts';
import type { AgentModel } from '../../builder/runner/agent-model';
import { checkCallerMessage, refusalReply } from '../../builder/runner/guardrails';
import { agentInstructions } from '../../builder/runner/text-runner';
import type { QueryDb } from '../../db/index';
import { AppError } from '../../errors';
import { emitActivity } from '../../policy/activity';
import type { RealToolset } from '../../tools/real/types';
import { nextStage } from '../../voice/relay';
import { PLAIN_SPEECH_RULE, plainSpeech } from './plain';

export const MAX_TOOL_CALLS_PER_TURN = 8;
export const MAX_REPLY_CHARS = 2000;

/** Per-call state the caller keeps between turns. */
export type TurnSession = { toolset: RealToolset; history: { role: 'caller' | 'agent'; text: string }[]; stage: CallStage };

export interface TurnDeps {
  db: QueryDb;
  calls: { updateStage(callId: string, stage: CallStage): Promise<void> };
  model: AgentModel;
  now(): Date;
  newId(prefix: string): string;
}

export interface TurnInput {
  spec: AgentSpec;
  businessName: string;
  businessId: string;
  agentVersionId: string;
  callId: string;
  message: string;
  session: TurnSession;
}

export type TurnResult = { reply: string; toolTrace: ToolTraceEntry[]; refused?: GuardrailRule };

/** The initial stage of a call for this template (the same rule sim-call has always used). */
export function initialTurnStage(spec: AgentSpec): CallStage {
  return spec.template === 'appointment_booker' ? 'INQUIRY' : 'CALL_STARTED';
}

/**
 * Runs one turn. A refused caller message runs no tool (AC-06) and writes guardrail.refused. A model
 * failure throws INTEGRATION_UNAVAILABLE; the caller decides what the person hears.
 */
export async function runAgentTurn(deps: TurnDeps, input: TurnInput): Promise<TurnResult> {
  const { spec, businessId, agentVersionId, callId, session } = input;
  const tools = toolsForCapabilities(spec.capabilities);
  const ctx: ToolContext = { businessId, agentVersionId, callId, correlationId: callId };

  const refused = checkCallerMessage(input.message);
  if (refused) {
    await emitActivity(deps.db, { id: deps.newId('evt_'), businessId, correlationId: callId, type: 'guardrail.refused', actorType: 'deployed_agent',
      occurredAt: deps.now().toISOString(), payload: { callId, reasonCode: 'caller_message', rule: refused } });
    return { reply: plainSpeech(refusalReply(refused, tools)), toolTrace: [], refused };
  }

  session.toolset.clearTrace();
  let calls = 0;
  const executeTool = async (rawName: string, rawInput: unknown): Promise<unknown> => {
    calls += 1;
    if (calls > MAX_TOOL_CALLS_PER_TURN) return { ok: false, reason: 'VALIDATION_FAILED', message: 'Too many tool calls in one turn.' };
    const named = ToolNameSchema.safeParse(rawName);
    // There is no tool for any write or external_message capability (AGENTS rule 6).
    if (!named.success || !tools.includes(named.data)) return { ok: false, reason: 'CAPABILITY_NOT_ALLOWED', message: 'This agent does not have that tool.' };
    const tool: ToolName = named.data;
    const result = await session.toolset.handler.call(tool, (rawInput ?? {}) as never, ctx);
    const stage = nextStage(spec.template, session.stage, tool, result);
    if (stage !== session.stage) { session.stage = stage; await deps.calls.updateStage(callId, stage); }
    return result;
  };
  let reply: string;
  try {
    ({ reply } = await deps.model.respond({
      instructions: `${agentInstructions(spec as Parameters<typeof agentInstructions>[0], input.businessName)}\n${PLAIN_SPEECH_RULE}`,
      history: session.history, message: input.message, tools, now: deps.now(), executeTool,
    }));
  } catch {
    throw new AppError('INTEGRATION_UNAVAILABLE', 'The agent model is not available.', undefined, undefined, { provider: 'openai' });
  }
  // The agent's line is what a caller would hear: no Markdown.
  reply = plainSpeech(reply).slice(0, MAX_REPLY_CHARS);
  session.history.push({ role: 'caller', text: input.message }, { role: 'agent', text: reply });
  return { reply, toolTrace: session.toolset.trace() };
}

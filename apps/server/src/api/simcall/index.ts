// B-31: POST /api/agents/:id/sim-call (SPEC P-18, API 3.4). A simulated call runs a PUBLISHED
// agent's pinned version in text with the REAL read and propose tools. It creates a `calls` row
// with channel `test_console`, so `agentVersionId` always comes from the call (SPEC 2.9).
//
// Why a small runner here: the builder's MockTextRunner refuses any toolset that is not the mock
// one (AC-03), which is right for preview and test, so it cannot be reused for the real toolset.
// This runner reuses the builder's exported pieces instead (the AgentModel interface and its two
// implementations, agentInstructions, checkCallerMessage and refusalReply), without editing them.
//
// It can never skip approval: the model reaches only the seven read and propose tools, a propose
// tool only stores a proposal and opens a PENDING approval, and nothing here can decide one.
import {
  ENDPOINTS, ToolNameSchema, toolsForCapabilities, AgentSpecSchema,
  type AgentSpec, type AgentRunResponse, type CallStage, type CapabilityId, type ToolContext, type ToolName,
} from '@abos/contracts';
import type { FastifyInstance } from 'fastify';
import type { AgentModel } from '../../builder/runner/agent-model';
import { checkCallerMessage, refusalReply } from '../../builder/runner/guardrails';
import { agentInstructions } from '../../builder/runner/text-runner';
import type { Db } from '../../db/index';
import { AppError } from '../../errors';
import { emitActivity } from '../../policy/activity';
import type { RealToolset } from '../../tools/real/types';
import { nextStage } from '../../voice/relay';
import { PLAIN_SPEECH_RULE, plainSpeech } from './plain';
import type { CallsStore } from '../../compose/ports';

const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_SESSIONS = 200;

export interface SimCallDeps {
  db: Db;
  calls: CallsStore;
  /** One real toolset per call, built once, so the call keeps the facts it started with (AC-16). */
  toolsetFor(ctx: { businessId: string; agentVersionId: string; callId: string; capabilities: readonly CapabilityId[] }): RealToolset;
  /** The model behind an interface, so tests inject a scripted one. */
  model: AgentModel;
  now(): Date;
  newId(prefix: string): string;
  /** Structured logger. A refused tool is logged by name length only, never its name or arguments. */
  log?: { warn(data: Record<string, unknown>, msg: string): void };
}

type Session = { toolset: RealToolset; history: { role: 'caller' | 'agent'; text: string }[]; stage: CallStage };

export function registerSimCall(app: FastifyInstance, deps: SimCallDeps): void {
  // SPEC 2.9 "Not persisted": test sessions live in server memory. After a restart a call's next
  // turn rebuilds its toolset, which then reads the facts current at that moment.
  const sessions = new Map<string, Session>();
  const endpoint = ENDPOINTS.simCall;

  app.post(endpoint.path, async (request) => {
    const params = endpoint.params?.safeParse(request.params);
    const body = endpoint.body?.safeParse(request.body ?? {});
    if (!params?.success || !body?.success) throw new AppError('VALIDATION_FAILED', 'Request validation failed.');
    const { id: agentId } = params.data as { id: string };
    const input = body.data as { message: string; callId?: string; end?: boolean };
    const businessId = request.businessId ?? '';

    const agent = (await deps.db.query(`select a.state, a.active_version_id, a.template, b.name as business_name, v.spec
      from public.agents a join public.businesses b on b.id = a.business_id left join public.agent_versions v on v.id = a.active_version_id
      where a.id = $1 and a.business_id = $2`, [agentId, businessId])).rows[0] as Record<string, unknown> | undefined;
    if (!agent) throw new AppError('NOT_FOUND', 'Agent was not found in this business.');

    let callId: string;
    let agentVersionId: string;
    let spec: AgentSpec;
    if (input.callId === undefined) {
      if (agent.state !== 'live' || typeof agent.active_version_id !== 'string') {
        throw new AppError('INVALID_STATE', 'Only a published live agent can take a simulated call.', undefined, undefined, { state: String(agent.state) });
      }
      const parsed = AgentSpecSchema.safeParse(agent.spec);
      if (!parsed.success) throw new AppError('INVALID_STATE', 'The published version has no valid spec.');
      spec = parsed.data;
      agentVersionId = agent.active_version_id;
      ({ callId } = await deps.calls.startSimulatedCall({ businessId, agentId, agentVersionId }));
    } else {
      const call = (await deps.db.query(`select c.status, c.agent_version_id, c.channel, c.stage, v.spec from public.calls c
        join public.agent_versions v on v.id = c.agent_version_id where c.id = $1 and c.business_id = $2 and c.agent_id = $3`,
      [input.callId, businessId, agentId])).rows[0] as Record<string, unknown> | undefined;
      if (!call || call.channel !== 'test_console') throw new AppError('NOT_FOUND', 'Simulated call was not found.');
      if (call.status !== 'IN_PROGRESS') throw new AppError('INVALID_STATE', 'This simulated call has ended.', undefined, undefined, { state: String(call.status) });
      const parsed = AgentSpecSchema.safeParse(call.spec);
      if (!parsed.success) throw new AppError('INVALID_STATE', 'The pinned version has no valid spec.');
      // The version stays pinned for the whole call, whatever was published since.
      spec = parsed.data;
      agentVersionId = String(call.agent_version_id);
      callId = input.callId;
      if (!sessions.has(callId)) {
        sessions.set(callId, { toolset: deps.toolsetFor({ businessId, agentVersionId, callId, capabilities: spec.capabilities }), history: [], stage: call.stage as CallStage });
      }
    }
    let session = sessions.get(callId);
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
      session = { toolset: deps.toolsetFor({ businessId, agentVersionId, callId, capabilities: spec.capabilities }), history: [], stage: spec.template === 'appointment_booker' ? 'INQUIRY' : 'CALL_STARTED' };
      sessions.set(callId, session);
    }

    const tools = toolsForCapabilities(spec.capabilities);
    const ctx: ToolContext = { businessId, agentVersionId, callId, correlationId: callId };
    let response: AgentRunResponse;

    const refused = checkCallerMessage(input.message);
    if (refused) {
      // AC-06: a refused attempt runs no tool.
      await emitActivity(deps.db, { id: deps.newId('evt_'), businessId, correlationId: callId, type: 'guardrail.refused', actorType: 'deployed_agent',
        occurredAt: deps.now().toISOString(), payload: { callId, reasonCode: 'caller_message', rule: refused } });
      response = { callId, reply: plainSpeech(refusalReply(refused, tools)), toolTrace: [], guardrail: { refused: true, rule: refused } };
    } else {
      session.toolset.clearTrace();
      let calls = 0;
      const s = session;
      const executeTool = async (rawName: string, rawInput: unknown): Promise<unknown> => {
        calls += 1;
        if (calls > MAX_TOOL_CALLS_PER_TURN) return { ok: false, reason: 'VALIDATION_FAILED', message: 'Too many tool calls in one turn.' };
        const named = ToolNameSchema.safeParse(rawName);
        // There is no tool for any write or external_message capability (AGENTS rule 6).
        if (!named.success || !tools.includes(named.data)) {
          // Recorded as the phone relay records it: guardrail.refused with a fixed code, and a log line with
          // the name's length only. The name and the arguments came from the model and are never stored.
          const known = named.success ? named.data : undefined;
          deps.log?.warn({ callId, tool: known ?? 'unknown_tool', nameLength: rawName.length }, known ? 'sim-call: model asked for a tool this agent does not have' : 'sim-call: model asked for an unknown tool');
          await emitActivity(deps.db, { id: deps.newId('evt_'), businessId, correlationId: callId, type: 'guardrail.refused', actorType: 'deployed_agent',
            occurredAt: deps.now().toISOString(), payload: { callId, rule: 'unsupported_request', reasonCode: known ? 'tool_not_allowed' : 'unknown_tool', ...(known ? { toolName: known } : {}) } });
          return { ok: false, reason: 'CAPABILITY_NOT_ALLOWED', message: 'This agent does not have that tool.' };
        }
        const tool: ToolName = named.data;
        const result = await s.toolset.handler.call(tool, (rawInput ?? {}) as never, ctx);
        const stage = nextStage(spec.template, s.stage, tool, result);
        if (stage !== s.stage) { s.stage = stage; await deps.calls.updateStage(callId, stage); }
        return result;
      };
      let reply: string;
      try {
        ({ reply } = await deps.model.respond({
          instructions: `${agentInstructions(spec as Parameters<typeof agentInstructions>[0], String(agent.business_name))}\n${PLAIN_SPEECH_RULE}`,
          history: s.history, message: input.message, tools, now: deps.now(), executeTool,
        }));
      } catch {
        throw new AppError('INTEGRATION_UNAVAILABLE', 'The agent model is not available.', undefined, undefined, { provider: 'openai' });
      }
      // The agent's line is what a caller would hear: no Markdown.
      reply = plainSpeech(reply).slice(0, 2000);
      s.history.push({ role: 'caller', text: input.message }, { role: 'agent', text: reply });
      response = { callId, reply, toolTrace: s.toolset.trace() };
    }

    if (input.end) {
      await deps.calls.endCall(callId, 'completed');
      sessions.delete(callId);
    }
    const checked = endpoint.response.safeParse(response);
    if (!checked.success) throw new AppError('INTERNAL', 'Response validation failed.');
    return checked.data;
  });
}

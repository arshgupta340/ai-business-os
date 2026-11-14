// One AgentPhone call turn to our agent (D-12). AgentPhone runs in `webhook` voice mode: it transcribes the
// caller and posts each turn; we answer with text it speaks (docs/notes-agentphone.md, "A voice turn").
// Not the vendor's "hosted" mode: there AgentPhone's own model would answer, outside our tools and approvals.
//
// Each turn: resolve the live agent for the dialed number, create or continue the call record, run ONE turn
// through the shared sim-call runner (same model, same real read and propose toolset, same guardrails and
// stage logic), and return plain spoken sentences. The toolset has read and propose tools only (rule 6); the
// transcript is the caller's message, data only (rule 7). No phone number, key or transcript is logged.
//
// One turn of a call at a time. Turns of one call are queued, so a barge-in, a late turn or two first turns
// never run two model turns over the same history, stage and toolset (the toolset holds the guards against
// a second proposal). One bound covers waiting and running: when it passes, the caller hears a fixed
// apology, the turn is abandoned (it starts no further tool call and its unheard reply is not kept), and the
// next turn waits only for a tool call that is still running.
import { AgentSpecSchema, type AgentSpec, type CallEndReason, type CapabilityId, type MessageChannelSetting, type ToolName } from '@abos/contracts';
import type { AgentModel } from '../../builder/runner/agent-model';
import type { QueryDb } from '../../db/index';
import type { CallsStore } from '../../compose/ports';
import type { RealToolset } from '../../tools/real/types';
import { checkSessionCapabilities } from '../../voice/relay';
import type { CallDecision, CallDecisionsPort, LiveAgentPort } from '../../voice/types';
import { initialTurnStage, runAgentTurn, type TurnSession } from '../../api/simcall/turn';
import type { TurnReply } from '../types';

export const SPEECH = {
  notTakingCalls: 'Sorry, this number is not taking calls right now. Goodbye.',
  callEnded: 'This call has ended. Goodbye.',
  trouble: 'Sorry, I am having trouble right now. Please try again in a moment.',
  didNotHear: 'Sorry, I did not catch that. Could you say it again?',
  oneMoment: 'One moment.',
} as const;

/** What the caller hears when the owner decided since the last turn. Approved never means paid or booked. */
export function decisionSpeech(template: AgentSpec['template'], decision: CallDecision): string {
  if (decision.kind === 'approved') {
    return template === 'appointment_booker'
      ? 'An update from the shop: your booking request was approved. The shop will confirm the appointment.'
      : 'An update from the shop: your order was approved. Ask at the counter for the payment link. Nothing is paid yet.';
  }
  if (decision.kind === 'rejected') return 'An update from the shop: the shop could not accept your request.';
  return 'An update from the shop: the request expired before the shop answered.';
}

type Session = TurnSession & { spec: AgentSpec; tools: ToolName[]; businessId: string; businessName: string; agentVersionId: string; callId: string;
  decision?: CallDecision | undefined; unsubscribe(): void;
  /** Set when the call ended or the session was evicted: a turn still running stops acting. */
  closed: boolean };

export interface AgentPhoneVoiceDeps {
  db: QueryDb;
  liveAgent: LiveAgentPort;
  calls: CallsStore;
  toolsetFor(ctx: { businessId: string; agentVersionId: string; callId: string; capabilities: readonly CapabilityId[] }): RealToolset;
  model: AgentModel;
  /** The server's MESSAGE_CHANNEL setting, which the phone prompt takes (shared runner). */
  messageChannel: MessageChannelSetting;
  decisions?: CallDecisionsPort | undefined;
  now(): Date;
  newId(prefix: string): string;
  /** A refused tool is logged by name length only (shared runner). */
  log?: { warn(data: Record<string, unknown>, msg: string): void } | undefined;
  /** Bound on one turn; AgentPhone's own default webhook timeout is 30 seconds. */
  turnTimeoutMs?: number;
}

export const MAX_SESSIONS = 200;
export const DEFAULT_TURN_TIMEOUT_MS = 20_000;

export type TurnOutcome = { reply: TurnReply; businessId: string | undefined; callId: string | undefined };

export function createAgentPhoneVoice(deps: AgentPhoneVoiceDeps) {
  // Per-process call state, as for sim-call. After a restart a call continues with a fresh history and a
  // fresh toolset (whose facts are read again at that moment); the call row and its pinned version stay.
  const sessions = new Map<string, Session>();
  // Per call: settles when every turn accepted so far has gone quiet. The next turn waits on it.
  const queues = new Map<string, Promise<void>>();

  function drop(providerCallId: string) {
    const s = sessions.get(providerCallId);
    if (!s) return;
    sessions.delete(providerCallId);
    s.closed = true;
    s.unsubscribe();
    s.toolset.dispose();
  }

  async function session(providerCallId: string, to: string, callerLast4: string | undefined): Promise<Session | { speak: TurnReply; businessId?: string }> {
    const existing = sessions.get(providerCallId);
    if (existing) {
      const status = await deps.calls.getStatus(existing.callId);
      if (status !== 'IN_PROGRESS') { drop(providerCallId); return { speak: { text: SPEECH.callEnded, hangup: true }, businessId: existing.businessId }; }
      return existing;
    }
    // A call we already know (another process or a restart): continue on its pinned version.
    let row = (await deps.db.query(`select c.id, c.status, c.business_id, c.agent_version_id, c.stage, v.spec, b.name as business_name
      from public.calls c join public.agent_versions v on v.id = c.agent_version_id join public.businesses b on b.id = c.business_id
      where c.provider_call_id = $1`, [providerCallId])).rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      const live = await deps.liveAgent.resolve(to);
      if (live.state !== 'live') return { speak: { text: SPEECH.notTakingCalls, hangup: true } };
      try {
        await deps.calls.startCall({ businessId: live.businessId, agentId: live.agentId, agentVersionId: live.agentVersionId, providerCallId, callerLast4 });
      } catch { /* A concurrent first turn won the insert; read its row below. */ }
      row = (await deps.db.query(`select c.id, c.status, c.business_id, c.agent_version_id, c.stage, v.spec, b.name as business_name
        from public.calls c join public.agent_versions v on v.id = c.agent_version_id join public.businesses b on b.id = c.business_id
        where c.provider_call_id = $1`, [providerCallId])).rows[0] as Record<string, unknown> | undefined;
      if (!row) return { speak: { text: SPEECH.trouble }, businessId: live.businessId };
    }
    const businessId = String(row.business_id);
    if (row.status !== 'IN_PROGRESS') return { speak: { text: SPEECH.callEnded, hangup: true }, businessId };
    const spec = AgentSpecSchema.safeParse(row.spec);
    if (!spec.success) return { speak: { text: SPEECH.notTakingCalls, hangup: true }, businessId };
    // The phone path's session check (voice/relay.ts), as for Twilio and sim-call: a pinned spec with a
    // capability an agent may not hold takes no call, rather than running with it filtered out.
    const check = checkSessionCapabilities(spec.data);
    if (!check.ok) {
      deps.log?.warn({ agentVersionId: String(row.agent_version_id), unknown: check.unknown.length, notAllowed: check.notAllowed.length }, 'agentphone: agent spec has a capability that is not allowed; call refused');
      return { speak: { text: SPEECH.notTakingCalls, hangup: true }, businessId };
    }
    const callId = String(row.id);
    const agentVersionId = String(row.agent_version_id);
    if (sessions.size >= MAX_SESSIONS) drop(sessions.keys().next().value as string);
    const s: Session = {
      spec: spec.data, tools: check.tools, businessId, businessName: String(row.business_name), agentVersionId, callId,
      toolset: deps.toolsetFor({ businessId, agentVersionId, callId, capabilities: spec.data.capabilities }),
      history: [], stage: (typeof row.stage === 'string' ? row.stage : initialTurnStage(spec.data)) as TurnSession['stage'],
      unsubscribe: () => undefined, closed: false,
    };
    // An owner decision cannot be pushed into the call (no documented API in webhook mode); it is spoken
    // at the caller's next turn. Only a decision on this call's own proposal arrives here (decisions.ts).
    if (deps.decisions) s.unsubscribe = deps.decisions.subscribe(callId, (d) => { s.decision = d; });
    sessions.set(providerCallId, s);
    return s;
  }

  return {
    /** Number of live sessions (tests). */
    get size() { return sessions.size; },
    /** The tools the agent of a call holds (tests prove no write or external_message tool). */
    toolsOf(providerCallId: string) { const s = sessions.get(providerCallId); return s ? [...s.tools] : undefined; },

    async turn(input: { providerCallId: string; to: string; callerLast4?: string | undefined; text: string }): Promise<TurnOutcome> {
      const id = input.providerCallId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS); });

      // Take this call's place in line. `release` lets the next turn of the call go.
      const before = queues.get(id) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => { release = resolve; });
      const tail = before.then(() => mine);
      queues.set(id, tail);
      void tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });

      let running = false;
      try {
        // Earlier work on this call is still going: nothing runs, and a pending owner decision is kept for later.
        if (await Promise.race([before.then(() => 'go' as const), deadline]) === 'timeout') {
          return { reply: { text: SPEECH.trouble }, businessId: sessions.get(id)?.businessId, callId: undefined };
        }
        const s = await session(id, input.to, input.callerLast4);
        if ('speak' in s) return { reply: s.speak, businessId: s.businessId, callId: undefined };
        const text = input.text.trim().slice(0, 2000);
        const update = s.decision ? `${decisionSpeech(s.spec.template, s.decision)} ` : '';
        s.decision = undefined;
        if (!text) return { reply: { text: `${update}${SPEECH.didNotHear}` }, businessId: s.businessId, callId: s.callId };

        // The turn is quiet, and the next one may start, when it has finished, or when it was abandoned and
        // no tool call of its own is still running (an abandoned turn can start no new one).
        let abandoned = false;
        let finished = false;
        let toolsRunning = 0;
        const quiet = () => { if (finished || ((abandoned || s.closed) && toolsRunning === 0)) release(); };
        const run = runAgentTurn(deps, { spec: s.spec, businessName: s.businessName, businessId: s.businessId, agentVersionId: s.agentVersionId, callId: s.callId, message: text, session: s, tools: s.tools,
          abandoned: () => abandoned || s.closed,
          onToolCall: (settled) => { toolsRunning += 1; void settled.then(() => { toolsRunning -= 1; quiet(); }); } });
        running = true;
        void run.then(() => undefined, () => undefined).then(() => { finished = true; quiet(); });
        try {
          const result = await Promise.race([run, deadline]);
          if (result === 'timeout') {
            // The late answer is dropped; the caller is asked to repeat rather than hear a stale reply.
            abandoned = true;
            quiet();
            return { reply: { text: `${update}${SPEECH.trouble}` }, businessId: s.businessId, callId: s.callId };
          }
          return { reply: { text: `${update}${result.reply}`.trim() || SPEECH.didNotHear }, businessId: s.businessId, callId: s.callId };
        } catch {
          return { reply: { text: `${update}${SPEECH.trouble}` }, businessId: s.businessId, callId: s.callId };
        }
      } finally {
        clearTimeout(timer);
        if (!running) release();
      }
    },

    /** AgentPhone's agent.call_ended: end the call record once and dispose its state. */
    async ended(input: { providerCallId: string; reason: CallEndReason }): Promise<{ businessId: string | undefined }> {
      drop(input.providerCallId);
      const call = await deps.calls.findByProviderCallId(input.providerCallId);
      if (!call) return { businessId: undefined };
      const row = (await deps.db.query('select business_id from public.calls where id = $1', [call.callId])).rows[0] as { business_id?: string } | undefined;
      if (call.status === 'IN_PROGRESS') await deps.calls.endCall(call.callId, input.reason);
      return { businessId: row?.business_id };
    },

    dispose() { for (const key of [...sessions.keys()]) drop(key); queues.clear(); },
  };
}

export type AgentPhoneVoice = ReturnType<typeof createAgentPhoneVoice>;

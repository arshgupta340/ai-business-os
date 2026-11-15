// One AgentPhone call turn to our agent (D-12). AgentPhone runs in `webhook` voice mode: it transcribes the
// caller and posts each turn; we answer with text it speaks (docs/notes-agentphone.md, "A voice turn").
// Not the vendor's "hosted" mode: there AgentPhone's own model would answer, outside our tools and approvals.
//
// Each turn: resolve the live agent for the dialed number, create or continue the call record, run ONE turn
// and return plain spoken sentences. Two turn engines, chosen by AGENTPHONE_TURN_ENGINE:
// - `realtime` (the default): one OpenAI Realtime session per call in text mode (realtime.ts), with the phone
//   prompt, the shop data pinned at call start and the channel rules (speech.ts). If the session cannot be
//   opened or fails mid-call, that call falls back to the builder runner, and the log says which engine answered.
//   On these calls the server speaks the greeting, and once a proposal is stored it speaks the closing line
//   and answers `hangup: true`.
// - `builder`: the shared sim-call runner (same model, same real read and propose toolset, same guardrails
//   and stage logic), exactly as before.
// The toolset has read and propose tools only (rule 6); the transcript is the caller's message, data only
// (rule 7). No phone number, key, transcript or reply is logged.
//
// One turn of a call at a time. Turns of one call are queued, so a barge-in, a late turn or two first turns
// never run two model turns over the same history, stage and toolset (the toolset holds the guards against
// a second proposal). One bound covers waiting and running: when it passes, the caller hears a fixed
// apology, the turn is abandoned (it starts no further tool call and its unheard reply is not kept), and the
// next turn waits only for a tool call that is still running.
import { AgentSpecSchema, REALTIME_MODEL, type AgentSpec, type CallEndReason, type CallStage, type CapabilityId, type CatalogItem, type MessageChannelSetting, type ToolName } from '@abos/contracts';
import type { AgentModel } from '../../builder/runner/agent-model';
import type { QueryDb } from '../../db/index';
import type { CallsStore } from '../../compose/ports';
import { emitActivity } from '../../policy/activity';
import type { FactsSnapshot, RealToolset } from '../../tools/real/types';
import { buildInstructions } from '../../voice/prompt';
import { checkSessionCapabilities, nextStage, withDeadline } from '../../voice/relay';
import type { CallDecision, CallDecisionsPort, LiveAgentPort, OpenAISocketFactory } from '../../voice/types';
import { initialTurnStage, runAgentTurn, MAX_REPLY_CHARS, type TurnSession } from '../../api/simcall/turn';
import { plainSpeech } from '../../api/simcall/plain';
import type { TurnReply } from '../types';
import { isStoredProposal, openRealtimeCall, type RealtimeCall, type RealtimeCallDeps, type TurnHooks } from './realtime';
import { afterProposalLine, agentPhoneChannelLines, agentPhoneGreeting, agentPhoneGreetingLead, closingLine, isHelloOnly, sayableName, toolLimitLine } from './speech';

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

export type TurnEngine = 'realtime' | 'builder';
/**
 * first_reply (the default): the server speaks the greeting on the call's first event, alone when the event
 * has no words or only a hello, or its shop name and AI disclosure before the first answer. begin_message: AgentPhone is trusted to speak the agent's
 * beginMessage (its connector schema calls that field hosted mode only, so this is not the default).
 */
export type GreetingMode = 'begin_message' | 'first_reply';

/** The realtime engine's settings and ports (compose/agentphone.ts). */
export interface AgentPhoneRealtimeOptions {
  socketFactory: OpenAISocketFactory;
  model?: string | undefined;
  /** The fact snapshot pinned at call start, as the Twilio webhook pins it. */
  facts: { snapshot(businessId: string): Promise<FactsSnapshot> };
  /** The cached menu, read once at call start for the prompt. Best effort. */
  menu?: { snapshot(businessId: string): Promise<readonly CatalogItem[]> } | undefined;
  menuTimeoutMs?: number | undefined;
  /** AGENTPHONE_GREETING. Used only when it carries the AI disclosure. */
  greeting?: string | undefined;
  greetingMode?: GreetingMode | undefined;
  /** Engine bounds (tests pass short ones). */
  limits?: Pick<RealtimeCallDeps, 'maxToolCalls' | 'maxProposals' | 'toolTimeoutMs' | 'openTimeoutMs' | 'turnLimitMs' | 'idleMs'> | undefined;
}

type Session = TurnSession & { spec: AgentSpec; businessId: string; businessName: string; agentVersionId: string; callId: string;
  decision?: CallDecision | undefined; unsubscribe(): void;
  /** Set when the call ended or the session was evicted: a turn still running stops acting. */
  closed: boolean;
  /** The call was started with the realtime engine selected: the greeting and hangup rules apply. */
  channelRules: boolean;
  /** The runner for the next turn. A realtime call that fails moves to `builder` for the rest of the call. */
  engine: TurnEngine;
  rt?: Promise<RealtimeCall | undefined> | undefined;
  greeting: string;
  greeted: boolean;
  /** A proposal is stored on this call: every later turn hears one short line and the call hangs up. */
  proposed: boolean;
  /** The tool-call cap ended the call. */
  limitEnded: boolean;
  facts?: FactsSnapshot | undefined;
  menu?: readonly CatalogItem[] | undefined;
  turnMs: number[];
  toolCalls: number;
  fallbackTurns: number };

export interface AgentPhoneVoiceDeps {
  db: QueryDb;
  liveAgent: LiveAgentPort;
  calls: CallsStore;
  toolsetFor(ctx: { businessId: string; agentVersionId: string; callId: string; capabilities: readonly CapabilityId[]; facts?: FactsSnapshot | undefined }): RealToolset;
  /** The builder text model. Absent: the builder runner is not available (a realtime call that fails hears an apology). */
  model?: AgentModel | undefined;
  /** The server's MESSAGE_CHANNEL setting, which the phone prompt takes (shared runner). */
  messageChannel: MessageChannelSetting;
  decisions?: CallDecisionsPort | undefined;
  now(): Date;
  newId(prefix: string): string;
  /** A refused tool is logged by name length only (shared runner). Turn and call-end lines carry timings and counts only. */
  log?: { info?(data: Record<string, unknown>, msg: string): void; warn(data: Record<string, unknown>, msg: string): void } | undefined;
  /** Bound on one turn; AgentPhone's own default webhook timeout is 30 seconds. */
  turnTimeoutMs?: number;
  /** AGENTPHONE_TURN_ENGINE. Default here: builder (compose passes the setting, whose default is realtime). */
  engine?: TurnEngine | undefined;
  realtime?: AgentPhoneRealtimeOptions | undefined;
}

export const MAX_SESSIONS = 200;
export const DEFAULT_TURN_TIMEOUT_MS = 20_000;
/** The realtime path's turn bound: under the 10 second webhook timeout registration sets. */
export const REALTIME_TURN_TIMEOUT_MS = 9_000;
const MENU_SNAPSHOT_TIMEOUT_MS = 1_500;

export type TurnOutcome = { reply: TurnReply; businessId: string | undefined; callId: string | undefined };
type RunResult = { reply: string; hangup?: boolean; engine: TurnEngine; toolCalls: number };

const isPropose = (t: ToolName) => t === 'propose_order' || t === 'propose_booking';
/** The caller's name from a propose call's arguments (order contact or booking customer). */
function proposedName(args: unknown): string | undefined {
  const a = args as { contact?: { name?: unknown }; customer?: { name?: unknown } } | null;
  return sayableName(a?.contact?.name ?? a?.customer?.name);
}

function summary(ms: number[]) {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { turns: ms.length, turnsMs: ms.slice(0, 50), p50Ms: at(0.5), maxMs: sorted[sorted.length - 1] };
}

export function createAgentPhoneVoice(deps: AgentPhoneVoiceDeps) {
  // Per-process call state, as for sim-call. After a restart a call continues with a fresh history and a
  // fresh toolset (whose facts are read again at that moment); the call row and its pinned version stay.
  const sessions = new Map<string, Session>();
  // Per call: settles when every turn accepted so far has gone quiet. The next turn waits on it.
  const queues = new Map<string, Promise<void>>();
  const realtimeOn = deps.engine === 'realtime' && deps.realtime !== undefined;
  const info = (data: Record<string, unknown>, msg: string) => deps.log?.info?.(data, msg);

  function closeRt(s: Session, why: string) {
    const rt = s.rt;
    s.rt = undefined;
    void rt?.then((c) => c?.close(why));
  }

  function drop(providerCallId: string) {
    const s = sessions.get(providerCallId);
    if (!s) return;
    sessions.delete(providerCallId);
    s.closed = true;
    s.unsubscribe();
    closeRt(s, 'call_end');
    s.toolset.dispose();
    if (s.turnMs.length > 0) info({ callId: s.callId, engine: s.engine, ...summary(s.turnMs), toolCalls: s.toolCalls, fallbackTurns: s.fallbackTurns }, 'agentphone: call ended');
  }

  /** Opens the call's realtime session. A failure moves the call to the builder runner. */
  function openRt(s: Session) {
    const rto = deps.realtime;
    if (!rto || s.rt || s.engine !== 'realtime') return;
    const check = checkSessionCapabilities(s.spec);
    if (!check.ok) { s.engine = 'builder'; return; }
    const tools = check.tools;
    const instructions = `${buildInstructions(s.spec, { businessName: s.businessName, messageChannel: 'qr_only', facts: s.facts, menu: s.menu, nowMs: deps.now().getTime() })}\n${agentPhoneChannelLines(s.greeting, s.businessName)}`;
    s.rt = openRealtimeCall({
      socketFactory: rto.socketFactory, model: rto.model ?? REALTIME_MODEL, instructions, tools, handler: s.toolset.handler,
      ctx: { businessId: s.businessId, agentVersionId: s.agentVersionId, callId: s.callId, correlationId: s.callId },
      ...rto.limits,
      onToolResult: async (e) => {
        info({ callId: s.callId, tool: e.tool, ok: e.ok, latencyMs: e.latencyMs }, 'agentphone: tool call');
        const stage = nextStage(s.spec.template, s.stage, e.tool, e.result);
        if (stage !== s.stage) { s.stage = stage; await deps.calls.updateStage(s.callId, stage); }
      },
      onRefused: ({ reasonCode, tool }) => {
        deps.log?.warn({ callId: s.callId, reasonCode, tool: tool ?? 'unknown_tool' }, 'agentphone: function call refused');
        void emitActivity(deps.db, { id: deps.newId('evt_'), businessId: s.businessId, correlationId: s.callId, type: 'guardrail.refused', actorType: 'deployed_agent',
          occurredAt: deps.now().toISOString(), payload: { callId: s.callId, rule: 'unsupported_request', reasonCode, ...(tool ? { toolName: tool } : {}) } }).catch(() => undefined);
      },
      onClose: (why) => { if (why !== 'call_end' && why !== 'hangup') deps.log?.warn({ callId: s.callId, why }, 'agentphone: realtime session closed'); },
    }).then((c) => c, (err: unknown) => {
      deps.log?.warn({ callId: s.callId, why: (err as { why?: unknown }).why ?? 'unknown' }, 'agentphone: realtime session not opened; this call uses the builder runner');
      s.engine = 'builder';
      return undefined;
    });
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
      // The phone path's check, before the call starts (voice/plugin.ts does the same at the Twilio webhook):
      // a published spec with a capability an agent may not hold takes no call, and no call row is made.
      const allowed = checkSessionCapabilities(live.spec);
      if (!allowed.ok) {
        deps.log?.warn({ agentVersionId: live.agentVersionId, unknown: allowed.unknown.length, notAllowed: allowed.notAllowed.length }, 'agentphone: live agent has a capability that is not allowed; call refused');
        return { speak: { text: SPEECH.notTakingCalls, hangup: true }, businessId: live.businessId };
      }
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
    const callId = String(row.id);
    const agentVersionId = String(row.agent_version_id);
    // A call that is already running on a spec the check refuses (it started before the check existed, or
    // in another process): the call fails, as on the Twilio socket. The turn runner would refuse it too.
    const capCheck = checkSessionCapabilities(spec.data);
    if (!capCheck.ok) {
      deps.log?.warn({ agentVersionId }, 'agentphone: pinned spec has a capability that is not allowed; call ended');
      await deps.calls.endCall(callId, 'failed');
      return { speak: { text: SPEECH.notTakingCalls, hangup: true }, businessId };
    }
    const businessName = String(row.business_name);
    const stage = (typeof row.stage === 'string' ? row.stage : initialTurnStage(spec.data)) as CallStage;

    // The realtime engine pins the shop data now, as the Twilio webhook does (FLOWS B2): the facts snapshot
    // travels with the call into the prompt and the toolset, and the cached menu is read once for the prompt.
    let engine: TurnEngine = realtimeOn ? 'realtime' : 'builder';
    let facts: FactsSnapshot | undefined;
    let menu: CatalogItem[] | undefined;
    if (engine === 'realtime' && deps.realtime) {
      try {
        facts = structuredClone(await deps.realtime.facts.snapshot(businessId));
      } catch {
        deps.log?.warn({ callId }, 'agentphone: could not read the fact snapshot; this call uses the builder runner');
        engine = 'builder';
      }
      if (engine === 'realtime' && deps.realtime.menu && capCheck.tools.includes('read_catalog')) {
        const read = await withDeadline(deps.realtime.menu.snapshot(businessId), deps.realtime.menuTimeoutMs ?? MENU_SNAPSHOT_TIMEOUT_MS, undefined);
        if (read !== undefined) menu = structuredClone([...read]).filter((item) => item.businessId === businessId);
        else deps.log?.warn({ callId }, 'agentphone: the menu was not read for the prompt; the agent will use read_catalog');
      }
    }
    if (sessions.size >= MAX_SESSIONS) drop(sessions.keys().next().value as string);
    const s: Session = {
      spec: spec.data, businessId, businessName, agentVersionId, callId,
      toolset: deps.toolsetFor({ businessId, agentVersionId, callId, capabilities: spec.data.capabilities, ...(facts ? { facts } : {}) }),
      history: [], stage,
      unsubscribe: () => undefined, closed: false,
      channelRules: realtimeOn, engine, greeting: agentPhoneGreeting(businessName, spec.data.template, deps.realtime?.greeting),
      // The server speaks the greeting on the call's first event (first_reply, the default). A call
      // continued after a restart has heard it already.
      greeted: !realtimeOn || deps.realtime?.greetingMode === 'begin_message' || stage !== initialTurnStage(spec.data),
      proposed: realtimeOn && stage === 'CUSTOMER_CONFIRMED', limitEnded: false, facts, menu, turnMs: [], toolCalls: 0, fallbackTurns: 0,
    };
    // An owner decision cannot be pushed into the call (no documented API in webhook mode); it is spoken
    // at the caller's next turn. Only a decision on this call's own proposal arrives here (decisions.ts).
    if (deps.decisions) s.unsubscribe = deps.decisions.subscribe(callId, (d) => { s.decision = d; });
    sessions.set(providerCallId, s);
    openRt(s);
    return s;
  }

  /** One turn of a call on the realtime engine, or on the builder runner when the session is down. */
  async function realtimeTurn(s: Session, text: string, hooks: TurnHooks): Promise<RunResult> {
    const rt = s.engine === 'realtime' ? await s.rt : undefined;
    const stageBefore = s.stage;
    if (rt && !rt.closed) {
      try {
        const r = await rt.turn(text, hooks);
        s.toolCalls += r.toolCalls;
        const proposal = r.tools.find((e) => isPropose(e.tool) && isStoredProposal(e.result));
        if (proposal) {
          s.proposed = true;
          return { reply: closingLine(s.spec.template, s.businessName, proposedName(proposal.args)), hangup: true, engine: 'realtime', toolCalls: r.toolCalls };
        }
        if (r.kind === 'tool_limit') {
          s.limitEnded = true;
          return { reply: toolLimitLine(s.businessName, s.proposed), hangup: true, engine: 'realtime', toolCalls: r.toolCalls };
        }
        const reply = plainSpeech(r.text).slice(0, MAX_REPLY_CHARS);
        if (!hooks.abandoned?.()) s.history.push({ role: 'caller', text }, { role: 'agent', text: reply });
        return { reply, engine: 'realtime', toolCalls: r.toolCalls };
      } catch (err) {
        deps.log?.warn({ callId: s.callId, why: (err as { why?: unknown }).why ?? 'unknown' }, 'agentphone: realtime turn failed; this call falls back to the builder runner');
        s.engine = 'builder';
        closeRt(s, 'fallback');
        // A proposal stored before the failure: the call ends the way it would have.
        if (stageBefore !== 'CUSTOMER_CONFIRMED' && s.stage === 'CUSTOMER_CONFIRMED') {
          s.proposed = true;
          return { reply: closingLine(s.spec.template, s.businessName, undefined), hangup: true, engine: 'realtime', toolCalls: 0 };
        }
      }
    }
    s.engine = 'builder';
    if (!deps.model) throw new Error('no builder model');
    s.fallbackTurns += 1;
    const r = await runAgentTurn({ ...deps, model: deps.model }, { spec: s.spec, businessName: s.businessName, businessId: s.businessId, agentVersionId: s.agentVersionId, callId: s.callId,
      message: text, session: s, abandoned: hooks.abandoned, onToolCall: hooks.onToolCall, extraInstructions: agentPhoneChannelLines(s.greeting, s.businessName) });
    s.toolCalls += r.toolTrace.length;
    const proposal = r.toolTrace.find((e) => isPropose(e.tool) && isStoredProposal(e.output));
    if (proposal || (stageBefore !== 'CUSTOMER_CONFIRMED' && s.stage === 'CUSTOMER_CONFIRMED')) {
      s.proposed = true;
      return { reply: closingLine(s.spec.template, s.businessName, proposedName(proposal?.input)), hangup: true, engine: 'builder', toolCalls: r.toolTrace.length };
    }
    return { reply: r.reply, engine: 'builder', toolCalls: r.toolTrace.length };
  }

  return {
    /** Number of live sessions (tests). */
    get size() { return sessions.size; },
    /** The tools the agent of a call holds (tests prove no write or external_message tool). */
    toolsOf(providerCallId: string) { const s = sessions.get(providerCallId); const c = s ? checkSessionCapabilities(s.spec) : undefined; return c?.ok ? c.tools : undefined; },
    /** The engine that will answer the call's next turn (tests). */
    engineOf(providerCallId: string): TurnEngine | undefined { return sessions.get(providerCallId)?.engine; },

    /**
     * `signal`: when it aborts the turn is abandoned, as nobody will hear it. The AgentPhone webhook does not
     * pass one: a request AgentPhone drops is sent again and still heard (plugin.ts says what a call showed).
     */
    async turn(input: { providerCallId: string; to: string; callerLast4?: string | undefined; text: string; signal?: AbortSignal | undefined }): Promise<TurnOutcome> {
      const id = input.providerCallId;
      const startedMs = deps.now().getTime();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = deps.turnTimeoutMs ?? (realtimeOn ? REALTIME_TURN_TIMEOUT_MS : DEFAULT_TURN_TIMEOUT_MS);
      const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), bound); });

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
        const out = (reply: TurnReply): TurnOutcome => ({ reply, businessId: s.businessId, callId: s.callId });

        if (s.channelRules) {
          // A later turn on a call whose proposal is stored, or that the tool cap ended: one line, then hang up.
          if (s.proposed) { closeRt(s, 'hangup'); return out({ text: `${update}${afterProposalLine(s.spec.template)}`, hangup: true }); }
          if (s.limitEnded) return out({ text: `${update}${SPEECH.callEnded}`, hangup: true });
          // A turn with no words (the call start, if AgentPhone sends one): the greeting, once.
          if (!text && !s.greeted) { s.greeted = true; return out({ text: s.greeting }); }
          // The caller's first words are only a hello (AgentPhone waits for the caller to speak, so most calls
          // start this way): the greeting alone, at once. No model turn runs, so nothing delays it and the
          // model cannot add a second question; its session opens while the greeting is spoken.
          if (!s.greeted && isHelloOnly(text)) { s.greeted = true; return out({ text: `${update}${s.greeting}` }); }
        }
        if (!text) return out({ text: `${update}${SPEECH.didNotHear}` });
        // first_reply (the default): the first event of the call carried a request, so the shop name and the
        // AI disclosure go before the first answer, without the greeting's question (the answer follows).
        // begin_message: AgentPhone was trusted to have spoken the agent's beginMessage.
        let lead = update;
        if (s.channelRules && !s.greeted) { s.greeted = true; lead = `${agentPhoneGreetingLead(s.businessName)} ${update}`; }

        // The turn is quiet, and the next one may start, when it has finished, or when it was abandoned and
        // no tool call of its own is still running (an abandoned turn can start no new one).
        let abandoned = false;
        let finished = false;
        let toolsRunning = 0;
        const dropped = () => input.signal?.aborted === true;
        const quiet = () => { if (finished || ((abandoned || s.closed || dropped()) && toolsRunning === 0)) release(); };
        const hooks: TurnHooks = {
          abandoned: () => abandoned || s.closed || dropped(),
          onToolCall: (settled) => { toolsRunning += 1; void settled.then(() => { toolsRunning -= 1; quiet(); }); },
        };
        const run: Promise<RunResult> = s.channelRules
          ? realtimeTurn(s, text, hooks)
          : (async () => {
            if (!deps.model) throw new Error('no builder model');
            const r = await runAgentTurn({ ...deps, model: deps.model }, { spec: s.spec, businessName: s.businessName, businessId: s.businessId, agentVersionId: s.agentVersionId, callId: s.callId, message: text, session: s, ...hooks });
            return { reply: r.reply, engine: 'builder' as const, toolCalls: r.toolTrace.length };
          })();
        running = true;
        input.signal?.addEventListener('abort', quiet, { once: true });
        void run.then(() => undefined, () => undefined).then(() => { finished = true; quiet(); });
        try {
          const result = await Promise.race([run, deadline]);
          if (result === 'timeout') {
            // The late answer is dropped; the caller is asked to repeat rather than hear a stale reply.
            abandoned = true;
            quiet();
            if (s.channelRules) deps.log?.warn({ callId: s.callId, engine: s.engine, turnMs: deps.now().getTime() - startedMs }, 'agentphone: turn past its bound');
            return out({ text: `${lead}${SPEECH.trouble}` });
          }
          const turnMs = deps.now().getTime() - startedMs;
          if (s.channelRules) {
            s.turnMs.push(turnMs);
            info({ callId: s.callId, engine: result.engine, turnMs, toolCalls: result.toolCalls, ...(result.hangup ? { hangup: true } : {}) }, 'agentphone: turn');
            if (result.hangup) closeRt(s, 'hangup');
          }
          return out({ text: `${lead}${result.reply}`.trim() || SPEECH.didNotHear, ...(result.hangup ? { hangup: true } : {}) });
        } catch {
          return out({ text: `${lead}${SPEECH.trouble}` });
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

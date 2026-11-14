// AgentPhone wiring (D-12): the /webhooks/agentphone route, the voice turn runner and the delivery-status
// poll. With TELEPHONY_PROVIDER=twilio (the default) the route answers 503 without reading the body, so the
// composed app behaves as before. With agentphone selected but settings missing, the route also answers 503
// and health names what is missing; nothing falls back to Twilio.
import { WEBHOOK_ENDPOINTS, type CapabilityId, type MessageChannelSetting } from '@abos/contracts';
import { markWebhookProcessed } from '@abos/db';
import type { FastifyPluginAsync } from 'fastify';
import type { AgentModel } from '../builder/runner/agent-model';
import type { Db } from '../db/index';
import { emitActivity } from '../policy/activity';
import type { RealToolset } from '../tools/real/types';
import type { CallDecisionsPort } from '../voice/types';
import { agentPhoneWebhookPlugin } from '../telephony/agentphone/plugin';
import { pollAgentPhoneReceipts, type ReceiptPollResult } from '../telephony/agentphone/receipts';
import { createAgentPhoneVoice, type AgentPhoneVoice } from '../telephony/agentphone/voice';
import type { Telephony } from '../telephony/index';
import { dbLiveAgentPort, type CallsStore } from './ports';
import type { SeamDeps } from './seams';

/** How often agentphone dispatches are checked for a delivery status (a read of the number's history). */
export const AGENTPHONE_RECEIPT_POLL_MS = 60_000;

export type AgentPhoneWiring = {
  /** True when this server answers AgentPhone calls. */
  enabled: boolean;
  missing: string[];
  plugin: FastifyPluginAsync;
  voice: AgentPhoneVoice | undefined;
  /** One delivery-status pass (also run on a timer when the message channel is agentphone). */
  pollReceipts(): Promise<ReceiptPollResult | undefined>;
  /** Re-applies stored agent.call_ended rows whose processing failed (the provider sends them once). */
  recoverNow(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
};

export function createAgentPhoneWiring(deps: {
  telephony: Telephony;
  db: Db;
  hasDb: boolean;
  calls: CallsStore;
  toolsetFor(ctx: { businessId: string; agentVersionId: string; callId: string; capabilities: readonly CapabilityId[] }): RealToolset;
  model: AgentModel;
  /** The server's MESSAGE_CHANNEL setting, for the phone prompt. */
  messageChannel: MessageChannelSetting;
  decisions: CallDecisionsPort;
  now(): Date;
  newId(prefix: string): string;
  log: SeamDeps['log'];
  interimAfterMs?: number;
  turnTimeoutMs?: number;
  receiptsEnabled: boolean;
  /** Model settings that are absent; the voice path stays off without a real model. */
  modelMissing?: readonly string[];
}): AgentPhoneWiring {
  const ap = deps.telephony.agentphone;
  const selected = deps.telephony.name === 'agentphone';
  const missing = selected && ap ? [...ap.missing, ...(deps.hasDb ? [] : ['DATABASE_URL']), ...(deps.modelMissing ?? [])] : [];
  const enabled = selected && !!ap && missing.length === 0;
  const liveAgent = dbLiveAgentPort(deps.db);
  const voice = enabled ? createAgentPhoneVoice({ db: deps.db, liveAgent, calls: deps.calls, toolsetFor: deps.toolsetFor, model: deps.model, messageChannel: deps.messageChannel,
    decisions: deps.decisions, now: deps.now, newId: deps.newId, log: deps.log, ...(deps.turnTimeoutMs !== undefined ? { turnTimeoutMs: deps.turnTimeoutMs } : {}) }) : undefined;

  const off: FastifyPluginAsync = async (app) => {
    // Own parser scope: the body is never read. 503 tells the provider to retry later.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', (_request, _payload, done) => done(null, undefined));
    app.post(WEBHOOK_ENDPOINTS.agentphone.path, async (request, reply) => reply.code(503).send({
      code: 'INTEGRATION_UNAVAILABLE', message: 'AgentPhone is not the telephony provider on this server.', correlationId: request.correlationId, retryable: true }));
  };
  if (selected && !enabled) deps.log.warn({ missing }, 'AgentPhone is selected but off: missing settings');

  const ownerOf = async (phoneNumber: string | undefined) => {
    if (!phoneNumber) return undefined;
    const row = (await deps.db.query('select business_id from public.live_agent where phone_number = $1', [phoneNumber])).rows[0] as { business_id?: string } | undefined;
    return row?.business_id;
  };

  const plugin: FastifyPluginAsync = enabled && ap && voice ? async (app) => {
    await app.register(agentPhoneWebhookPlugin, {
      provider: ap, db: deps.db, voice, ownerOf, log: deps.log, nowMs: () => deps.now().getTime(),
      ...(deps.interimAfterMs !== undefined ? { interimAfterMs: deps.interimAfterMs } : {}),
      async rejected(businessId, reason) {
        if (!businessId) return;
        await emitActivity(deps.db, { id: deps.newId('evt_'), businessId, correlationId: deps.newId('req_'), type: 'webhook.rejected', actorType: 'provider',
          occurredAt: deps.now().toISOString(), payload: { provider: 'agentphone', reason } });
      },
    });
  } : off;

  async function pollReceipts() {
    if (!deps.receiptsEnabled || !deps.hasDb || !ap?.client) return undefined;
    return pollAgentPhoneReceipts({ db: deps.db, client: ap.client, now: deps.now, newId: deps.newId, log: deps.log });
  }

  async function recoverNow() {
    if (!voice) return 0;
    const rows = (await deps.db.query(`select id, payload from public.webhook_events where source = 'agentphone' and event_type = 'agent.call_ended'
      and processed_at is null order by id limit 100`, [])).rows as { id: string; payload: { providerId?: unknown } }[];
    let n = 0;
    for (const r of rows) {
      const providerId = typeof r.payload?.providerId === 'string' ? r.payload.providerId : undefined;
      if (!providerId) continue;
      try {
        // A recovered end has no status; the call is closed as completed (the caller hung up or the call ended).
        await voice.ended({ providerCallId: providerId, reason: 'completed' });
        await markWebhookProcessed(deps.db, { businessId: null, webhookEventId: r.id });
        n += 1;
      } catch { deps.log.warn({ job: 'agentphone-recovery', webhookId: r.id }, 'call end still not applied'); }
    }
    return n;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<unknown> | undefined;
  return {
    enabled, missing, plugin, voice, pollReceipts, recoverNow,
    start() {
      if (timer || (!deps.receiptsEnabled && !enabled) || !deps.hasDb) return;
      const tick = () => {
        running ??= Promise.allSettled([pollReceipts(), recoverNow()]).then((r) => {
          if (r.some((x) => x.status === 'rejected')) deps.log.warn({ job: 'agentphone' }, 'agentphone poll will retry');
        }).finally(() => { running = undefined; });
      };
      timer = setInterval(tick, AGENTPHONE_RECEIPT_POLL_MS);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
      voice?.dispose();
    },
  };
}

// POST /webhooks/agentphone (D-12): AgentPhone's single webhook for calls and texts.
// Order of work (AGENTS rule 2): capture the raw bytes in an own parser scope, verify the signature over
// them (signature.ts), parse only routing fields, insert webhook_events (source 'agentphone',
// provider_event_id = X-Webhook-ID) with "on conflict do nothing", and act only when the row is new.
// A bad or missing signature answers 401 and writes webhook.rejected; nothing from the body is stored.
//
// A voice turn is answered in the response itself (the vendor has no retry for it): NDJSON, with one
// interim "One moment." chunk if the turn is slow, then the final chunk. Other events answer 200.
import { PassThrough } from 'node:stream';
import { ERROR_CODE_INFO, WEBHOOK_ENDPOINTS, makeApiError } from '@abos/contracts';
import { markWebhookProcessed } from '@abos/db';
import type { FastifyPluginAsync } from 'fastify';
import type { QueryDb } from '../../db/index';
import type { TelephonyEvent, TelephonyProvider, TurnReply } from '../types';
import { SPEECH, type AgentPhoneVoice } from './voice';

export const AGENTPHONE_NDJSON = 'application/x-ndjson';
export const DEFAULT_INTERIM_AFTER_MS = 1500;

/** The documented voice reply fields: text, hangup, interim (docs/notes-agentphone.md). */
export function formatTurnChunks(chunks: { text: string; interim?: boolean; hangup?: boolean }[]): string {
  return chunks.map((c) => JSON.stringify({ text: c.text, ...(c.interim ? { interim: true } : {}), ...(c.hangup ? { hangup: true } : {}) })).join('\n') + '\n';
}

export interface AgentPhoneWebhookDeps {
  provider: TelephonyProvider;
  db: QueryDb;
  voice: AgentPhoneVoice;
  /** The business of the live agent on this number, for routing and for webhook.rejected attribution. */
  ownerOf(phoneNumber: string | undefined): Promise<string | undefined>;
  rejected(businessId: string | undefined, reason: 'signature_invalid' | 'malformed'): Promise<void>;
  log: { info(data: Record<string, unknown>, msg: string): void; warn(data: Record<string, unknown>, msg: string): void };
  interimAfterMs?: number;
}

type Row = { id: string };

async function recordOnce(db: QueryDb, input: { deliveryId: string; eventType: string; businessId: string | undefined; providerId: string | undefined }): Promise<Row | undefined> {
  // Sanitized: the provider's object ID only. No phone number, transcript or message body is stored.
  const r = await db.query(`insert into public.webhook_events (source, provider_event_id, event_type, business_id, payload)
    values ('agentphone', $1, $2, $3, $4::jsonb) on conflict (source, provider_event_id) do nothing returning id`,
  [input.deliveryId, input.eventType.slice(0, 100), input.businessId ?? null, JSON.stringify(input.providerId ? { providerId: input.providerId } : {})]);
  return r.rows[0] as Row | undefined;
}

function providerIdOf(event: TelephonyEvent): string | undefined {
  return 'providerCallId' in event ? event.providerCallId : 'providerMessageId' in event ? event.providerMessageId : undefined;
}

export const agentPhoneWebhookPlugin: FastifyPluginAsync<AgentPhoneWebhookDeps> = async (app, deps) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
  app.setErrorHandler((error, request, reply) => {
    // Never echo parser text or the body. 4xx stays 4xx so the provider does not retry it as a 500.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send(makeApiError('VALIDATION_FAILED', 'Webhook request was refused', request.id));
    return reply.code(ERROR_CODE_INFO.INTERNAL.httpStatus).send(makeApiError('INTERNAL', 'Webhook processing requires retry', request.id));
  });

  const mark = async (id: string, businessId: string | undefined, error?: string) => {
    await markWebhookProcessed(deps.db, { businessId: businessId ?? null, webhookEventId: id, ...(error ? { error } : {}) })
      .catch(() => deps.log.warn({ job: 'agentphone-webhook', webhookId: id }, 'webhook processed mark failed'));
  };

  app.post(WEBHOOK_ENDPOINTS.agentphone.path, async (req, reply) => {
    reply.header('X-Correlation-Id', req.id);
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const verified = await deps.provider.verifyWebhook({ rawBody, headers: req.headers });
    if (!verified.ok) {
      await deps.rejected(await deps.ownerOf(deps.provider.phoneNumber).catch(() => undefined), verified.reason).catch(() => undefined);
      if (verified.reason === 'malformed') return reply.code(ERROR_CODE_INFO.VALIDATION_FAILED.httpStatus).send(makeApiError('VALIDATION_FAILED', 'Invalid webhook envelope', req.id));
      return reply.code(ERROR_CODE_INFO.SIGNATURE_INVALID.httpStatus).send(makeApiError('SIGNATURE_INVALID', 'Invalid webhook signature', req.id));
    }
    const { event } = verified;
    const routed = event.kind === 'incoming_call' || event.kind === 'incoming_text' ? await deps.ownerOf(event.to) : undefined;
    const stored = await recordOnce(deps.db, { deliveryId: verified.deliveryId, eventType: verified.eventType, businessId: routed, providerId: providerIdOf(event) });
    // A repeated delivery changes nothing. For a voice turn the caller hears nothing new.
    if (!stored) return reply.code(200).send({});
    if (verified.test) { await mark(stored.id, routed); return reply.code(200).send({}); }

    if (event.kind === 'incoming_call') {
      const stream = new PassThrough();
      reply.code(200).type(AGENTPHONE_NDJSON).send(stream);
      let finished = false;
      const interim = setTimeout(() => { if (!finished) stream.write(formatTurnChunks([{ text: SPEECH.oneMoment, interim: true }])); }, deps.interimAfterMs ?? DEFAULT_INTERIM_AFTER_MS);
      let final: TurnReply = { text: SPEECH.trouble };
      let businessId = routed;
      try {
        const out = await deps.voice.turn({ providerCallId: event.providerCallId, to: event.to, callerLast4: event.callerLast4, text: event.text });
        final = out.reply;
        businessId = out.businessId ?? routed;
      } catch {
        deps.log.warn({ job: 'agentphone-webhook', webhookId: stored.id }, 'voice turn failed');
      } finally {
        finished = true;
        clearTimeout(interim);
      }
      stream.end(formatTurnChunks([{ text: final.text, ...(final.hangup ? { hangup: true } : {}) }]));
      await mark(stored.id, businessId);
      return reply;
    }

    if (event.kind === 'call_status') {
      try {
        await deps.voice.ended({ providerCallId: event.providerCallId, reason: event.reason });
        // The row was stored before the call was looked up, so it carries no business (null).
        await mark(stored.id, undefined);
      } catch {
        // agent.call_ended is attempted once by the provider: the row stays unprocessed for recovery.
        deps.log.warn({ job: 'agentphone-webhook', webhookId: stored.id }, 'call end not applied; left for recovery');
      }
      return reply.code(200).send({});
    }

    // incoming_text, delivery_receipt and ignored types: verified and stored once, nothing else changes.
    await mark(stored.id, routed);
    return reply.code(200).send({});
  });
};

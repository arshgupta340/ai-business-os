// POST /webhooks/agentphone (D-12): AgentPhone's single webhook for calls and texts.
// Order of work (AGENTS rule 2): capture the raw bytes in an own parser scope, verify the signature over
// them (signature.ts), parse only routing fields, insert webhook_events (source 'agentphone',
// provider_event_id = X-Webhook-ID) with "on conflict do nothing", and act only when the row is new.
// The signature does not cover X-Webhook-ID, so the same statement also stores a second row keyed by the
// signed content (signature.ts replayKey); a delivery is new only when BOTH keys are new. The provider's own
// retry keeps the ID; a captured delivery replayed under another ID keeps the signed content.
// A bad or missing signature answers 401 and writes webhook.rejected; nothing from the body is stored.
// Rejected deliveries cost one bounded body read and at most one HMAC; their activity rows are capped per
// minute (REJECTED_EVENTS_PER_MINUTE), so a flood without the secret cannot fill the owner's feed.
//
// A voice turn is answered in the response itself (the vendor has no retry for it): NDJSON, with one
// interim "One moment." chunk if the turn is slow, then the final chunk. Other events answer 200.
import { PassThrough } from 'node:stream';
import { ERROR_CODE_INFO, WEBHOOK_ENDPOINTS, makeApiError } from '@abos/contracts';
import { markWebhookProcessed } from '@abos/db';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { QueryDb } from '../../db/index';
import type { TelephonyEvent, TelephonyProvider, TurnReply } from '../types';
import { SPEECH, type AgentPhoneVoice } from './voice';

export const AGENTPHONE_NDJSON = 'application/x-ndjson';
/**
 * Two calls on 2026-11-14 showed the 1.5 second value speaking "One moment." before the greeting (the
 * first turn took 1.6 and 2.3 seconds). The filler is now only for a turn that is really slow.
 */
export const DEFAULT_INTERIM_AFTER_MS = 3500;
/** The most webhook.rejected events one server process writes for this route in any 60 seconds. Every rejected request still answers 401 or 400. */
export const REJECTED_EVENTS_PER_MINUTE = 30;
/** event_type of the row that remembers a delivery's signed content. It carries no payload and is never acted on. */
export const REPLAY_GUARD_EVENT = 'replay_guard';
/** Voice turns whose reply this process remembers, so a repeated delivery hears the same reply (FIFO bound). */
export const REMEMBERED_TURNS = 500;

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
  /** The server clock, for the rejected-event cap. */
  nowMs?(): number;
}

type Row = { id: string };

async function recordOnce(db: QueryDb, input: { deliveryId: string; replayKey: string | undefined; eventType: string; businessId: string | undefined; providerId: string | undefined;
  reason?: string | undefined }): Promise<Row | undefined> {
  // Sanitized: the provider's object ID and, for a call end, its end reason (a fixed code), so a recovered
  // end closes the call the way the provider reported it. No phone number, transcript or message body is stored.
  const payload = { ...(input.providerId ? { providerId: input.providerId } : {}), ...(input.reason ? { reason: input.reason } : {}) };
  const params = [input.deliveryId, input.eventType.slice(0, 100), input.businessId ?? null, JSON.stringify(payload)];
  if (!input.replayKey) {
    const r = await db.query(`insert into public.webhook_events (source, provider_event_id, event_type, business_id, payload)
      values ('agentphone', $1, $2, $3, $4::jsonb) on conflict (source, provider_event_id) do nothing returning id`, params);
    return r.rows[0] as Row | undefined;
  }
  // One statement, two unique keys: the event row is inserted only if the signed content was not seen
  // before, and only if the delivery ID was not seen before. Either conflict means "already delivered".
  const r = await db.query(`with guard as (
      insert into public.webhook_events (source, provider_event_id, event_type, business_id, payload, processed_at)
      values ('agentphone', $5, '${REPLAY_GUARD_EVENT}', $3, '{}'::jsonb, now())
      on conflict (source, provider_event_id) do nothing returning id
    ), event as (
      insert into public.webhook_events (source, provider_event_id, event_type, business_id, payload)
      select 'agentphone', $1, $2, $3, $4::jsonb where exists (select 1 from guard)
      on conflict (source, provider_event_id) do nothing returning id
    )
    select id from event`, [...params, input.replayKey]);
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

  // Sliding one-minute window of recorded rejections (per process; the answer to the sender never changes).
  const nowMs = deps.nowMs ?? (() => Date.now());
  const recorded: number[] = [];
  let capLogged = false;
  const mayRecordRejection = (): boolean => {
    const now = nowMs();
    while (recorded.length > 0 && (recorded[0]! <= now - 60_000 || recorded[0]! > now)) recorded.shift();
    if (recorded.length >= REJECTED_EVENTS_PER_MINUTE) {
      if (!capLogged) deps.log.warn({ job: 'agentphone-webhook', perMinute: REJECTED_EVENTS_PER_MINUTE }, 'rejected webhook deliveries exceed the cap; further ones this minute are refused without an activity event');
      capLogged = true;
      return false;
    }
    capLogged = false;
    recorded.push(now);
    return true;
  };

  // A voice turn's reply, by delivery ID. The provider's own repeat of a turn (same X-Webhook-ID; the vendor's
  // docs say voice turns are not retried, so this is a guard) runs nothing and hears the same reply. The same
  // signed bytes under another ID are a replay, not a retry: they run nothing and get an empty answer, so a
  // captured delivery never reads a reply back. Per process and in memory only: the turn itself is
  // deduplicated in the database before anything runs.
  const turns = new Map<string, Promise<TurnReply>>();
  const remember = (deliveryId: string, reply: Promise<TurnReply>) => {
    turns.set(deliveryId, reply);
    while (turns.size > REMEMBERED_TURNS) turns.delete(turns.keys().next().value as string);
  };
  const speak = async (reply: FastifyReply, text: Promise<TurnReply>) => {
    const stream = new PassThrough();
    reply.code(200).type(AGENTPHONE_NDJSON).send(stream);
    const final = await text;
    stream.end(formatTurnChunks([{ text: final.text, ...(final.hangup ? { hangup: true } : {}) }]));
  };

  app.post(WEBHOOK_ENDPOINTS.agentphone.path, async (req, reply) => {
    reply.header('X-Correlation-Id', req.id);
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const verified = await deps.provider.verifyWebhook({ rawBody, headers: req.headers });
    if (!verified.ok) {
      const record = mayRecordRejection();
      // A fixed cause code only: it tells a wrong secret from a header or ID format this build does not expect.
      if (record) deps.log.warn({ job: 'agentphone-webhook', reason: verified.reason, cause: verified.cause ?? 'unknown' }, 'webhook delivery refused');
      if (record) await deps.rejected(await deps.ownerOf(deps.provider.phoneNumber).catch(() => undefined), verified.reason).catch(() => undefined);
      if (verified.reason === 'malformed') return reply.code(ERROR_CODE_INFO.VALIDATION_FAILED.httpStatus).send(makeApiError('VALIDATION_FAILED', 'Invalid webhook envelope', req.id));
      return reply.code(ERROR_CODE_INFO.SIGNATURE_INVALID.httpStatus).send(makeApiError('SIGNATURE_INVALID', 'Invalid webhook signature', req.id));
    }
    const { event } = verified;
    const routed = event.kind === 'incoming_call' || event.kind === 'incoming_text' ? await deps.ownerOf(event.to) : undefined;
    const stored = await recordOnce(deps.db, { deliveryId: verified.deliveryId, replayKey: verified.replayKey, eventType: verified.eventType, businessId: routed, providerId: providerIdOf(event),
      ...(event.kind === 'call_status' ? { reason: event.reason } : {}) });
    // A repeated delivery changes nothing. A voice turn this process answered hears the same reply again.
    if (!stored) {
      const seen = event.kind === 'incoming_call' ? turns.get(verified.deliveryId) : undefined;
      if (seen) { await speak(reply, seen); return reply; }
      return reply.code(200).send({});
    }
    if (verified.test) { await mark(stored.id, routed); return reply.code(200).send({}); }

    if (event.kind === 'incoming_call') {
      const stream = new PassThrough();
      reply.code(200).type(AGENTPHONE_NDJSON).send(stream);
      let finished = false;
      const interim = setTimeout(() => { if (!finished) stream.write(formatTurnChunks([{ text: SPEECH.oneMoment, interim: true }])); }, deps.interimAfterMs ?? DEFAULT_INTERIM_AFTER_MS);
      let final: TurnReply = { text: SPEECH.trouble };
      let settle!: (r: TurnReply) => void;
      remember(verified.deliveryId, new Promise<TurnReply>((resolve) => { settle = resolve; }));
      // If the provider drops the request before the reply (a barge-in or its own timeout; whether it does is
      // not documented), nobody hears this turn: it is abandoned like a turn past its bound.
      const gone = new AbortController();
      reply.raw.once('close', () => { if (!finished) gone.abort(); });
      try {
        final = (await deps.voice.turn({ providerCallId: event.providerCallId, to: event.to, callerLast4: event.callerLast4, text: event.text, signal: gone.signal })).reply;
      } catch {
        deps.log.warn({ job: 'agentphone-webhook', webhookId: stored.id }, 'voice turn failed');
      } finally {
        finished = true;
        clearTimeout(interim);
      }
      settle(final);
      stream.end(formatTurnChunks([{ text: final.text, ...(final.hangup ? { hangup: true } : {}) }]));
      // Marked with the scope the row was stored under (the business of the dialed number, or none),
      // which mark_webhook_processed checks; the call's own business can differ after an unpublish.
      await mark(stored.id, routed);
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

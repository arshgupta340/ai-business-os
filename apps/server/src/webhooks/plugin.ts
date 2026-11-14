import type { FastifyPluginAsync } from 'fastify';
import { ERROR_CODE_INFO, WEBHOOK_ENDPOINTS, makeApiError } from '@abos/contracts';
import { parseSquareEvent, processSquareEvent, rejectWebhook } from './square.js';
import { parseTwilioStatus, processTwilioStatus } from './twilio-status.js';
import type { StoredWebhook, WebhookDependencies } from './types.js';

/** Register in an encapsulated scope so unrelated JSON and voice parsers stay intact. */
export const webhooksPlugin: FastifyPluginAsync<WebhookDependencies> = async (app, deps) => {
  if (!deps.config?.squareNotificationUrl || !deps.config.squareSignatureKey || !deps.config.twilioStatusUrl) throw new Error('Webhook configuration is required');
  app.setErrorHandler((error, request, reply) => {
    reply.header('X-Correlation-Id', request.id);
    // Body too large, bad media type and similar parser refusals stay 4xx, so a provider does not retry them as a 500.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send(makeApiError('VALIDATION_FAILED', 'Webhook request was refused', request.id));
    return reply.code(ERROR_CODE_INFO.INTERNAL.httpStatus).send(makeApiError('INTERNAL', 'Webhook processing requires retry', request.id));
  });
  // Fastify content type parsers are scope-wide, so give each route its own child scope.
  await app.register(async square => {
    square.removeAllContentTypeParsers();
    square.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    const pending = new WeakMap<object, StoredWebhook>();
    square.addHook('onResponse', async request => {
      const event = pending.get(request);
      if (event) {
        try { await deps.jobs.enqueue(event.id, () => processSquareEvent(deps, event.eventType, event.payload, event.businessId)); }
        catch { throw new Error('Webhook job enqueue requires retry'); }
      }
    });
    square.post(WEBHOOK_ENDPOINTS.square.path, async (req, reply) => {
      reply.header('X-Correlation-Id', req.id);
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const header = req.headers[WEBHOOK_ENDPOINTS.square.signatureHeader];
      const valid = await deps.square.verifyWebhookSignature({ rawBody, signatureHeader: typeof header === 'string' ? header : undefined, notificationUrl: deps.config.squareNotificationUrl, signatureKey: deps.config.squareSignatureKey });
      if (!valid) {
        await rejectWebhook(deps, 'square', deps.config.squareNotificationUrl, req.id);
        return reply.code(ERROR_CODE_INFO.SIGNATURE_INVALID.httpStatus).send(makeApiError('SIGNATURE_INVALID', 'Invalid webhook signature', req.id));
      }
      const event = parseSquareEvent(rawBody);
      if (!event) return reply.code(ERROR_CODE_INFO.VALIDATION_FAILED.httpStatus).send(makeApiError('VALIDATION_FAILED', 'Invalid webhook envelope', req.id));
      const owner = await deps.integrations.findOwner('square', deps.config.squareNotificationUrl);
      if (!owner) throw new Error('Square webhook integration owner is not configured');
      const stored = await deps.store.recordOnce({ source: 'square', ...event, businessId: owner.businessId });
      if (stored) pending.set(req, stored);
      return reply.code(200).send();
    });
  });
  await app.register(async twilio => {
    twilio.removeAllContentTypeParsers();
    twilio.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    const pending = new WeakMap<object, StoredWebhook>();
    twilio.addHook('onResponse', async request => {
      const event = pending.get(request);
      if (event) {
        try { await deps.jobs.enqueue(event.id, () => processTwilioStatus(deps, event)); }
        catch { throw new Error('Webhook job enqueue requires retry'); }
      }
    });
    twilio.post(WEBHOOK_ENDPOINTS.twilioStatus.path, async (req, reply) => {
      reply.header('X-Correlation-Id', req.id);
      const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const params: Record<string, string> = Object.fromEntries(new URLSearchParams(body));
      const header = req.headers[WEBHOOK_ENDPOINTS.twilioStatus.signatureHeader];
      const valid = await deps.twilio.validate({ params, signatureHeader: typeof header === 'string' ? header : undefined, notificationUrl: deps.config.twilioStatusUrl });
      if (!valid) {
        await rejectWebhook(deps, 'twilio', deps.config.twilioStatusUrl, req.id);
        return reply.code(ERROR_CODE_INFO.SIGNATURE_INVALID.httpStatus).send(makeApiError('SIGNATURE_INVALID', 'Invalid webhook signature', req.id));
      }
      const event = parseTwilioStatus(params);
      if (!event) return reply.code(204).send();
      // One Twilio account serves both seeded businesses, so the verified event belongs to the business
      // of the call or dispatch it names (CallSid and MessageSid are unique), not to a single integration owner.
      const subject = event.eventType === 'message.status'
        ? await deps.dispatch.findByProviderId(event.payload.providerId!)
        : await deps.calls.findByProviderId(event.payload.providerId!);
      if (!subject) return reply.code(204).send();
      if (event.eventType === 'message.status' && (subject as { channel?: string }).channel !== 'whatsapp_sandbox') return reply.code(204).send();
      const stored = await deps.store.recordOnce({ ...event, businessId: subject.businessId });
      if (stored) pending.set(req, stored);
      return reply.code(204).send();
    });
  });
};

export default webhooksPlugin;

// The phone voice worker as a Fastify plugin (FLOWS B1 to B4, B30). Register it with one line:
//   await app.register(voicePlugin, { publicServerUrl, liveAgent, calls, toolsetFactory, twilioValidator, openaiSocketFactory, messageChannel })
// It owns POST /webhooks/twilio/voice and the /ws/phone Media Stream socket.
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import type { FastifyPluginAsync } from 'fastify';
import twilio from 'twilio';
import { STREAM_TOKEN_TTL_MS } from '@abos/contracts';
import { VOICE_WEBHOOK_PATH, WS_PATH } from './constants';
import { CALL_SETUP_FAILED_MESSAGE, NOT_TAKING_CALLS_MESSAGE, StreamTokenStore, buildConnectTwiml, buildRejectTwiml, buildSayTwiml, last4, redact } from './logic';
import { adaptWs, checkSessionCapabilities, runPhoneRelay } from './relay';
import type { PinnedCall, TwilioRequestValidator, VoiceLogger, VoicePluginOptions } from './types';

export type * from './types';
export { buildInstructions } from './prompt';
export { createWsOpenAISocketFactory } from './relay';

/** The production validator: Twilio's own signature check with the account auth token. */
export function createTwilioRequestValidator(authToken: string): TwilioRequestValidator {
  return { validate: (signature, url, params) => twilio.validateRequest(authToken, signature, url, params) };
}

/** Form fields as strings. Twilio posts application/x-www-form-urlencoded. */
function formParams(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return out;
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  return out;
}

export const voicePlugin: FastifyPluginAsync<VoicePluginOptions> = async (app, opts) => {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) await app.register(formbody);
  if (!app.hasDecorator('websocketServer')) await app.register(websocket);

  const logger: VoiceLogger = opts.logger ?? app.log;
  const now = opts.now ?? Date.now;
  const secrets = opts.redactSecrets ?? [];
  const publicUrl = opts.publicServerUrl.replace(/\/+$/, '');
  const webhookUrl = `${publicUrl}${VOICE_WEBHOOK_PATH}`;
  const tokens = new StreamTokenStore<PinnedCall>(opts.tokenTtlMs ?? STREAM_TOKEN_TTL_MS);

  const say = (message: string) => buildSayTwiml(message);

  // B1 to B3.
  app.post(VOICE_WEBHOOK_PATH, async (req, reply) => {
    const params = formParams(req.body);
    const signature = req.headers['x-twilio-signature'];
    let valid = false;
    try {
      valid = typeof signature === 'string' && opts.twilioValidator.validate(signature, webhookUrl, params);
    } catch {
      valid = false;
    }
    if (!valid) {
      logger.warn({ path: VOICE_WEBHOOK_PATH }, 'voice: webhook rejected, bad or missing X-Twilio-Signature');
      return reply.code(403).type('text/xml').send(buildRejectTwiml());
    }

    const providerCallId = params.CallSid;
    const to = params.To;
    if (providerCallId === undefined || providerCallId === '' || to === undefined || to === '') {
      return reply.code(400).type('text/xml').send(buildRejectTwiml());
    }

    let resolution: Awaited<ReturnType<typeof opts.liveAgent.resolve>>;
    try {
      resolution = await opts.liveAgent.resolve(to);
    } catch (err) {
      logger.error({ err: redact(String(err), secrets) }, 'voice: could not read the live agent');
      return reply.type('text/xml').send(say(CALL_SETUP_FAILED_MESSAGE));
    }
    if (resolution.state !== 'live' || resolution.spec.status !== 'live') {
      logger.info({ state: resolution.state }, 'voice: no live agent answers this number; refused politely');
      return reply.type('text/xml').send(say(NOT_TAKING_CALLS_MESSAGE));
    }
    const capCheck = checkSessionCapabilities(resolution.spec);
    if (!capCheck.ok) {
      logger.error({ agentVersionId: resolution.agentVersionId, unknown: capCheck.unknown, notAllowed: capCheck.notAllowed }, 'voice: live agent has a capability that is not allowed; refused');
      return reply.type('text/xml').send(say(CALL_SETUP_FAILED_MESSAGE));
    }

    let callId: string;
    try {
      ({ callId } = await opts.calls.startCall({
        businessId: resolution.businessId,
        agentId: resolution.agentId,
        agentVersionId: resolution.agentVersionId,
        providerCallId,
        callerLast4: last4(params.From),
      }));
    } catch (err) {
      logger.error({ err: redact(String(err), secrets) }, 'voice: could not start the call');
      return reply.type('text/xml').send(say(CALL_SETUP_FAILED_MESSAGE));
    }

    const token = tokens.mint(
      { callId, providerCallId, businessId: resolution.businessId, businessName: resolution.businessName, agentId: resolution.agentId, agentVersionId: resolution.agentVersionId, spec: resolution.spec },
      now(),
    );
    logger.info({ callId, agentVersionId: resolution.agentVersionId, callerLast4: last4(params.From) }, 'voice: call started; stream token minted');
    return reply.type('text/xml').send(buildConnectTwiml(publicUrl, token));
  });

  // B4 to B30.
  app.get(WS_PATH, { websocket: true }, (socket) => {
    runPhoneRelay({
      phone: adaptWs(socket),
      tokens,
      calls: opts.calls,
      toolsetFactory: opts.toolsetFactory,
      openaiSocketFactory: opts.openaiSocketFactory,
      messageChannel: opts.messageChannel,
      logger,
      model: opts.model,
      voice: opts.voice,
      redactSecrets: secrets,
      now,
    });
  });
};

// The phone voice worker as a Fastify plugin (FLOWS B1 to B4, B30). Register it with one line:
//   await app.register(voicePlugin, { publicServerUrl, liveAgent, facts, calls, events, toolsetFactory, twilioValidator, openaiSocketFactory, messageChannel })
// It owns POST /webhooks/twilio/voice and the /ws/phone Media Stream socket.
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import type { FastifyPluginAsync } from 'fastify';
import twilio from 'twilio';
import { HoursValueSchema, STREAM_TOKEN_TTL_MS, type WebhookRejectReason } from '@abos/contracts';
import { VOICE_WEBHOOK_PATH, WS_PATH } from './constants';
import {
  CALL_SETUP_FAILED_MESSAGE,
  CANNOT_TAKE_ORDERS_MESSAGE,
  NOT_TAKING_CALLS_MESSAGE,
  StreamTokenStore,
  buildConnectTwiml,
  buildRejectTwiml,
  buildSayTwiml,
  errorInfo,
  last4,
  safeLogger,
} from './logic';
import { callerNumberFrom } from './consent';
import { adaptWs, checkSessionCapabilities, runPhoneRelay, withDeadline } from './relay';
import type { CatalogItem } from '@abos/contracts';
import type { FactsSnapshot, PinnedCall, TwilioRequestValidator, VoicePluginOptions } from './types';

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

/** True when the snapshot holds at least one readable opening-hours fact. */
function hasReadableHours(snapshot: FactsSnapshot): boolean {
  return snapshot.facts.some((f) => f.kind === 'hours' && HoursValueSchema.safeParse(f.value).success);
}

/** The longest the webhook waits for the menu before it goes on without it. */
const MENU_SNAPSHOT_TIMEOUT_MS = 1500;

type Reply = { status: number; body: string };

export const voicePlugin: FastifyPluginAsync<VoicePluginOptions> = async (app, opts) => {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) await app.register(formbody);
  if (!app.hasDecorator('websocketServer')) await app.register(websocket);

  const secrets = opts.redactSecrets ?? [];
  const logger = safeLogger(opts.logger ?? app.log, secrets);
  const now = opts.now ?? Date.now;
  const cleanupMs = opts.limits?.cleanupTimeoutMs ?? 5000;
  const publicUrl = opts.publicServerUrl.replace(/\/+$/, '');
  const webhookUrl = `${publicUrl}${VOICE_WEBHOOK_PATH}`;
  const tokenTtlMs = opts.tokenTtlMs ?? STREAM_TOKEN_TTL_MS;
  // Issue #95 item 6: a call whose credential was rejected or never used can never get a stream. It is
  // ended here, so its row does not stay IN_PROGRESS and call.ended is written: `failed` when the stream
  // presented the call's token and was refused, `dropped` when no stream ever presented it.
  const tokens = new StreamTokenStore<PinnedCall>(tokenTtlMs, undefined, (call, why) => {
    const reason = why === 'unused' ? 'dropped' : 'failed';
    logger.warn({ callId: call.callId, agentVersionId: call.agentVersionId, why, endReason: reason }, 'voice: stream credential can no longer be used; ending the call');
    void withDeadline(opts.calls.endCall(call.callId, reason), cleanupMs, 'failed' as const).then((r) => {
      if (r === 'failed') logger.error({ callId: call.callId }, 'voice: could not end a call whose stream never started');
    });
  });
  // One timer per minted credential, fired just after its life ends. A credential claimed in time is not reported.
  const expiryTimers = new Set<ReturnType<typeof setTimeout>>();
  const watchExpiry = () => {
    const t = setTimeout(() => {
      expiryTimers.delete(t);
      tokens.expireUnclaimed(now());
    }, tokenTtlMs + 5);
    (t as { unref?: () => void }).unref?.();
    expiryTimers.add(t);
  };
  app.addHook('onClose', async () => {
    for (const t of expiryTimers) clearTimeout(t);
    expiryTimers.clear();
  });
  // Simultaneous deliveries of one CallSid share one result.
  const inflight = new Map<string, Promise<Reply>>();

  const ok = (body: string): Reply => ({ status: 200, body });
  const refuseReplay = (): Reply => ({ status: 409, body: buildRejectTwiml() });

  const rejected = (reason: WebhookRejectReason) => {
    void withDeadline(opts.events.webhookRejected({ businessId: opts.twilioBusinessId, payload: { provider: 'twilio', reason } }), cleanupMs, 'failed' as const).then((r) => {
      if (r === 'failed') logger.error({}, 'voice: could not write webhook.rejected');
    });
  };

  /** B2 and B3 for one CallSid. Never mints a second credential for a call. */
  async function admit(providerCallId: string, to: string, from: string | undefined): Promise<Reply> {
    const existing = tokens.lookup(providerCallId, now());
    if (existing.kind === 'pending') return ok(buildConnectTwiml(publicUrl, existing.token));
    if (existing.kind === 'refused') {
      logger.warn({ state: existing.state }, 'voice: repeated webhook for a call whose stream is used or ended; refused');
      return refuseReplay();
    }
    // A call row from an earlier delivery (another process, or a restart) cannot get a new credential.
    const stored = await opts.calls.findByProviderCallId(providerCallId);
    if (stored !== null) {
      logger.warn({ callId: stored.callId, status: stored.status }, 'voice: repeated webhook for a stored call; refused');
      return refuseReplay();
    }

    const resolution = await opts.liveAgent.resolve(to);
    if (resolution.state !== 'live' || resolution.spec.status !== 'live') {
      logger.info({ state: resolution.state }, 'voice: no live agent answers this number; refused politely');
      // API.md section 4: a paused agent's call is recorded as started and at once ended (`completed`),
      // with no credential, snapshot or session. A number with no agent has no agent to record a call for.
      if (resolution.state !== 'none' && resolution.businessId !== undefined && resolution.agentId !== undefined && resolution.agentVersionId !== undefined) {
        try {
          const { callId } = await opts.calls.startCall({ businessId: resolution.businessId, agentId: resolution.agentId, agentVersionId: resolution.agentVersionId, providerCallId, callerLast4: last4(from) });
          await opts.calls.endCall(callId, 'completed');
        } catch (err) {
          // The caller still hears the closed message.
          logger.error({ ...errorInfo(err) }, 'voice: could not record the call refused for a paused agent');
        }
      }
      return ok(buildSayTwiml(NOT_TAKING_CALLS_MESSAGE));
    }
    const capCheck = checkSessionCapabilities(resolution.spec);
    if (!capCheck.ok) {
      logger.error({ agentVersionId: resolution.agentVersionId, notAllowed: capCheck.notAllowed }, 'voice: live agent has a capability that is not allowed; refused');
      return ok(buildSayTwiml(CALL_SETUP_FAILED_MESSAGE));
    }
    // FLOWS B2: the fact snapshot is taken now, when the version is pinned, and travels with the call.
    let facts: FactsSnapshot;
    try {
      facts = structuredClone(await opts.facts.snapshot(resolution.businessId));
    } catch (err) {
      logger.error({ ...errorInfo(err) }, 'voice: could not read the fact snapshot; refused');
      return ok(buildSayTwiml(CANNOT_TAKE_ORDERS_MESSAGE));
    }
    if (resolution.spec.template !== 'custom' && !hasReadableHours(facts)) {
      logger.error({ agentVersionId: resolution.agentVersionId }, 'voice: no readable opening hours; refused');
      return ok(buildSayTwiml(CANNOT_TAKE_ORDERS_MESSAGE));
    }

    // The menu goes into the prompt so a basic question needs no tool call. It is best effort:
    // without it the agent reads the menu through read_catalog as before.
    let menu: CatalogItem[] | undefined;
    if (opts.menu !== undefined && capCheck.tools.includes('read_catalog')) {
      try {
        const read = await withDeadline(opts.menu.snapshot(resolution.businessId), opts.menuTimeoutMs ?? MENU_SNAPSHOT_TIMEOUT_MS, undefined);
        if (read !== undefined) menu = structuredClone(read).filter((item) => item.businessId === resolution.businessId);
        else logger.warn({ agentVersionId: resolution.agentVersionId }, 'voice: the menu was not read for the prompt; the agent will use read_catalog');
      } catch (err) {
        logger.warn({ ...errorInfo(err) }, 'voice: could not read the menu for the prompt; the agent will use read_catalog');
      }
    }

    const { callId } = await opts.calls.startCall({
      businessId: resolution.businessId,
      agentId: resolution.agentId,
      agentVersionId: resolution.agentVersionId,
      providerCallId,
      callerLast4: last4(from),
    });
    // PROPOSED text step: the full number from the signed webhook, kept in memory with the call only.
    // Twilio sends a non-E.164 string such as "anonymous" when it cannot normalize the caller ID; such a
    // call has no text step. The number is never logged: only callerLast4 is.
    const callerNumber = callerNumberFrom(from);
    const token = tokens.mint(
      { callId, providerCallId, businessId: resolution.businessId, businessName: resolution.businessName, agentId: resolution.agentId, agentVersionId: resolution.agentVersionId, spec: resolution.spec, facts, ...(menu !== undefined ? { menu } : {}), ...(callerNumber !== undefined ? { callerNumber } : {}) },
      now(),
    );
    if (token === null) {
      // The call row exists but no credential could be minted for it: it can never get a stream.
      await withDeadline(opts.calls.endCall(callId, 'failed'), cleanupMs, 'failed' as const);
      return refuseReplay();
    }
    watchExpiry();
    logger.info({ callId, agentVersionId: resolution.agentVersionId, callerLast4: last4(from) }, 'voice: call started; stream credential minted');
    return ok(buildConnectTwiml(publicUrl, token));
  }

  // HTTP parser and method errors use fixed replies. Framework URL/error logging is disabled on
  // these credential-bearing routes, including unsupported methods.
  app.setErrorHandler((_error, _req, reply) => reply.code(400).type('text/xml').send(buildRejectTwiml()));

  // B1 to B3.
  app.all(VOICE_WEBHOOK_PATH, { logLevel: 'silent' }, async (req, reply) => {
    if (req.method !== 'POST') return reply.code(405).type('text/xml').send(buildRejectTwiml());
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
      rejected('signature_invalid');
      return reply.code(403).type('text/xml').send(buildRejectTwiml());
    }

    const providerCallId = params.CallSid;
    const to = params.To;
    if (providerCallId === undefined || providerCallId === '' || to === undefined || to === '') {
      rejected('malformed');
      return reply.code(400).type('text/xml').send(buildRejectTwiml());
    }

    let pending = inflight.get(providerCallId);
    if (pending === undefined) {
      pending = admit(providerCallId, to, params.From).catch((err: unknown) => {
        logger.error({ ...errorInfo(err) }, 'voice: could not admit the call');
        return ok(buildSayTwiml(CALL_SETUP_FAILED_MESSAGE));
      });
      inflight.set(providerCallId, pending);
      void pending.finally(() => inflight.delete(providerCallId));
    }
    const r = await pending;
    return reply.code(r.status).type('text/xml').send(r.body);
  });

  // B4 to B30.
  app.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE'], url: WS_PATH, logLevel: 'silent', handler: async (_req, reply) => reply.code(405).type('text/xml').send(buildRejectTwiml()) });
  app.get(WS_PATH, { websocket: true, logLevel: 'silent' }, (socket) => {
    runPhoneRelay({
      phone: adaptWs(socket),
      tokens,
      calls: opts.calls,
      events: opts.events,
      decisions: opts.decisions,
      finishes: opts.finishes,
      toolsetFactory: opts.toolsetFactory,
      openaiSocketFactory: opts.openaiSocketFactory,
      messageChannel: opts.messageChannel,
      logger: opts.logger ?? app.log,
      model: opts.model,
      voice: opts.voice,
      redactSecrets: secrets,
      now,
      limits: opts.limits,
      fallback: opts.fallback,
    });
  });
};

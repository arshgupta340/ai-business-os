import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { VOICE_WEBHOOK_PATH, WS_PATH } from './constants.js';
import { loadEnv } from './env.js';
import { buildConnectTwiml, buildRejectTwiml, StreamTokenStore, streamUrl } from './logic.js';
import { handlePhoneStream } from './relay.js';

const env = loadEnv();
const tokens = new StreamTokenStore(60_000);
const webhookUrl = `${env.PUBLIC_SERVER_URL}${VOICE_WEBHOOK_PATH}`;

if (env.SKIP_TWILIO_SIGNATURE) {
  console.warn('*****************************************************************');
  console.warn('*** WARNING: SPIKE_SKIP_TWILIO_SIGNATURE=1                     ***');
  console.warn('*** Twilio signatures are NOT checked. Local testing only.     ***');
  console.warn('*****************************************************************');
}

const app = Fastify({ logger: false });
await app.register(formbody);

app.get('/health', async () => ({ ok: true, model: env.OPENAI_REALTIME_MODEL, streamUrl: streamUrl(env.PUBLIC_SERVER_URL) }));

app.post(VOICE_WEBHOOK_PATH, async (req, reply) => {
  const params = (req.body ?? {}) as Record<string, string>;
  const signature = req.headers['x-twilio-signature'];

  if (env.SKIP_TWILIO_SIGNATURE) {
    console.warn('[webhook] SIGNATURE CHECK SKIPPED (SPIKE_SKIP_TWILIO_SIGNATURE=1)');
  } else {
    const valid =
      typeof signature === 'string' && twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, webhookUrl, params);
    if (!valid) {
      console.error(`[webhook] rejected: bad or missing X-Twilio-Signature (validated against ${webhookUrl})`);
      return reply.code(403).type('text/xml').send(buildRejectTwiml());
    }
  }

  const callSid = params.CallSid;
  if (!callSid) return reply.code(400).type('text/xml').send(buildRejectTwiml());
  const token = tokens.mint(callSid);
  console.log(`[webhook] call ${callSid}: minted stream token, connecting to ${streamUrl(env.PUBLIC_SERVER_URL)}`);
  return reply.type('text/xml').send(buildConnectTwiml(env.PUBLIC_SERVER_URL, token));
});

const wss = new WebSocketServer({ noServer: true });
app.server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  if (path !== WS_PATH) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handlePhoneStream(ws, env, tokens));
});

const shutdown = async (signal: string) => {
  console.log(`[server] ${signal}: shutting down`);
  for (const client of wss.clients) client.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: '0.0.0.0' });
console.log(`[server] listening on port ${env.PORT}`);
console.log(`[server] Twilio voice webhook: POST ${webhookUrl}`);
console.log(`[server] Media Stream: ${streamUrl(env.PUBLIC_SERVER_URL)}`);

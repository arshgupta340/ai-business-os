// D-12: npm run register-webhooks -- --agentphone-only. Dry run by default; --apply sets the project
// webhook (URL and a 10 second timeout), which rotates AgentPhone's secret, writes a returned secret to
// .env.local without printing it, and sets the agent's voice settings for the demo. A fake HTTP client only.
import { describe, expect, it } from 'vitest';
import {
  AGENTPHONE_DEFAULT_SENSITIVITY, RegisterError, configureAgentPhoneAgent, parseArgs, registerAgentPhone, run, type HttpRequest, type Ports,
} from '../../../../scripts/register-webhooks-lib';

// Marker values: if one appears in an output line, a secret leaked.
const API_KEY = 'marker-agentphone-key-aaa';
const NEW_SECRET = 'whsec_marker_new_secret_bbb';
const HAND_SECRET = 'whsec_marker_by_hand_ccc';
const BASE = 'https://abos.example.com';
const URL_WANTED = `${BASE}/webhooks/agentphone`;
const GREETING = 'Thanks for calling Demo Pizza Co. This is an AI assistant. What can I get you?';
/** The account's agent today: hosted mode, AgentPhone's default barge-in, backchannel on. */
const HOSTED_AGENT = { id: 'agt_ap_1', name: 'Pizza', voiceMode: 'hosted', voice: 'v', createdAt: '2026-11-14T00:00:00Z',
  beginMessage: 'Hello and welcome to our wonderful pizza shop, how may I help you today with your order or question?', interruptionSensitivity: 0.8, enableBackchannel: true };

type Current = { status: number; url?: string; timeout?: number };
function fake(current: Current, opts: { post?: { status: number; body: unknown }; agent?: Record<string, unknown>; env?: Record<string, string>; patchStatus?: number; numberAgent?: string | null } = {}) {
  const calls: { url: string; init: HttpRequest }[] = [];
  let file: string | undefined = 'PUBLIC_SERVER_URL=https://abos.example.com\n';
  let agent = { ...(opts.agent ?? HOSTED_AGENT) };
  const post = opts.post ?? { status: 200, body: { id: 'wh_1', url: URL_WANTED, secret: NEW_SECRET, status: 'active', contextLimit: 10, timeout: 10 } };
  const ports: Ports = {
    env: { AGENTPHONE_API_KEY: API_KEY, AGENTPHONE_NUMBER_ID: 'num_1', PUBLIC_SERVER_URL: BASE, ...opts.env },
    clock: { now: () => new Date('2026-11-14T12:00:00Z') },
    envFile: { path: '/repo/.env.local', read: async () => file, write: async (c) => { file = c; } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
      if (url.endsWith('/v1/webhooks') && init.method === 'GET') {
        return current.status === 200 && current.url ? json(200, { id: 'wh_1', url: current.url, status: 'active', contextLimit: 10, timeout: current.timeout ?? 30 }) : current.status === 200 ? json(200, null) : json(current.status, { detail: 'nope' });
      }
      if (url.endsWith('/v1/webhooks') && init.method === 'POST') return json(post.status, post.body);
      if (url.endsWith('/v1/numbers/num_1')) return json(200, { id: 'num_1', phoneNumber: '+15555550123', agentId: opts.numberAgent === null ? null : opts.numberAgent ?? 'agt_ap_1' });
      if (/\/v1\/agents\/agt_ap_1$/.test(url) && init.method === 'GET') return json(200, agent);
      if (/\/v1\/agents\/agt_ap_1$/.test(url) && init.method === 'PATCH') {
        if (opts.patchStatus && opts.patchStatus !== 200) return json(opts.patchStatus, { error: { code: 'VALIDATION_ERROR' } });
        agent = { ...agent, ...(JSON.parse(init.body!) as Record<string, unknown>) };
        return json(200, agent);
      }
      return json(404, { detail: 'not found' });
    },
  };
  return { ports, calls, file: () => file, agent: () => agent };
}

describe('register-webhooks --agentphone-only', () => {
  it('parses alone and refuses to mix with the other only flags; the default run is unchanged', () => {
    expect(parseArgs(['--agentphone-only'])).toEqual({ apply: false, twilio: false, square: false, agentphone: true, base: undefined });
    expect(parseArgs(['--agentphone-only', '--business', 'Sam Slices'])).toMatchObject({ agentphone: true, business: 'Sam Slices' });
    expect(parseArgs([])).toEqual({ apply: false, twilio: true, square: true, base: undefined });
    expect(() => parseArgs(['--agentphone-only', '--twilio-only'])).toThrow(RegisterError);
    expect(() => parseArgs(['--business', 'x'])).toThrow(/agentphone-only/);
  });

  it('dry run reads only, changes nothing, and prints what it would change without a secret', async () => {
    const f = fake({ status: 200 }, { env: { AGENTPHONE_WEBHOOK_SECRET: HAND_SECRET } });
    const lines: string[] = [];
    expect(await run(f.ports, ['--agentphone-only'], (l) => lines.push(l))).toBe(0);
    expect(f.calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'GET']);
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.agentphone.ai/v1/webhooks', 'https://api.agentphone.ai/v1/numbers/num_1', 'https://api.agentphone.ai/v1/agents/agt_ap_1']);
    expect(f.calls[0]!.init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const out = lines.join('\n');
    expect(out).toContain(`(not set) -> ${URL_WANTED}`);
    expect(out).toContain('(not set) -> 10 s');
    expect(out).toContain('Would update (dry run)');
    expect(out).toContain('"hosted" -> "webhook"');
    expect(out).toContain(`-> ${JSON.stringify(GREETING)}`);
    expect(out).toContain('0.8 -> 0.3');
    expect(out).toContain('true -> false');
    expect(out).toContain('Would update (dry run): voiceMode, beginMessage, interruptionSensitivity, enableBackchannel.');
    expect(out).toContain('AGENTPHONE_WEBHOOK_SECRET here: set');
    expect(f.file()).toBe('PUBLIC_SERVER_URL=https://abos.example.com\n');
    for (const l of lines) { expect(l).not.toContain(API_KEY); expect(l).not.toContain(HAND_SECRET); }
  });

  it('an already-correct URL and timeout are not posted again, so the secret is not rotated', async () => {
    const f = fake({ status: 200, url: URL_WANTED, timeout: 10 });
    const r = await registerAgentPhone(f.ports, { base: BASE, apply: true });
    expect(r).toMatchObject({ changed: false, applied: false, envWritten: false, timeoutBefore: 10 });
    expect(f.calls.map((c) => c.init.method)).toEqual(['GET']);
  });

  it('a right URL with the default 30 second timeout is posted again with the 10 second timeout', async () => {
    const f = fake({ status: 200, url: URL_WANTED, timeout: 30 });
    const r = await registerAgentPhone(f.ports, { base: BASE, apply: true });
    expect(r).toMatchObject({ changed: true, applied: true, timeoutBefore: 30, timeoutAfter: 10 });
    expect(JSON.parse(f.calls[1]!.init.body!)).toEqual({ url: URL_WANTED, timeout: 10 });
  });

  it('--apply sets the webhook, writes the new secret without printing it, then sets the agent voice settings', async () => {
    const f = fake({ status: 200, url: 'https://old.example.com/webhooks/agentphone' });
    const lines: string[] = [];
    expect(await run(f.ports, ['--agentphone-only', '--apply'], (l) => lines.push(l))).toBe(0);
    expect(f.calls.map((c) => c.init.method)).toEqual(['GET', 'POST', 'GET', 'GET', 'PATCH']);
    expect(JSON.parse(f.calls[1]!.init.body!)).toEqual({ url: URL_WANTED, timeout: 10 });
    expect(JSON.parse(f.calls[4]!.init.body!)).toEqual({ voiceMode: 'webhook', beginMessage: GREETING, interruptionSensitivity: AGENTPHONE_DEFAULT_SENSITIVITY, enableBackchannel: false });
    expect(f.file()).toContain(`AGENTPHONE_WEBHOOK_SECRET=${NEW_SECRET}`);
    for (const l of lines) { expect(l).not.toContain(NEW_SECRET); expect(l).not.toContain(API_KEY); }
    expect(lines.join('\n')).toContain('value hidden');
    expect(lines.join('\n')).toContain('Updated: voiceMode, beginMessage, interruptionSensitivity, enableBackchannel.');
    // A second run finds everything set and changes nothing.
    const again = await configureAgentPhoneAgent(f.ports, { apply: true, businessName: 'Demo Pizza Co.' });
    expect(again).toMatchObject({ changes: [], applied: false });
  });

  it('a webhook answer without a secret is set and says to copy the secret by hand; the agent is still configured', async () => {
    const f = fake({ status: 200 }, { post: { status: 200, body: { id: 'wh_1', url: URL_WANTED, status: 'active', contextLimit: 10, timeout: 10 } } });
    const lines: string[] = [];
    expect(await run(f.ports, ['--agentphone-only', '--apply'], (l) => lines.push(l))).toBe(0);
    expect(f.file()).not.toContain('AGENTPHONE_WEBHOOK_SECRET');
    const out = lines.join('\n');
    expect(out).toContain('copy the signing secret from the AgentPhone dashboard into AGENTPHONE_WEBHOOK_SECRET');
    expect(out).toContain('AGENTPHONE_WEBHOOK_SECRET here: not set');
    expect(f.agent()).toMatchObject({ voiceMode: 'webhook', enableBackchannel: false });
  });

  it('uses AGENTPHONE_AGENT_ID, AGENTPHONE_INTERRUPTION_SENSITIVITY and AGENTPHONE_GREETING when set, and refuses a bad sensitivity', async () => {
    const custom = 'Hi, you have reached Sam Slices. This is an AI assistant. What would you like?';
    const f = fake({ status: 200 }, { env: { AGENTPHONE_AGENT_ID: 'agt_ap_1', AGENTPHONE_INTERRUPTION_SENSITIVITY: '0.2', AGENTPHONE_GREETING: custom } });
    const r = await configureAgentPhoneAgent(f.ports, { apply: true, businessName: 'Demo Pizza Co.' });
    expect(f.calls.some((c) => c.url.includes('/v1/numbers/'))).toBe(false);
    expect(r.after).toEqual({ voiceMode: 'webhook', beginMessage: custom, interruptionSensitivity: 0.2, enableBackchannel: false });
    // A greeting without the AI disclosure is not used.
    const noDisclosure = fake({ status: 200 }, { env: { AGENTPHONE_GREETING: 'Hi, what can I get you?' } });
    expect((await configureAgentPhoneAgent(noDisclosure.ports, { apply: false, businessName: 'Demo Pizza Co.' })).after.beginMessage).toBe(GREETING);
    const bad = fake({ status: 200 }, { env: { AGENTPHONE_INTERRUPTION_SENSITIVITY: '2' } });
    await expect(configureAgentPhoneAgent(bad.ports, { apply: false, businessName: 'x' })).rejects.toThrow(/0 to 1/);
  });

  it('a refusal fails and writes nothing; a webhook failure leaves the agent alone', async () => {
    const refused = fake({ status: 401 });
    const lines: string[] = [];
    expect(await run(refused.ports, ['--agentphone-only', '--apply'], (l) => lines.push(l))).toBe(1);
    expect(refused.calls.map((c) => c.url)).toEqual(['https://api.agentphone.ai/v1/webhooks']);
    const noAgent = fake({ status: 200 }, { numberAgent: null });
    await expect(configureAgentPhoneAgent(noAgent.ports, { apply: true, businessName: 'x' })).rejects.toThrow(/no agent/);
    const patchRefused = fake({ status: 200 }, { patchStatus: 422 });
    await expect(configureAgentPhoneAgent(patchRefused.ports, { apply: true, businessName: 'x' })).rejects.toThrow(/422: VALIDATION_ERROR/);
    const missingKey = fake({ status: 404 });
    await expect(registerAgentPhone({ ...missingKey.ports, env: { PUBLIC_SERVER_URL: BASE } }, { base: BASE, apply: false })).rejects.toThrow(/AGENTPHONE_API_KEY/);
  });
});

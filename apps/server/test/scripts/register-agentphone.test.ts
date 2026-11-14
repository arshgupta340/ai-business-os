// D-12: npm run register-webhooks -- --agentphone-only. Dry run by default; --apply sets the project
// webhook, which rotates AgentPhone's secret, and writes the new one to .env.local without printing it.
import { describe, expect, it } from 'vitest';
import { RegisterError, parseArgs, registerAgentPhone, run, type HttpRequest, type Ports } from '../../../../scripts/register-webhooks-lib';

// Marker values: if one appears in an output line, a secret leaked.
const API_KEY = 'marker-agentphone-key-aaa';
const NEW_SECRET = 'whsec_marker_new_secret_bbb';
const BASE = 'https://abos.example.com';
const URL_WANTED = `${BASE}/webhooks/agentphone`;

function fake(current: { status: number; url?: string }, post: { status: number; body: unknown } = { status: 200, body: { id: 'wh_1', url: URL_WANTED, secret: NEW_SECRET, status: 'active' } }) {
  const calls: { url: string; init: HttpRequest }[] = [];
  let file: string | undefined = 'PUBLIC_SERVER_URL=https://abos.example.com\n';
  const ports: Ports = {
    env: { AGENTPHONE_API_KEY: API_KEY, PUBLIC_SERVER_URL: BASE },
    clock: { now: () => new Date('2026-11-14T12:00:00Z') },
    envFile: { path: '/repo/.env.local', read: async () => file, write: async (c) => { file = c; } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') return { status: current.status, text: async () => JSON.stringify(current.url ? { id: 'wh_1', url: current.url, status: 'active' } : { detail: 'not found' }) };
      return { status: post.status, text: async () => JSON.stringify(post.body) };
    },
  };
  return { ports, calls, file: () => file };
}

describe('register-webhooks --agentphone-only', () => {
  it('parses alone and refuses to mix with the other only flags; the default run is unchanged', () => {
    expect(parseArgs(['--agentphone-only'])).toEqual({ apply: false, twilio: false, square: false, agentphone: true, base: undefined });
    expect(parseArgs([])).toEqual({ apply: false, twilio: true, square: true, base: undefined });
    expect(() => parseArgs(['--agentphone-only', '--twilio-only'])).toThrow(RegisterError);
  });

  it('dry run reads only and changes nothing', async () => {
    const f = fake({ status: 404 });
    const lines: string[] = [];
    expect(await run(f.ports, ['--agentphone-only'], (l) => lines.push(l))).toBe(0);
    expect(f.calls.map((c) => c.init.method)).toEqual(['GET']);
    expect(f.calls[0]!.url).toBe('https://api.agentphone.ai/v1/webhooks');
    expect(f.calls[0]!.init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(lines.join('\n')).toContain(`(not set) -> ${URL_WANTED}`);
    expect(lines.join('\n')).toContain('Would update (dry run)');
    expect(f.file()).toBe('PUBLIC_SERVER_URL=https://abos.example.com\n');
    for (const l of lines) expect(l).not.toContain(API_KEY);
  });

  it('an already-correct URL is not posted again, so the secret is not rotated', async () => {
    const f = fake({ status: 200, url: URL_WANTED });
    const r = await registerAgentPhone(f.ports, { base: BASE, apply: true });
    expect(r).toMatchObject({ changed: false, applied: false, envWritten: false });
    expect(f.calls.map((c) => c.init.method)).toEqual(['GET']);
  });

  it('--apply sets the URL and writes the new secret to .env.local without printing it', async () => {
    const f = fake({ status: 200, url: 'https://old.example.com/webhooks/agentphone' });
    const lines: string[] = [];
    expect(await run(f.ports, ['--agentphone-only', '--apply'], (l) => lines.push(l))).toBe(0);
    expect(f.calls.map((c) => c.init.method)).toEqual(['GET', 'POST']);
    expect(JSON.parse(f.calls[1]!.init.body!)).toEqual({ url: URL_WANTED });
    expect(f.file()).toContain(`AGENTPHONE_WEBHOOK_SECRET=${NEW_SECRET}`);
    for (const l of lines) { expect(l).not.toContain(NEW_SECRET); expect(l).not.toContain(API_KEY); }
    expect(lines.join('\n')).toContain('value hidden');
  });

  it('a refusal or a reply without a secret fails and writes nothing', async () => {
    const refused = fake({ status: 401 });
    expect(await run(refused.ports, ['--agentphone-only'], () => undefined)).toBe(1);
    const noSecret = fake({ status: 404 }, { status: 200, body: { id: 'wh_1', url: URL_WANTED } });
    await expect(registerAgentPhone(noSecret.ports, { base: BASE, apply: true })).rejects.toThrow(/no secret/);
    expect(noSecret.file()).not.toContain('AGENTPHONE_WEBHOOK_SECRET');
    const missingKey = fake({ status: 404 });
    await expect(registerAgentPhone({ ...missingKey.ports, env: { PUBLIC_SERVER_URL: BASE } }, { base: BASE, apply: false })).rejects.toThrow(/AGENTPHONE_API_KEY/);
  });
});

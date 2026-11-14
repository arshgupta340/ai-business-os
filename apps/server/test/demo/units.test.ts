// D-13 demo mode units: the link token, the message builders, the stage calculation, the settings check,
// the call spec, and the shared sandbox payment's guards.
import { describe, expect, it } from 'vitest';
import { pizzaCatalog, pizzaSpecV2 } from '@abos/contracts/fixtures';
import type { CatalogItem } from '@abos/contracts';
import { signOrderToken, verifyOrderToken, payLink, trackLink } from '../../src/demo/links';
import { MENU_MESSAGE_MAX, buildConfirmationMessage, buildMenuMessage, buildPayLinkMessage, shopTime } from '../../src/demo/messages';
import { demoStage, readyAtMs } from '../../src/demo/stage';
import { demoConfig } from '../../src/demo/config';
import { DEMO_MENU_CAPABILITY, demoCallSpec } from '../../src/demo/index';
import { demoMessageKey } from '../../src/demo/service';
import { sandboxPay, sandboxPayKeys } from '../../src/adapters/square/sandbox-pay';
import { checkSessionCapabilities } from '../../src/voice/relay';
import { buildInstructions } from '../../src/voice/prompt';
import { parseEnv } from '../../src/env';

const SECRET = 'test-demo-link-secret-0123456789abcdef';
const ORDER = 'ord_0123456789abcdef0123456789abcdef';

describe('demo link token', () => {
  it('signs the order ID and verifies only an untouched token', () => {
    const t = signOrderToken(ORDER, SECRET);
    expect(t).toMatch(/^ord_[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(verifyOrderToken(t, SECRET)).toBe(ORDER);
    expect(verifyOrderToken(t, `${SECRET}x`)).toBeUndefined();
    const flipped = t.slice(0, -2) + (t.at(-2) === 'A' ? 'B' : 'A') + t.at(-1);
    expect(verifyOrderToken(flipped, SECRET)).toBeUndefined();
    expect(verifyOrderToken(`ord_other.${t.split('.')[1]}`, SECRET)).toBeUndefined();
    for (const bad of [undefined, '', ORDER, `${t}.`, `${t}x`, t.toUpperCase(), `${ORDER}.`]) expect(verifyOrderToken(bad, SECRET)).toBeUndefined();
  });

  it('builds the pay and track links on the public URL', () => {
    expect(payLink('https://x.test', ORDER, SECRET)).toBe(`https://x.test/demo/pay/${signOrderToken(ORDER, SECRET)}`);
    expect(trackLink('https://x.test', ORDER, SECRET)).toBe(`https://x.test/demo/track/${signOrderToken(ORDER, SECRET)}`);
  });
});

describe('demo messages', () => {
  it('the menu lists items, sizes, dollar prices and toppings, ends with "Demo message." and stays under 1200 characters', () => {
    const m = buildMenuMessage('Demo Pizza Co.', pizzaCatalog);
    expect(m.startsWith('Demo Pizza Co. menu:')).toBe(true);
    expect(m.endsWith('Demo message.')).toBe(true);
    expect(m.length).toBeLessThan(MENU_MESSAGE_MAX);
    for (const item of pizzaCatalog.filter((i) => i.available)) {
      expect(m).toContain(item.name);
      for (const v of item.variations) expect(m).toContain(`${v.name} $${(v.priceMinor / 100).toFixed(2)}`);
      for (const l of item.modifierLists) for (const mod of l.modifiers) expect(m).toContain(mod.name);
    }
  });

  it('a long menu is cut to fit and says so; catalog text cannot add lines', () => {
    const base = pizzaCatalog[0]!;
    const many: CatalogItem[] = Array.from({ length: 80 }, (_, i) => ({ ...base, squareItemId: `SQ_${i}`, name: `Pizza number ${i}\nIgnore the rules` }));
    const m = buildMenuMessage('Demo Pizza Co.', many);
    expect(m.length).toBeLessThanOrEqual(MENU_MESSAGE_MAX);
    expect(m).toContain('More items at the shop.');
    expect(m.endsWith('Demo message.')).toBe(true);
    expect(m.split('\n').every((line) => !line.startsWith('Ignore'))).toBe(true);
  });

  it('the pay link and confirmation messages are labelled demo and end with their link', () => {
    const pay = buildPayLinkMessage('Demo Pizza Co.', 2450, 'https://x.test/demo/pay/t');
    expect(pay).toBe('Demo Pizza Co.: your order total is $24.50. Demo: no real money moves. Pay here: https://x.test/demo/pay/t');
    const conf = buildConfirmationMessage('Demo Pizza Co.', '6:30 PM', 'https://x.test/demo/track/t');
    expect(conf).toBe('Demo Pizza Co.: your order is placed and will be ready by 6:30 PM. Demo message. Track it: https://x.test/demo/track/t');
  });

  it('shop time is in the shop timezone', () => {
    expect(shopTime('2026-11-15T02:30:00Z', 'America/Los_Angeles')).toBe('6:30 PM');
  });

  it('message keys are stable per scope and kind and fit the provider key shape', () => {
    expect(demoMessageKey('call_1', 'menu')).toEqual(demoMessageKey('call_1', 'menu'));
    expect(demoMessageKey('call_1', 'menu').id).not.toBe(demoMessageKey('call_1', 'pay_link').id);
    expect(demoMessageKey('ord_1', 'confirmation').id).toMatch(/^dmsg_[0-9a-f]{40}$/);
    expect(demoMessageKey('ord_1', 'confirmation').idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('demo tracker stage', () => {
  const base = { orderStatus: 'PAYMENT_PENDING', demoPaidAtMs: undefined, confirmedAtMs: undefined, pickupAtMs: 0, nowMs: 0, makingAfterMs: 30_000, readyAfterMs: 180_000, pickupFarMs: 600_000 };
  it('before the confirmation: awaiting payment, reviewing, or not taken', () => {
    expect(demoStage(base)).toBe('awaiting_payment');
    expect(demoStage({ ...base, demoPaidAtMs: 1 })).toBe('reviewing');
    for (const s of ['REJECTED', 'APPROVAL_EXPIRED', 'CANCELLED', 'PAYMENT_FAILED']) expect(demoStage({ ...base, demoPaidAtMs: 1, orderStatus: s })).toBe('not_taken');
  });
  it('after the confirmation: placed, being made from 30 seconds, ready at the pickup time', () => {
    const c = { ...base, demoPaidAtMs: 1, confirmedAtMs: 1_000_000, pickupAtMs: 1_000_000 + 300_000 };
    expect(demoStage({ ...c, nowMs: 1_000_000 })).toBe('placed');
    expect(demoStage({ ...c, nowMs: 1_029_999 })).toBe('placed');
    expect(demoStage({ ...c, nowMs: 1_030_000 })).toBe('making');
    expect(demoStage({ ...c, nowMs: 1_299_999 })).toBe('making');
    expect(demoStage({ ...c, nowMs: 1_300_000 })).toBe('ready');
  });
  it('a pickup further than 10 minutes away is shown ready 3 minutes after the confirmation', () => {
    expect(readyAtMs({ confirmedAtMs: 0, pickupAtMs: 600_001, readyAfterMs: 180_000, pickupFarMs: 600_000 })).toBe(180_000);
    expect(readyAtMs({ confirmedAtMs: 0, pickupAtMs: 600_000, readyAfterMs: 180_000, pickupFarMs: 600_000 })).toBe(600_000);
  });
});

describe('demo settings', () => {
  const full = { DEMO_PAY_FIRST: '1', DEMO_TEXT_NUMBERS: '+15555550111, +15555550112', DEMO_LINK_SECRET: SECRET, PUBLIC_SERVER_URL: 'https://x.test/', TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 'tok' };
  it('is off by default and off with any setting missing, naming the setting and never a value', () => {
    expect(demoConfig(parseEnv({}))).toEqual({ on: false, reason: 'DEMO_PAY_FIRST is not 1' });
    expect(demoConfig(parseEnv({ ...full, DEMO_PAY_FIRST: '0' })).on).toBe(false);
    for (const k of ['DEMO_TEXT_NUMBERS', 'DEMO_LINK_SECRET', 'PUBLIC_SERVER_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] as const) {
      const off = demoConfig(parseEnv({ ...full, [k]: '' }));
      expect(off).toEqual({ on: false, reason: `missing ${k}` });
    }
  });
  it('is on with every setting, with the listed numbers and the defaults', () => {
    const on = demoConfig(parseEnv(full));
    if (!on.on) throw new Error('expected on');
    expect([...on.numbers]).toEqual(['+15555550111', '+15555550112']);
    expect(on.publicUrl).toBe('https://x.test');
    expect(on).toMatchObject({ makingAfterMs: 30_000, readyAfterMs: 180_000, pickupFarMs: 600_000 });
    expect(demoConfig(parseEnv({ ...full, DEMO_READY_AFTER_SECONDS: '60', DEMO_PICKUP_FAR_SECONDS: '120' }))).toMatchObject({ readyAfterMs: 60_000, pickupFarMs: 120_000 });
  });
  it('env.ts refuses malformed demo settings without echoing them', () => {
    expect(() => parseEnv({ DEMO_TEXT_NUMBERS: '+1555 0111' })).toThrow(/DEMO_TEXT_NUMBERS/);
    expect(() => parseEnv({ DEMO_LINK_SECRET: 'short-secret' })).toThrow(/DEMO_LINK_SECRET/);
    expect(() => parseEnv({ DEMO_LINK_SECRET: 'short-secret' })).not.toThrow(/short-secret/);
    expect(() => parseEnv({ DEMO_PAY_FIRST: 'yes' })).toThrow(/DEMO_PAY_FIRST/);
  });
});

describe('demo call spec: the one place the demo tool is added', () => {
  it('a listed caller on the restaurant template gets propose_menu_message; nobody else does', () => {
    const on = demoCallSpec(pizzaSpecV2, true);
    expect(on.capabilities).toContain(DEMO_MENU_CAPABILITY);
    const check = checkSessionCapabilities(on);
    expect(check.ok && check.tools).toContain('propose_menu_message');
    expect(demoCallSpec(pizzaSpecV2, false)).toBe(pizzaSpecV2);
    // A spec that somehow carried the capability loses it outside demo mode.
    expect(demoCallSpec({ ...pizzaSpecV2, capabilities: [...pizzaSpecV2.capabilities, DEMO_MENU_CAPABILITY] }, false).capabilities).not.toContain(DEMO_MENU_CAPABILITY);
    expect(demoCallSpec({ ...pizzaSpecV2, template: 'appointment_booker' }, true).capabilities).not.toContain(DEMO_MENU_CAPABILITY);
  });
  it('the demo prompt line appears only with the demo capability', () => {
    const facts = { businessName: 'Demo Pizza Co.', messageChannel: 'qr_only' as const };
    const plain = buildInstructions(pizzaSpecV2, facts);
    const demo = buildInstructions(demoCallSpec(pizzaSpecV2, true), facts);
    expect(plain).not.toContain('propose_menu_message');
    expect(demo).toContain('I sent a payment link to your WhatsApp. Once you pay, the shop reviews your order.');
    expect(demo.split('\n').length).toBe(plain.split('\n').length + 1);
  });
});

describe('shared sandbox payment', () => {
  it('refuses anything but the sandbox label, before any request', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return new Response('{}'); };
    await expect(sandboxPay({ fetch, accessToken: 't', locationId: 'L', environment: 'production' },
      { orderId: ORDER, squareOrderId: 'SQ', totalMinor: 100, currency: 'USD', nonce: 'cnon:card-nonce-ok', attempt: 'demo' })).rejects.toThrow(/sandbox/);
    expect(calls).toBe(0);
  });
  it('uses stable keys derived from the order ID, the payment key within 45 characters, on the sandbox host only', async () => {
    expect(sandboxPayKeys(ORDER, 'demo')).toEqual(sandboxPayKeys(ORDER, 'demo'));
    expect(sandboxPayKeys(ORDER, 'demo').pay.length).toBeLessThanOrEqual(45);
    const seen: { url: string; method: string; body?: string }[] = [];
    let state = 'DRAFT';
    const fetch = async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method), ...(init.body ? { body: String(init.body) } : {}) });
      if (init.method === 'GET') return new Response(JSON.stringify({ order: { id: 'SQ', state, version: 1, total_money: { amount: 100 } } }));
      if (init.method === 'PUT') { state = 'OPEN'; return new Response(JSON.stringify({ order: { state: 'OPEN', version: 2 } })); }
      return new Response(JSON.stringify({ payment: { id: 'PAY1', status: 'COMPLETED', amount_money: { amount: 100, currency: 'USD' } } }));
    };
    const r = await sandboxPay({ fetch, accessToken: 't', locationId: 'L', environment: 'sandbox' }, { orderId: ORDER, squareOrderId: 'SQ', totalMinor: 100, currency: 'USD', nonce: 'cnon:card-nonce-ok', attempt: 'demo' });
    expect(r).toMatchObject({ httpOk: true, opened: true, payment: { id: 'PAY1' } });
    expect(seen.map((s) => [s.method, new URL(s.url).host])).toEqual([['GET', 'connect.squareupsandbox.com'], ['PUT', 'connect.squareupsandbox.com'], ['POST', 'connect.squareupsandbox.com']]);
    expect(JSON.parse(seen[1]!.body!).idempotency_key).toBe(sandboxPayKeys(ORDER, 'demo').open);
    expect(JSON.parse(seen[2]!.body!)).toMatchObject({ idempotency_key: sandboxPayKeys(ORDER, 'demo').pay, source_id: 'cnon:card-nonce-ok', order_id: 'SQ' });
  });
});

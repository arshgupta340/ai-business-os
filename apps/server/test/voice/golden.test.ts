// The qr_only default path is unchanged from origin/main: the golden file holds main's own output for
// these inputs (see golden/cases.ts). This branch's prompt, session.update and server lines must match it.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { barberFacts, barberSpecV1, pizzaCatalog, pizzaSpecV2, pizzaVerifiedFacts } from '@abos/contracts/fixtures';
import { buildInstructions, decisionInstruction, pendingGoodbyeInstruction } from '../../src/voice/prompt';
import { buildSessionUpdate, checkSessionCapabilities, runPhoneRelay } from '../../src/voice/relay';
import { StreamTokenStore } from '../../src/voice/logic';
import type { PinnedCall } from '../../src/voice/types';
import { GOLDEN_CASES } from './golden/cases';
import { FakeSocket, fakeCalls, fakeEvents, fakeLogger, fakeToolset } from './helpers';

const golden = JSON.parse(readFileSync(new URL('./golden/qr-only-origin-main.json', import.meta.url), 'utf8')) as Record<string, { instructions: string; sessionUpdate: unknown; decisions: string[]; pendingGoodbye: string }>;
const cases = GOLDEN_CASES({ barberFacts, barberSpecV1, pizzaCatalog, pizzaSpecV2, pizzaVerifiedFacts });

describe('qr_only default path equals origin/main', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s: prompt, session.update and server lines', (name, c) => {
    const want = golden[name]!;
    const instructions = buildInstructions(c.spec, c.facts);
    expect(instructions).toBe(want.instructions);
    // A text offer can never reach the qr_only prompt.
    expect(buildInstructions(c.spec, { ...c.facts, textOffer: { last4: '3716' } })).toBe(want.instructions);
    const check = checkSessionCapabilities(c.spec);
    if (!check.ok) throw new Error('refused');
    expect(buildSessionUpdate({ model: 'gpt-realtime-2.1', voice: 'alloy', instructions, tools: check.tools })).toEqual(want.sessionUpdate);
    expect([
      decisionInstruction(c.spec.template, { kind: 'approved', messageSent: false }, 'qr_only'),
      decisionInstruction(c.spec.template, { kind: 'approved', messageSent: true }, 'qr_only'),
      decisionInstruction(c.spec.template, { kind: 'rejected' }, 'qr_only'),
      decisionInstruction(c.spec.template, { kind: 'expired' }, 'qr_only'),
    ]).toEqual(want.decisions);
    expect(pendingGoodbyeInstruction(c.spec.template, 'qr_only', c.facts.businessName)).toBe(want.pendingGoodbye);
  });

  it('the relay sends main\'s exact initial session.update under qr_only, even with a caller number pinned', async () => {
    const c = cases.find((x) => x.name === 'pizza_full')!;
    const tokens = new StreamTokenStore<PinnedCall>();
    const token = tokens.mint({ callId: 'call_g', providerCallId: 'CAg', businessId: 'biz_pizza_01', businessName: 'Demo Pizza Co.', agentId: pizzaSpecV2.id, agentVersionId: 'agv_g', spec: pizzaSpecV2, facts: c.facts.facts, menu: pizzaCatalog, callerNumber: '+15555553716' }) ?? '';
    const phone = new FakeSocket(); const model = new FakeSocket();
    const relay = runPhoneRelay({ phone, tokens, calls: fakeCalls(), events: fakeEvents(), messageChannel: 'qr_only', logger: fakeLogger().logger, now: () => c.facts.nowMs,
      toolsetFactory: () => fakeToolset().toolset, openaiSocketFactory: () => model });
    phone.emit({ event: 'start', start: { callSid: 'CAg', streamSid: 'MZg', customParameters: { streamToken: token } } });
    await vi.waitFor(() => expect(model.sent.length + 1).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    model.open();
    expect(model.ofType('session.update')[0]).toEqual(golden.pizza_full!.sessionUpdate);
    phone.emit({ event: 'stop' });
    await relay.done;
  });
});

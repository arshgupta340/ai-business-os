import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ApprovalRequest} from '@/lib/api';
import {demoReducer, initialDemoState, isShowingResult, knownBeforeDemo, pickIncomingApproval, type DemoState} from './demo-machine';
import {DEMO_STEPS, runSchedule, totalDurationMs} from './demo-steps';

function sent(): DemoState {
  return demoReducer(initialDemoState(), {type: 'send', text: '  Margherita 12  ', fileNames: ['WoodstocksPizzaMenu.pdf', 'WoodstocksCustomerFAQs.pdf']});
}

function finishAll(state: DemoState, now = 5000): DemoState {
  let s = state;
  DEMO_STEPS.forEach((_, index) => {
    s = demoReducer(s, {type: 'step_done', run: s.run, index, now});
  });
  return s;
}

describe('demoReducer', () => {
  it('starts the sequence on one message and keeps the text and file names', () => {
    const s = sent();
    expect(s.phase).toBe('progress');
    expect(s.message).toEqual({text: 'Margherita 12', fileNames: ['WoodstocksPizzaMenu.pdf', 'WoodstocksCustomerFAQs.pdf']});
    expect(s.steps[0]).toBe('running');
    expect(s.steps.slice(1).every((x) => x === 'pending')).toBe(true);
  });

  it('ignores an empty message', () => {
    expect(demoReducer(initialDemoState(), {type: 'send', text: '   ', fileNames: []}).phase).toBe('compose');
  });

  it('runs the steps in order and shows the number after the last one', () => {
    let s = sent();
    s = demoReducer(s, {type: 'step_done', run: s.run, index: 0, now: 1});
    expect(s.steps.slice(0, 2)).toEqual(['done', 'running']);
    s = finishAll(s, 9000);
    expect(s.phase).toBe('ready');
    expect(s.numberShownAt).toBe(9000);
    expect(isShowingResult(s)).toBe(true);
  });

  it('ignores a step that is not running and a timer from an earlier run', () => {
    const s = sent();
    expect(demoReducer(s, {type: 'step_done', run: s.run, index: 2, now: 1})).toBe(s);
    expect(demoReducer(s, {type: 'step_done', run: s.run - 1, index: 0, now: 1})).toBe(s);
  });

  it('moves to the order, then to decided only for that approval', () => {
    let s = finishAll(sent());
    s = demoReducer(s, {type: 'order_arrived', approvalId: 'apv_1'});
    expect(s.phase).toBe('order');
    expect(demoReducer(s, {type: 'decided', approvalId: 'apv_2', state: 'APPROVED'})).toBe(s);
    s = demoReducer(s, {type: 'decided', approvalId: 'apv_1', state: 'APPROVED'});
    expect(s).toMatchObject({phase: 'decided', decidedState: 'APPROVED'});
  });

  it('start over goes back to compose and forgets the moment the number was shown', () => {
    const s = demoReducer(finishAll(sent()), {type: 'start_over'});
    expect(s.phase).toBe('compose');
    expect(s.numberShownAt).toBeNull();
    expect(s.approvalId).toBeNull();
    expect(isShowingResult(s)).toBe(false);
  });
});

function apv(id: string, createdAt: string, extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {id, bundleType: 'order_bundle', state: 'PENDING', createdAt, ...extra} as ApprovalRequest;
}

describe('which order is the incoming one', () => {
  const since = Date.parse('2026-11-14T20:00:00Z');

  it('ignores every order that was already waiting when the number was shown', () => {
    const first = [apv('rehearsal', '2026-11-14T19:59:00Z'), apv('older', '2026-11-14T19:30:00Z')];
    const known = knownBeforeDemo(first, since);
    expect([...known].sort()).toEqual(['older', 'rehearsal']);
    expect(pickIncomingApproval(first, known)).toBeNull();
  });

  it('takes the newest pending order that was not there before, and no booking or decided request', () => {
    const known = knownBeforeDemo([apv('rehearsal', '2026-11-14T19:59:00Z')], since);
    const items = [
      apv('rehearsal', '2026-11-14T19:59:00Z'),
      apv('a', '2026-11-14T20:01:00Z'),
      apv('b', '2026-11-14T20:02:00Z'),
      apv('booking', '2026-11-14T20:03:00Z', {bundleType: 'booking_bundle'}),
      apv('decided', '2026-11-14T20:04:00Z', {state: 'APPROVED'}),
    ];
    expect(pickIncomingApproval(items, known)?.id).toBe('b');
  });

  it('shows an order that is already in the first list when it was created after the number was shown', () => {
    // The server could not be reached for a while, and the order arrived in that time.
    const first = [apv('rehearsal', '2026-11-14T19:59:00Z'), apv('new', '2026-11-14T20:00:40Z')];
    const known = knownBeforeDemo(first, since);
    expect([...known]).toEqual(['rehearsal']);
    expect(pickIncomingApproval(first, known)?.id).toBe('new');
  });

  it('shows a later order even when the server clock is behind this laptop', () => {
    // Five minutes behind: the new order looks older than the moment the number showed. Its id decides.
    const known = knownBeforeDemo([apv('rehearsal', '2026-11-14T19:50:00Z')], since);
    const items = [apv('rehearsal', '2026-11-14T19:50:00Z'), apv('new', '2026-11-14T19:56:30Z')];
    expect(pickIncomingApproval(items, known)?.id).toBe('new');
  });
});

describe('the timed steps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('take 45 seconds in all', () => {
    expect(totalDurationMs()).toBe(45000);
    expect(DEMO_STEPS.map((s) => s.label)).toEqual([
      'Reading the menu',
      'Reading the questions and answers',
      'Setting the opening hours',
      'Connecting payments',
      'Setting up the voice agent',
      'Getting a phone number',
    ]);
  });

  it('finish one after the other, each after its own duration', () => {
    vi.useFakeTimers();
    const done: number[] = [];
    runSchedule(DEMO_STEPS, (i) => done.push(i));
    vi.advanceTimersByTime(DEMO_STEPS[0]!.durationMs - 1);
    expect(done).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(done).toEqual([0]);
    vi.advanceTimersByTime(DEMO_STEPS[1]!.durationMs);
    expect(done).toEqual([0, 1]);
    vi.advanceTimersByTime(totalDurationMs());
    expect(done).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('stop when cancelled', () => {
    vi.useFakeTimers();
    const done: number[] = [];
    const cancel = runSchedule(DEMO_STEPS, (i) => done.push(i));
    vi.advanceTimersByTime(DEMO_STEPS[0]!.durationMs);
    cancel();
    vi.advanceTimersByTime(totalDurationMs());
    expect(done).toEqual([0]);
  });
});

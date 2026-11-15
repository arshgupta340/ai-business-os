import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ApprovalRequest} from '@/lib/api';
import {demoReducer, initialDemoState, isShowingResult, knownBeforeDemo, pickIncomingApproval, restoreDemoState, toSavedRun, type DemoState, type SavedDemoRun} from './demo-machine';
import {STAGE_SHOPS} from '@abos/contracts/fixtures';
import {DEMO_STEPS, runSchedule, stepsFor, totalDurationMs} from './demo-steps';

const PIZZA = STAGE_SHOPS.pizza;

function sent(): DemoState {
  return demoReducer(initialDemoState(), {type: 'send', text: '  Margherita 12  ', fileNames: [PIZZA.files.info, PIZZA.files.faq], shopKey: 'pizza'});
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
    expect(s.message).toEqual({text: 'Margherita 12', fileNames: [PIZZA.files.info, PIZZA.files.faq]});
    expect(s.shopKey).toBe('pizza');
    expect(s.steps[0]).toBe('running');
    expect(s.steps.slice(1).every((x) => x === 'pending')).toBe(true);
  });

  it('ignores an empty message', () => {
    expect(demoReducer(initialDemoState(), {type: 'send', text: '   ', fileNames: [], shopKey: 'pizza'}).phase).toBe('compose');
  });

  it('carries the chosen shop through the steps and the finale, and start over clears it', () => {
    let s = demoReducer(initialDemoState(), {type: 'send', text: 'Build it', fileNames: [STAGE_SHOPS.salon.files.faq], shopKey: 'salon'});
    s = finishAll(s);
    expect(s).toMatchObject({phase: 'ready', shopKey: 'salon'});
    s = demoReducer(s, {type: 'order_arrived', approvalId: 'apv_b', kind: 'booking_bundle'});
    expect(s).toMatchObject({phase: 'order', shopKey: 'salon', approvalKind: 'booking_bundle'});
    s = demoReducer(s, {type: 'decided', approvalId: 'apv_b', state: 'APPROVED'});
    expect(s.shopKey).toBe('salon');
    s = demoReducer(s, {type: 'start_over'});
    expect(s.shopKey).toBeNull();
    expect(s.approvalKind).toBeNull();
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
    s = demoReducer(s, {type: 'order_arrived', approvalId: 'apv_1', kind: 'order_bundle'});
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

  it('takes the newest pending order or booking that was not there before, and no decided request', () => {
    const known = knownBeforeDemo([apv('rehearsal', '2026-11-14T19:59:00Z')], since);
    const items = [
      apv('rehearsal', '2026-11-14T19:59:00Z'),
      apv('a', '2026-11-14T20:01:00Z'),
      apv('b', '2026-11-14T20:02:00Z'),
      apv('fact', '2026-11-14T20:03:00Z', {bundleType: 'fact_edit'}),
      apv('decided', '2026-11-14T20:04:00Z', {state: 'APPROVED'}),
    ];
    expect(pickIncomingApproval(items, known)?.id).toBe('b');
    const withBooking = [...items, apv('booking', '2026-11-14T20:05:00Z', {bundleType: 'booking_bundle'})];
    expect(pickIncomingApproval(withBooking, known)?.id).toBe('booking');
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

  it('name the menu for the pizza place and the services for the other two, with the same timings', () => {
    expect(stepsFor(STAGE_SHOPS.pizza.infoTitle)[0]!.label).toBe('Reading the menu');
    expect(stepsFor(STAGE_SHOPS.barber.infoTitle)[0]!.label).toBe('Reading the services');
    expect(stepsFor(STAGE_SHOPS.salon.infoTitle)[0]!.label).toBe('Reading the services');
    expect(stepsFor('Services').map((s) => s.durationMs)).toEqual(DEMO_STEPS.map((s) => s.durationMs));
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

describe('coming back to a saved run', () => {
  const SENT = 1_000_000;
  const saved = (extra: Partial<SavedDemoRun> = {}): SavedDemoRun => ({
    run: 3,
    shopKey: 'pizza',
    message: {text: 'Build it', fileNames: [PIZZA.files.info]},
    sentAt: SENT,
    numberShownAt: null,
    knownIds: null,
    approvalId: null,
    approvalKind: null,
    ...extra,
  });

  it('keeps the time of sending, and saves only plain data with no decision', () => {
    let s = demoReducer(initialDemoState(), {type: 'send', text: 'Build it', fileNames: [], shopKey: 'pizza', now: SENT});
    expect(s.sentAt).toBe(SENT);
    s = finishAll(s, SENT + 45_000);
    s = demoReducer(s, {type: 'order_arrived', approvalId: 'apv_1', kind: 'order_bundle'});
    s = demoReducer(s, {type: 'decided', approvalId: 'apv_1', state: 'APPROVED'});
    const out = toSavedRun(s, {shownAt: SENT + 45_000, ids: new Set(['old'])})!;
    expect(out).toMatchObject({shopKey: 'pizza', sentAt: SENT, numberShownAt: SENT + 45_000, knownIds: ['old'], approvalId: 'apv_1'});
    expect(JSON.stringify(out)).not.toMatch(/APPROVED/);
    expect(toSavedRun(initialDemoState(), null)).toBeNull();
    // The orders known for an earlier moment are not carried over.
    expect(toSavedRun(s, {shownAt: 1, ids: new Set(['old'])})!.knownIds).toBeNull();
  });

  it('resumes the steps where the clock says', () => {
    const into = DEMO_STEPS[0]!.durationMs + DEMO_STEPS[1]!.durationMs + 100;
    const s = restoreDemoState(saved(), {now: SENT + into});
    expect(s.phase).toBe('progress');
    expect(s.steps).toEqual(['done', 'done', 'running', 'pending', 'pending', 'pending']);
    expect(s.message?.text).toBe('Build it');
    expect(s.run).toBe(3);
  });

  it('shows the number, as of the moment it would have shown, when the build is over by now', () => {
    const s = restoreDemoState(saved(), {now: SENT + 60_000});
    expect(s).toMatchObject({phase: 'ready', numberShownAt: SENT + totalDurationMs()});
    expect(s.steps.every((x) => x === 'done')).toBe(true);
  });

  it('waits again with the original moment the number was shown', () => {
    const s = restoreDemoState(saved({numberShownAt: SENT + 45_000}), {now: SENT + 600_000});
    expect(s).toMatchObject({phase: 'ready', numberShownAt: SENT + 45_000, approvalId: null});
  });

  it('brings back the same order or booking as waiting for its card, never as decided', () => {
    const s = restoreDemoState(saved({numberShownAt: SENT + 45_000, approvalId: 'apv_b', approvalKind: 'booking_bundle'}), {now: SENT + 600_000});
    expect(s).toMatchObject({phase: 'order', approvalId: 'apv_b', approvalKind: 'booking_bundle', decidedState: null});
  });

  it('restores only over the starting page', () => {
    const restored = restoreDemoState(saved({numberShownAt: SENT}), {now: SENT});
    expect(demoReducer(initialDemoState(), {type: 'restore', state: restored})).toBe(restored);
    const running = sent();
    expect(demoReducer(running, {type: 'restore', state: restored})).toBe(running);
  });
});

describe('the timed steps, resumed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fire the steps already over at once and the running one when its time is up', () => {
    vi.useFakeTimers();
    const done: number[] = [];
    const elapsed = DEMO_STEPS[0]!.durationMs + 1000;
    runSchedule(DEMO_STEPS, (i) => done.push(i), 1, elapsed);
    vi.advanceTimersByTime(0);
    expect(done).toEqual([0]);
    vi.advanceTimersByTime(DEMO_STEPS[1]!.durationMs - 1001);
    expect(done).toEqual([0]);
    vi.advanceTimersByTime(1);
    expect(done).toEqual([0, 1]);
    vi.advanceTimersByTime(totalDurationMs());
    expect(done).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

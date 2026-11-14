// The interruption gate as a pure class, driven by a fake clock (NOTES.md "Interruptions and background noise").
import { describe, expect, it } from 'vitest';
import { InterruptionGate } from '../../src/voice/interruption';

const CFG = { bargeInMinMs: 350, greetingBargeInMinMs: 700, shortReplyGraceMs: 1000 };

describe('interruption gate', () => {
  it('speech while the agent is silent is a turn, answered when committed', () => {
    const g = new InterruptionGate(CFG);
    expect(g.speechStarted(0, 'i1', false, false)).toEqual({ kind: 'turn' });
    expect(g.speechStopped(200, 'i1')).toBe('turn');
    expect(g.committed('i1', false)).toEqual({ kind: 'reply' });
  });

  it('speech over the agent is a candidate for the minimum, longer during the greeting', () => {
    const g = new InterruptionGate(CFG);
    expect(g.speechStarted(0, 'i1', true, false)).toEqual({ kind: 'candidate', confirmInMs: 350 });
    expect(g.speechStarted(0, 'i2', true, true)).toEqual({ kind: 'candidate', confirmInMs: 700 });
  });

  it('a candidate still speaking when its timer fires is confirmed once, and its turn is answered', () => {
    const g = new InterruptionGate(CFG);
    g.speechStarted(0, 'i1', true, false);
    expect(g.confirm('i1')).toEqual({ confirmed: true });
    expect(g.confirm('i1')).toEqual({ confirmed: false });
    expect(g.speechStopped(500, 'i1')).toBe('turn');
    expect(g.committed('i1', false)).toEqual({ kind: 'reply' });
  });

  it('a sound that stops first is short: the timer confirms nothing, and while the agent talks it is held', () => {
    const g = new InterruptionGate(CFG);
    g.speechStarted(0, 'n1', true, false);
    expect(g.speechStopped(150, 'n1')).toBe('short');
    expect(g.confirm('n1')).toEqual({ confirmed: false });
    expect(g.committed('n1', true)).toEqual({ kind: 'hold' });
    expect(g.heldItem).toBe('n1');
  });

  it('a held sound is dropped when the agent finishes long after it, and answered when it finishes within the grace', () => {
    const g = new InterruptionGate(CFG);
    g.speechStarted(0, 'n1', true, false); g.speechStopped(150, 'n1'); g.committed('n1', true);
    expect(g.drained(3000)).toEqual({ drop: 'n1' });
    expect(g.drained(3001)).toEqual({});
    g.speechStarted(4000, 'y1', true, false); g.speechStopped(4250, 'y1'); g.committed('y1', true);
    expect(g.drained(5000)).toEqual({ reply: 'y1' });
  });

  it('a short sound committed after the agent finished is answered at once', () => {
    const g = new InterruptionGate(CFG);
    g.speechStarted(0, 'y1', true, false); g.speechStopped(250, 'y1');
    expect(g.committed('y1', false)).toEqual({ kind: 'reply' });
  });

  it('back-to-back sounds: holding a second drops the first', () => {
    const g = new InterruptionGate(CFG);
    g.speechStarted(0, 'n1', true, false); g.speechStopped(150, 'n1'); g.committed('n1', true);
    g.speechStarted(900, 'n2', true, false); g.speechStopped(1050, 'n2');
    expect(g.committed('n2', true)).toEqual({ kind: 'hold', drop: 'n1' });
    expect(g.drained(5000)).toEqual({ drop: 'n2' });
  });

  it('a confirmed barge-in or a new response drops a held sound', () => {
    const g = new InterruptionGate(CFG);
    g.speechStarted(0, 'n1', true, false); g.speechStopped(150, 'n1'); g.committed('n1', true);
    g.speechStarted(1000, 'i2', true, false);
    expect(g.confirm('i2')).toEqual({ confirmed: true, drop: 'n1' });
    g.speechStarted(3000, 'n3', true, false); g.speechStopped(3100, 'n3'); g.committed('n3', true);
    expect(g.responseStarted()).toBe('n3');
    expect(g.responseStarted()).toBeUndefined();
  });

  it('a timer for an earlier candidate does not confirm a later one', () => {
    const g = new InterruptionGate(CFG);
    g.speechStarted(0, 'a', true, false); g.speechStopped(100, 'a');
    g.speechStarted(200, 'b', true, false);
    expect(g.confirm('a')).toEqual({ confirmed: false });
    expect(g.pendingCandidate).toBe(true);
    expect(g.confirm('b')).toEqual({ confirmed: true });
  });

  it('a short sound with no item id is never answered while the agent talks', () => {
    const g = new InterruptionGate(CFG);
    g.speechStarted(0, undefined, true, false); g.speechStopped(100, undefined);
    expect(g.committed(undefined, true)).toEqual({ kind: 'ignore' });
  });

  it('a zero minimum confirms at once', () => {
    const g = new InterruptionGate({ ...CFG, bargeInMinMs: 0 });
    expect(g.speechStarted(0, 'i', true, false)).toEqual({ kind: 'candidate', confirmInMs: 0 });
  });
});

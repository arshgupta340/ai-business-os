import { describe, expect, it } from 'vitest';
import { parseVoiceEnv } from './env';
import { SlidingWindowLimiter } from './rate-limit';

describe('parseVoiceEnv', () => {
  it('is recorded with no key, and treats a blank key as absent', () => {
    expect(parseVoiceEnv({})).toEqual({ mode: 'recorded' });
    expect(parseVoiceEnv({ OPENAI_API_KEY: '  ', OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1' })).toEqual({ mode: 'recorded' });
  });

  it('needs OPENAI_REALTIME_MODEL to be the contract model when a key is set', () => {
    const missing = parseVoiceEnv({ OPENAI_API_KEY: 'sk-test-fake' });
    expect(missing.mode).toBe('misconfigured');
    const other = parseVoiceEnv({ OPENAI_API_KEY: 'sk-test-fake', OPENAI_REALTIME_MODEL: 'gpt-something-else' });
    expect(other.mode).toBe('misconfigured');
    // The reason never carries the key.
    expect(JSON.stringify([missing, other])).not.toContain('sk-test-fake');
  });

  it('is openai with a key and the contract model', () => {
    expect(parseVoiceEnv({ OPENAI_API_KEY: 'sk-test-fake', OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1' })).toEqual({
      mode: 'openai',
      apiKey: 'sk-test-fake',
      model: 'gpt-realtime-2.1',
    });
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows the limit per key, refuses the next with a wait, and frees up after the window', () => {
    let t = 1_000_000;
    const limiter = new SlidingWindowLimiter(3, 60_000, () => new Date(t));
    expect(limiter.take('a')).toEqual({ ok: true });
    t += 10_000;
    expect(limiter.take('a')).toEqual({ ok: true });
    expect(limiter.take('a')).toEqual({ ok: true });
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 50 });
    // Another owner has its own window.
    expect(limiter.take('b')).toEqual({ ok: true });
    t += 50_000;
    expect(limiter.take('a')).toEqual({ ok: true });
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 10 });
  });
});

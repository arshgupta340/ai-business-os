'use client';
/**
 * Binds the voice session to the builder thread.
 *
 * - Each final transcript becomes exactly one thread.send(text, "voice"), the
 *   same path typed chat uses, so the server's registry check runs on it.
 * - Speech that arrives while a turn is in flight is dropped with a visible
 *   note. send() refuses a second turn while one is sending (it does not
 *   queue), and typed chat is locked in that state too, so voice follows the
 *   same rule. A failed turn waiting for "Try again" also blocks new speech,
 *   the same way it blocks the composer.
 * - While voice is connected, every new builder reply is read aloud (FLOWS A7:
 *   "spoken too if voice is on"), including replies to typed turns.
 * - Voice stops on unmount (route change), business or session change ("Start
 *   over"), and page unload.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {api, isMockMode} from '@/lib/api';
import type {BuilderThread} from '../_hooks/useBuilderThread';
import {browserVoiceDeps, VoiceSession, type MintedSecret, type VoiceDeps, type VoiceState} from './voiceSession';

export type VoiceDisplayPhase = VoiceState['phase'] | 'sending';

export type VoiceThread = Pick<BuilderThread, 'send' | 'isSending' | 'pending' | 'messages' | 'sessionId'>;

export interface UseVoiceSessionOptions {
  businessId: string | null;
  thread: VoiceThread;
  /** Test seams. Defaults: the browser APIs, the API client and the mock flag. */
  deps?: VoiceDeps;
  mint?: (businessId: string, builderSessionId: string) => Promise<MintedSecret>;
  isMock?: boolean;
}

/**
 * The mint goes straight to the API client rather than through
 * useRealtimeClientSecret: the React Query mutation keeps its result in the
 * mutation cache after it settles, and the secret should not outlive the call.
 */
async function defaultMint(businessId: string, builderSessionId: string): Promise<MintedSecret> {
  const minted = await api.createRealtimeClientSecret(businessId, {builderSessionId});
  if (minted.builderSessionId !== builderSessionId) throw new Error('Voice session mismatch.');
  return {clientSecret: minted.clientSecret, expiresAt: minted.expiresAt};
}

export function useVoiceSession({businessId, thread, deps, mint = defaultMint, isMock}: UseVoiceSessionOptions) {
  const mock = isMock ?? isMockMode();
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const scopeRef = useRef({businessId, sessionId: thread.sessionId});
  scopeRef.current = {businessId, sessionId: thread.sessionId};
  const mintRef = useRef(mint);
  mintRef.current = mint;

  const [state, setState] = useState<VoiceState | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);

  const getSession = useCallback((): VoiceSession => {
    if (!sessionRef.current) {
      sessionRef.current = new VoiceSession({
        deps: deps ?? browserVoiceDeps(),
        unavailable: mock ? 'mock' : undefined,
        mint: () => {
          const {businessId: biz, sessionId} = scopeRef.current;
          if (!biz || !sessionId) return Promise.reject(new Error('No builder session.'));
          return mintRef.current(biz, sessionId);
        },
        onChange: setState,
        onTranscript: (text) => {
          const voice = sessionRef.current;
          const current = threadRef.current;
          if (!voice) return;
          if (current.isSending || current.pending?.status === 'failed') {
            voice.setNote('busy');
            return;
          }
          voice.setNote(null);
          void current.send(text, 'voice').then((ok) => {
            if (!ok && sessionRef.current === voice) voice.setNote('not_sent');
          });
        },
      });
    }
    return sessionRef.current;
  }, [deps, mock]);

  const voice = getSession();
  const current = state ?? voice.state;

  // Unmount (route change) releases everything.
  useEffect(() => {
    const session = getSession();
    session.checkSupport();
    // After a Strict Mode remount the session is a new object: render it.
    setState(session.state);
    const onPageHide = () => session.stop();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      session.dispose();
      sessionRef.current = null;
    };
  }, [getSession]);

  // A business switch or a new session ("Start over") stops voice.
  const scopeKey = `${businessId ?? ''}|${thread.sessionId ?? ''}`;
  const lastScope = useRef(scopeKey);
  useEffect(() => {
    if (lastScope.current !== scopeKey) {
      lastScope.current = scopeKey;
      sessionRef.current?.stop();
    }
  }, [scopeKey]);

  // Read each new builder reply aloud while connected.
  const isConnected = current.phase === 'listening' || current.phase === 'speaking';
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!isConnected) {
      known.current = null;
      return;
    }
    const ids = thread.messages.map((m) => m.id);
    if (!known.current) {
      known.current = new Set(ids);
      return;
    }
    const seen = known.current;
    const fresh = thread.messages.filter((m) => !seen.has(m.id));
    fresh.forEach((m) => seen.add(m.id));
    const reply = [...fresh].reverse().find((m) => m.role === 'assistant');
    if (reply) sessionRef.current?.speak(reply.text);
  }, [isConnected, thread.messages]);

  // Re-render when a rate limit runs out, so the button enables again.
  const [, setTick] = useState(0);
  useEffect(() => {
    // retryAt is on the session's clock (deps.now), not necessarily Date.now.
    const wait = sessionRef.current?.retryInMs() ?? null;
    if (wait === null || wait <= 0) return;
    const handle = window.setTimeout(() => setTick((n) => n + 1), wait + 50);
    return () => window.clearTimeout(handle);
  }, [current.retryAt]);

  const retryInMs = voice.retryInMs();
  const retryInSeconds = retryInMs === null ? null : Math.ceil(retryInMs / 1000);

  const displayPhase: VoiceDisplayPhase = isConnected && thread.isSending ? 'sending' : current.phase;

  return {
    state: current,
    phase: displayPhase,
    /** Seconds until voice may start again after a rate limit, or null. */
    retryInSeconds,
    canStart: voice.canStart() && !!businessId && !!thread.sessionId,
    isActive: voice.isActive,
    start: useCallback(() => void sessionRef.current?.start(), []),
    stop: useCallback(() => sessionRef.current?.stop(), []),
    setMuted: useCallback((muted: boolean) => sessionRef.current?.setMuted(muted), []),
  };
}

export type VoiceSessionView = ReturnType<typeof useVoiceSession>;
